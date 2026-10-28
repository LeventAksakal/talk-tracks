# pyright: reportMissingImports=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportAttributeAccessIssue=false, reportPrivateUsage=false
"""The MoQ side of an agent: one relay connection, the tracks it reads and the track it publishes.

aiomoqt (IETF draft-18) has no Windows wheels, so this module runs in the agents' Docker image only; everything it
feeds (cores, runtime, follow) is transport-free and tested without a relay. Behaviour measured before the build
and handled here:

* a subscription can die silently when its publisher's session ends: resubscribe when the reader is done or, for
  tracks that never pause, after a few idle seconds;
* ``Reader.read(n, timeout)`` waits for all n objects, so read one with a short deadline, then drain;
* an empty payload must never reach the Opus decoder;
* aiomoqt does not reconnect: when the relay session closes the agent exits and Docker starts a fresh instance;
* the writer queues objects while nobody subscribes, so its queue is small and drops the oldest snapshot;
* the relay subscribes upstream while anyone subscribes and cancels within ms of the last leave, which the writer
  sees as ``producing`` (wiki/howto/lazy-agents.md); ``close_reader`` alone does not unsubscribe on the wire.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import types
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import quote, urlsplit

import numpy as np
from aiomoqt.agent import AgentSession, PublishSpec, StartAt, SubscribeSpec, TrackRef
from aiomoqt.client import MOQTClient
from aiomoqt.messages.data import FetchObject
from aiomoqt.messages.fetch import _is_joining
from aiomoqt.utils.logger import set_log_level
from aiopquic.quic.configuration import QuicConfiguration
from numpy.typing import NDArray
from pydantic import ValidationError

from .archive.slices import NORMAL, Slice
from .audio import AudioAssembler
from .contracts import (
    ENVELOPE,
    ITEMS_TRACK,
    ROOT,
    Envelope,
    SlideFrame,
    Wire,
    agent_path,
    slides_path,
    teacher_path,
)
from .demand import Fetches
from .live_slices import Refused

log = logging.getLogger("talk_tracks.moq")
set_log_level(logging.WARNING)  # aiomoqt logs every control message at INFO

DRAFT = 18  # pinned: aiomoqt offers draft 22 first when left to choose, and everything here is measured on 18
RETRY_S = 1.0
AUDIO_IDLE_S = 5.0  # the speaker's audio never pauses for this long while the publisher is alive
AUDIO_TRACK = "audio"
CLOCK_TRACK = "clock"  # void (design §4.5 now reads the hang catalog clock); replaced with the room catalog read
CLOCK_WAIT_S = 10.0  # the console repeats its clock every 4 s: this long without one means the broadcast has none
READ_DEADLINE_S = 0.05
# QUIC timers we advertise (design, spike S8): a killed agent's track is free for its replacement after 1-3.5 s, not
# the 12.4 s the relay's default idle timeout leaves it stalled; the keep-alive holds a quiet session open.
QUIC_IDLE_S = 3.0
QUIC_KEEP_ALIVE_S = 1.0
WRITE_TIMEOUT_S = 5.0
WRITER_QUEUE = 4  # snapshots are self-contained: an unsent old one is worth nothing
SLICED_QUEUE = 256  # objects of a sliced track; each one counts, and a FETCH serves what the queue dropped
FETCH_TIMEOUT_S = 8.0  # a forwarded FETCH may back-fill a slice upstream: 1-3 s of model calls, maybe chained
FETCH_NOT_FOUND = 0x10  # moq-relay passes it on as 'not found'


def relay_client(url: str, *, token: str | None = None, insecure: bool = False) -> Any:
    """``moqt://host:port`` (raw QUIC) or ``https://host:port/path`` (WebTransport); a token goes in ``?jwt=``."""
    u = urlsplit(url)
    if u.scheme not in ("moqt", "https") or not u.hostname:
        raise ValueError(f"relay URL must be moqt://host:port or https://host:port/path, got {url!r}")
    path = (u.path or "/") + (f"?jwt={quote(token, safe='')}" if token else "")
    # aiomoqt's own defaults, plus our timers; it fills in the ALPN, server name and TLS settings.
    cfg = QuicConfiguration(is_client=True, max_data=2**24, max_stream_data=2**24, max_datagram_frame_size=64 * 1024)
    cfg.idle_timeout = QUIC_IDLE_S
    cfg.keep_alive_interval = QUIC_KEEP_ALIVE_S
    return MOQTClient(
        u.hostname,
        u.port or 443,
        path=path if (u.path or token) else None,
        use_quic=u.scheme == "moqt",
        verify_tls=not insecure,
        supported_drafts=DRAFT,
        configuration=cfg,
        keep_alive_interval=QUIC_KEEP_ALIVE_S,
    )


class TrackWriter:
    """Publishes each object as a group of its own (the ``ObjectSink`` of ``SnapshotPublisher``)."""

    def __init__(self, writer: Any) -> None:
        self._writer = writer

    def subscribed(self) -> bool:
        """Whether the relay holds a subscription to this track: some viewer or downstream agent reads it."""
        return bool(self._writer._track.producing)

    async def write(self, data: bytes) -> None:
        await asyncio.wait_for(self._writer.snapshot(data), WRITE_TIMEOUT_S)

    async def append(self, data: bytes) -> None:
        """Add an object to the current group (a video frame after its GOP's keyframe)."""
        await asyncio.wait_for(self._writer.write(data), WRITE_TIMEOUT_S)


_END_GROUP = object()  # queued after a group's last object: close its stream with End of Group now, not later

SliceSource = Callable[[int], Awaitable[Slice]]  # group k for a FETCH; raises live_slices.Refused


class SlicedOut:
    """A sliced track's live side (``live_slices.LiveOut``): the caller numbers groups and objects, closes each group
    explicitly, and answers FETCH from the track's archive (``serve``) instead of aiomoqt's in-memory history.

    aiomoqt's push writer starts a group per ``snapshot`` and numbers objects itself; we set its group counter so its
    numbering is ours, and replace its ``produce`` loop to send End of Group when a slice ends rather than when the
    next one starts, which may be minutes later.
    """

    def __init__(self, writer: Any) -> None:
        self._writer = writer
        track = writer._track
        track.produce = types.MethodType(_produce_with_group_ends, track)

    def subscribed(self) -> bool:
        return bool(self._writer._track.producing)

    async def put(self, group: int, object_id: int, payload: bytes) -> None:
        w = self._writer
        if object_id == 0:
            w._group = group - 1  # snapshot() starts group + 1 - 1 = group, object 0
            await asyncio.wait_for(w.snapshot(payload), WRITE_TIMEOUT_S)
        else:
            await asyncio.wait_for(w.write(payload), WRITE_TIMEOUT_S)

    async def end_group(self, group: int) -> None:
        w = self._writer
        w.end_group()
        with contextlib.suppress(asyncio.QueueFull):
            w._queue.put_nowait((group, -1, _END_GROUP, False))

    async def end_track(self) -> None:
        """The talk is over: open streams close and each subscription gets PUBLISH_DONE, Track Ended."""
        self._writer._track.end()

    def serve(self, source: SliceSource, fetches: Fetches | None = None) -> None:
        """Answer each standalone FETCH of this track from ``source``, with the true End Location (moq-relay asks
        for a whole group and rejects aiomoqt's own reply, spike S4b): the open slice too, as far as it has got.
        A refusal is a REQUEST_ERROR, never an empty group. Joining FETCHes keep aiomoqt's handling. ``fetches``
        counts them for the demand rule: the relay's upstream subscription for a FETCH is not a viewer."""
        track = self._writer._track
        stock = track._on_fetch
        counted = fetches or Fetches()

        async def on_fetch(session: Any, msg: Any) -> None:
            counted.begin()
            try:
                await answer(session, msg)
            finally:
                counted.end()

        async def answer(session: Any, msg: Any) -> None:
            if _is_joining(msg.fetch_type):
                await stock(session, msg)
                return
            rid, k = msg.request_id, msg.start_group or 0
            try:
                found = await source(k)
                objects = [o for o in found.objects if o.status == NORMAL]
                if not objects:
                    raise Refused("no objects")
            except Refused as exc:
                log.info("FETCH %s group %d refused: %s", track.trackname, k, exc)
                session.fetch_error(request_id=rid, error_code=FETCH_NOT_FOUND, reason=str(exc)[:100])
                return
            except Exception as exc:
                log.warning("FETCH of %s group %d failed: %s", track.trackname, k, exc)
                session.fetch_error(request_id=rid, error_code=FETCH_NOT_FOUND, reason="failed")
                return
            last = objects[-1].object_id
            session.fetch_ok(
                request_id=rid,
                end_of_track=int(found.end_of_track),
                largest_group_id=k,
                largest_object_id=last + 1,  # End Location: one past the last object served
            )
            served = [FetchObject(group_id=k, object_id=o.object_id, payload=o.payload) for o in objects]
            await session.serve_fetch(rid, served)
            log.info("FETCH %s group %d: served %d objects", track.trackname, k, len(served))

        track._on_fetch = on_fetch


async def _produce_with_group_ends(self: Any, out: Any) -> None:
    """aiomoqt ``_PushTrack.produce``, plus the End of Group marker ``SlicedOut.end_group`` queues."""
    while not (self._stopping and self._queue.empty()):
        item = await self._queue.get()
        try:
            if item is None:
                return
            group_id, object_id, payload, group_start = item
            if payload is _END_GROUP:
                out.end_group()
            else:
                await out.write(group_id, object_id, payload, group_start=group_start)
        finally:
            self._queue.task_done()


class Relay:
    def __init__(self, session: Any) -> None:
        self.session = session
        self.agent = AgentSession(session)

    @property
    def closed(self) -> asyncio.Future[Any]:
        return self.session._moqt_session_closed

    async def publish(self, namespace: str, track: str, *, queue: int = WRITER_QUEUE) -> TrackWriter:
        """``queue`` bounds the objects held while nobody subscribes; the oldest group goes first."""
        spec = PublishSpec(track=TrackRef(namespace=namespace, name=track), buffer=queue, on_full="drop_oldest")
        writer = self.agent.writer(spec)
        await writer.start()
        log.info("publishing %s/%s", namespace, track)
        return TrackWriter(writer)

    async def publish_sliced(self, namespace: str, track: str) -> SlicedOut:
        """A sliced or snapshot agent track. Its queue holds a few slices while the relay's subscription catches up."""
        spec = PublishSpec(track=TrackRef(namespace=namespace, name=track), buffer=SLICED_QUEUE, on_full="drop_oldest")
        writer = self.agent.writer(spec)
        out = SlicedOut(writer)
        await writer.start()
        log.info("publishing %s/%s", namespace, track)
        return out

    async def objects(self, namespace: str, track: str, *, idle_s: float | None = None) -> AsyncIterator[bytes]:
        """Every non-empty payload of a track, from the latest group on, resubscribing for as long as it is read.

        ``idle_s`` resubscribes after that long without an object; leave it None for tracks that may pause.
        """
        async with contextlib.aclosing(self.subscriptions(namespace, track, idle_s=idle_s)) as payloads:
            async for _, payload in payloads:
                yield payload

    async def subscriptions(
        self, namespace: str, track: str, *, idle_s: float | None = None
    ) -> AsyncGenerator[tuple[int, bytes]]:
        """``objects``, each payload with the number of the subscription it came on: the number rises each time the
        track is subscribed afresh, as it is when its publisher goes and a new one (a new broadcast) comes."""
        ref = TrackRef(namespace=namespace, name=track)
        number = 0
        while True:
            try:
                reader = await self.agent.reader(SubscribeSpec(track=ref, start_at=StartAt(mode="latest"), buffer=4096))
            except Exception as exc:  # not announced yet, or refused: try again shortly
                log.debug("subscribe %s/%s failed: %s", namespace, track, exc)
                await asyncio.sleep(RETRY_S)
                continue
            log.info("subscribed %s/%s", namespace, track)
            number += 1
            last = time.monotonic()
            try:
                while not reader.done:
                    batch = await reader.read(1, timeout=READ_DEADLINE_S)
                    batch += reader.drain()
                    if batch:
                        last = time.monotonic()
                    elif idle_s is not None and time.monotonic() - last > idle_s:
                        log.info("no objects on %s/%s for %.0f s: resubscribing", namespace, track, idle_s)
                        break
                    for obj in batch:
                        if obj.payload:
                            yield number, obj.payload
            finally:
                self._unsubscribe(reader, str(ref))
            await asyncio.sleep(RETRY_S)

    def _unsubscribe(self, reader: Any, name: str) -> None:
        """Cancel on the wire too, so the relay stops forwarding and can release its upstream subscription."""
        if reader.request_id is not None and not reader.done:
            with contextlib.suppress(Exception):
                self.session.unsubscribe(reader.request_id)
        self.agent.close_reader(name)

    async def announced(self, prefix: str) -> AsyncIterator[tuple[str, bool]]:
        """(path below ``prefix``, active) for each namespace announced or withdrawn under ``prefix``.

        One per connection: aiomoqt delivers every namespace message of a session through one queue.
        """
        reply = await self.session.subscribe_namespace(prefix, subscribe_options=1, wait_response=True)
        try:
            while True:
                try:
                    msg = await self.session.await_namespace(timeout=1.0)
                except TimeoutError:
                    continue
                parts = msg.namespace_suffix or ()
                suffix = "/".join(p.decode() if isinstance(p, bytes) else str(p) for p in parts)
                yield suffix, "Done" not in type(msg).__name__
        finally:
            with contextlib.suppress(Exception):
                self.session.unsubscribe_namespace(prefix, request_id=getattr(reply, "request_id", None))


@asynccontextmanager
async def connect(url: str, *, token: str | None = None, insecure: bool = False) -> AsyncGenerator[Relay]:
    async with relay_client(url, token=token, insecure=insecure).connect() as session:
        await session.client_session_init()
        if (draft := getattr(session, "negotiated_draft", None)) != DRAFT:
            raise ConnectionError(f"the relay negotiated MoQT draft {draft}, not {DRAFT}")
        relay = Relay(session)
        log.info("connected to %s (draft %d)", urlsplit(url).hostname, DRAFT)
        try:
            yield relay
        finally:
            # A clean close withdraws our namespaces at once; a killed process lingers on the relay for ~13 s.
            with contextlib.suppress(Exception):
                await asyncio.wait_for(relay.agent.close(), 3)


async def until_closed(relay: Relay, work: Awaitable[None]) -> None:
    """Run ``work``; if the relay session closes first, stop it and raise so the process exits and restarts."""
    task = asyncio.ensure_future(work)
    try:
        await asyncio.wait({task, relay.closed}, return_when=asyncio.FIRST_COMPLETED)
    finally:  # cancelled too (SIGTERM, the talk is over): stop the work before the caller closes its track
        if not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
    if not task.cancelled():
        return task.result()
    raise ConnectionError(f"relay session closed: {relay.closed.result()}")


# --- what the agents read -------------------------------------------------------------------------------------


async def teacher_audio(relay: Relay, room: str) -> AsyncGenerator[tuple[NDArray[np.int16], int]]:
    """The speaker's microphone as 16 kHz mono PCM chunks with their end in room time, ms (design §4.5).

    Each subscription to the audio is one teacher broadcast (a new one, after a reload, comes on a new subscription).
    Before stamping its first chunk this reads that broadcast's room clock: room time is the speaker's media
    timestamp plus its ``offset_ms``, or the media timestamp itself when the broadcast has no clock (the looper). The
    audio that arrives meanwhile waits in the subscription's buffer.
    """
    assembler, offset, current = AudioAssembler(), 0, 0
    path = teacher_path(room)
    async with contextlib.aclosing(relay.subscriptions(path, AUDIO_TRACK, idle_s=AUDIO_IDLE_S)) as audio:
        async for number, payload in audio:
            if number != current:
                for pcm, end_ms in assembler.flush():  # the previous broadcast's last frames, on its own clock
                    yield pcm, end_ms + offset
                clock = await room_clock(relay, room)
                offset = 0 if clock is None else clock.offset_ms
                what = "no room clock" if clock is None else f"broadcast {clock.session}"
                log.info("%s: %s, room time = media time %+d ms", path, what, offset)
                assembler, current = AudioAssembler(), number
            for pcm, end_ms in assembler.push(payload):
                yield pcm, end_ms + offset


class RoomClock(Wire):
    epoch_ms: int
    offset_ms: int
    session: str


async def room_clock(relay: Relay, room: str, *, wait_s: float = CLOCK_WAIT_S) -> RoomClock | None:
    """The newest object of the room's ``clock`` track (design §4.5), read afresh; None when the speaker's broadcast
    has none: the subscription is refused, or nothing comes within ``wait_s`` although the console repeats it every
    4 s."""
    ref = TrackRef(namespace=slides_path(room), name=CLOCK_TRACK)
    try:
        reader = await relay.agent.reader(SubscribeSpec(track=ref, start_at=StartAt(mode="latest"), buffer=16))
    except Exception as exc:
        log.info("%s: no clock track (%s)", ref.namespace, exc)
        return None
    try:
        t_end = time.monotonic() + wait_s
        while not reader.done and time.monotonic() < t_end:
            for obj in await reader.read(1, timeout=READ_DEADLINE_S) + reader.drain():
                if not obj.payload:
                    continue
                try:
                    return RoomClock.model_validate_json(obj.payload)
                except ValidationError:
                    log.warning("skipping a room clock object that does not match the contract")
    finally:
        relay._unsubscribe(reader, str(ref))
    log.warning("%s: no room clock object in %.0f s: taking media time as room time", ref.namespace, wait_s)
    return None


async def rooms_on_air(relay: Relay) -> AsyncIterator[tuple[str, bool]]:
    """(room, on air) each time a speaker's broadcast (``talk/<room>/teacher``) is announced or withdrawn."""
    async for suffix, active in relay.announced(ROOT):
        parts = suffix.split("/")
        if len(parts) == 2 and parts[1] == "teacher":
            yield parts[0], active


async def slide_frames(relay: Relay, room: str) -> AsyncGenerator[SlideFrame]:
    async for payload in relay.objects(slides_path(room), "frames"):
        try:
            yield SlideFrame.model_validate_json(payload)
        except ValidationError:
            log.warning("skipping a slide frame that does not match the contract")


async def follow_agent(relay: Relay, room: str, agent: str, track: str = ITEMS_TRACK) -> AsyncGenerator[Envelope]:
    """Each object of another agent's track. The name is stable: when the agent restarts, the subscription ends and
    the next one reaches its replacement. Subscribing is demand: it keeps that agent working for us."""
    async for payload in relay.objects(agent_path(room, agent), track):
        try:
            yield ENVELOPE.validate_json(payload)
        except ValidationError:
            log.warning("skipping an object from %s that does not match the contract", agent)
