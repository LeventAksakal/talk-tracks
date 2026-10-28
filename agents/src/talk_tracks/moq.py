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
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import quote, urlsplit

import numpy as np
from aiomoqt.agent import AgentSession, PublishSpec, StartAt, SubscribeSpec, TrackRef
from aiomoqt.client import MOQTClient
from aiomoqt.utils.logger import set_log_level
from numpy.typing import NDArray
from pydantic import ValidationError

from .audio import AudioAssembler
from .contracts import ROOT, Envelope, SlideFrame, agents_prefix, slides_path, teacher_path
from .follow import NewestInstance, SnapshotFilter

log = logging.getLogger("talk_tracks.moq")
set_log_level(logging.WARNING)  # aiomoqt logs every control message at INFO

DRAFT = 18  # pinned: aiomoqt offers draft 22 first when left to choose, and everything here is measured on 18
RETRY_S = 1.0
AUDIO_IDLE_S = 5.0  # the speaker's audio never pauses for this long while the publisher is alive
READ_DEADLINE_S = 0.05
WRITE_TIMEOUT_S = 5.0
WRITER_QUEUE = 4  # snapshots are self-contained: an unsent old one is worth nothing


def relay_client(url: str, *, token: str | None = None, insecure: bool = False) -> Any:
    """``moqt://host:port`` (raw QUIC) or ``https://host:port/path`` (WebTransport); a token goes in ``?jwt=``."""
    u = urlsplit(url)
    if u.scheme not in ("moqt", "https") or not u.hostname:
        raise ValueError(f"relay URL must be moqt://host:port or https://host:port/path, got {url!r}")
    path = (u.path or "/") + (f"?jwt={quote(token, safe='')}" if token else "")
    return MOQTClient(
        u.hostname,
        u.port or 443,
        path=path if (u.path or token) else None,
        use_quic=u.scheme == "moqt",
        verify_tls=not insecure,
        supported_drafts=DRAFT,
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

    async def objects(self, namespace: str, track: str, *, idle_s: float | None = None) -> AsyncIterator[bytes]:
        """Every non-empty payload of a track, from the latest group on, resubscribing for as long as it is read.

        ``idle_s`` resubscribes after that long without an object; leave it None for tracks that may pause.
        """
        ref = TrackRef(namespace=namespace, name=track)
        while True:
            try:
                reader = await self.agent.reader(SubscribeSpec(track=ref, start_at=StartAt(mode="latest"), buffer=4096))
            except Exception as exc:  # not announced yet, or refused: try again shortly
                log.debug("subscribe %s/%s failed: %s", namespace, track, exc)
                await asyncio.sleep(RETRY_S)
                continue
            log.info("subscribed %s/%s", namespace, track)
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
                            yield obj.payload
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
    await asyncio.wait({task, relay.closed}, return_when=asyncio.FIRST_COMPLETED)
    if task.done():
        return task.result()
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    raise ConnectionError(f"relay session closed: {relay.closed.result()}")


# --- what the agents read -------------------------------------------------------------------------------------


async def teacher_audio(relay: Relay, room: str) -> AsyncGenerator[tuple[NDArray[np.int16], int]]:
    """The speaker's microphone as 16 kHz mono PCM chunks with their media end time in ms."""
    assembler = AudioAssembler()
    async for payload in relay.objects(teacher_path(room), "audio", idle_s=AUDIO_IDLE_S):
        for chunk in assembler.push(payload):
            yield chunk


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


async def follow_agent(relay: Relay, room: str, agent: str) -> AsyncIterator[Envelope]:
    """Each new snapshot of another agent, always from its newest instance (a replacement takes over by itself)."""
    prefix = f"{agents_prefix(room)}/{agent}"
    newest, snapshots = NewestInstance(), SnapshotFilter()
    inbox: asyncio.Queue[bytes] = asyncio.Queue(maxsize=64)
    readers: dict[str, asyncio.Task[None]] = {}

    async def read(instance: str) -> None:
        async for payload in relay.objects(f"{prefix}/{instance}", "state"):
            await inbox.put(payload)

    async def watch() -> None:
        async for suffix, active in relay.announced(prefix):
            instance = suffix.split("/")[0]
            if active and newest.offer(instance):
                log.info("following %s instance %s", agent, instance)
                for task in readers.values():
                    task.cancel()
                readers.clear()
                readers[instance] = asyncio.create_task(read(instance))

    watcher = asyncio.create_task(watch())
    try:
        while True:
            get = asyncio.ensure_future(inbox.get())
            await asyncio.wait({get, watcher}, return_when=asyncio.FIRST_COMPLETED)
            if not get.done():
                get.cancel()
                watcher.result()  # re-raises whatever stopped the watcher
                raise ConnectionError(f"stopped watching {prefix}")
            try:
                envelope = snapshots.accept(get.result(), newest.current)
            except ValidationError:
                log.warning("skipping an object from %s that does not match the contract", agent)
                continue
            if envelope is not None:
                yield envelope
    finally:
        watcher.cancel()
        for task in readers.values():
            task.cancel()
