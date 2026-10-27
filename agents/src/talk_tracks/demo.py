"""Demo rooms over MoQ: play a lecture into a room, record a room's agent tracks, loop a recording as a live room.

Runs in the agents' Docker image (aiomoqt). The schedule, the recording format and the lecture mapping are in the
transport-free modules ``replay``, ``recording`` and ``lecture``.

* ``play``: the lecture on ``talk/<room>/teacher`` (catalog, video, audio), once or looping, nothing else.
* ``record``: every agent's newest instance under ``talk/<room>/agents/``, stamped with the teacher's media time.
* ``generate``: ``record`` and ``play`` once together, for agents already running in a private room.
* ``loop``: the lecture and the recorded agent tracks together, forever, as if live.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import shutil
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AsyncExitStack
from pathlib import Path

from .contracts import Envelope, Usage, agent_path, agents_prefix, teacher_path
from .follow import RoomFollower
from .lecture import (
    AUDIO_TRACK,
    CATALOG_TRACK,
    VIDEO_TRACK,
    LectureInfo,
    MediaPacket,
    catalog,
    legacy_frame,
    packets,
    probe,
)
from .moq import AUDIO_IDLE_S, Relay, TrackWriter, connect, until_closed
from .publisher import SnapshotPublisher
from .recording import RecordingWriter, load_manifest
from .replay import Cue, LoopPlan, MediaClock, Timeline, event_us, loop_events, next_instance
from .runtime import HEARTBEAT_S, now_ms

log = logging.getLogger("talk_tracks.demo")

LECTURE_FILE = "lecture.mp4"
VIDEO_QUEUE = 64  # about one GOP: what a first subscriber gets first is at most ~2.5 s old
AUDIO_QUEUE = 50  # 1 s of Opus
CATALOG_QUEUE = 2

Connect = Callable[[], contextlib.AbstractAsyncContextManager[Relay]]


class Teacher:
    """The lecture's three tracks on ``talk/<room>/teacher``, written at real time on the room's media clock."""

    def __init__(self, relay: Relay, room: str, info: LectureInfo) -> None:
        self._relay, self._room, self.info = relay, room, info
        self._catalog: TrackWriter | None = None
        self._video: TrackWriter | None = None
        self._audio: TrackWriter | None = None
        self._extra: dict[str, object] = {}
        self._gop_open = False

    async def start(self) -> None:
        ns = teacher_path(self._room)
        self._catalog = await self._relay.publish(ns, CATALOG_TRACK, queue=CATALOG_QUEUE)
        if self.info.video is not None:
            self._video = await self._relay.publish(ns, VIDEO_TRACK, queue=VIDEO_QUEUE)
        if self.info.audio is not None:
            self._audio = await self._relay.publish(ns, AUDIO_TRACK, queue=AUDIO_QUEUE)
        await self.publish_catalog()

    async def publish_catalog(self, extra: dict[str, object] | None = None) -> None:
        """The catalog, one group per update. Repeated as a heartbeat: a subscriber that arrives while nothing new is
        written still gets it within seconds."""
        if extra is not None:
            self._extra = extra
        assert self._catalog is not None
        await self._catalog.write(json.dumps(catalog(self.info, self._extra), separators=(",", ":")).encode())

    async def send(self, packet: MediaPacket, plan: LoopPlan) -> None:
        frame = legacy_frame(plan.media_us(packet.file_us), packet.data)
        if packet.kind == "audio":
            if self._audio is not None:
                await self._audio.write(frame)  # one Opus packet per group, like the speaker's browser
        elif self._video is not None:
            if packet.keyframe:
                await self._video.write(frame)  # a keyframe opens the GOP's group
                self._gop_open = True
            elif self._gop_open:
                await self._video.append(frame)


class AgentTracks:
    """One loop's agent instances, on a connection of their own: closing it withdraws them all at once."""

    def __init__(self, relay: Relay, room: str, previous: str | None) -> None:
        self._relay, self._room = relay, room
        self.instance = next_instance(previous, now_ms())
        self._publishers: dict[str, SnapshotPublisher] = {}
        self._usage: dict[str, Usage] = {}

    async def play(self, cue: Cue) -> None:
        name = cue.agent.info.name
        self._usage[name] = cue.snapshot.usage
        pub = self._publishers.get(name)
        if pub is None:
            sink = await self._relay.publish(agent_path(self._room, name, self.instance), "state")
            pub = SnapshotPublisher(cue.agent.info, sink, lambda: self._usage[name], instance=self.instance)
            self._publishers[name] = pub
        await pub.publish(cue.snapshot.state)

    async def heartbeat(self) -> None:
        for pub in list(self._publishers.values()):
            await pub.heartbeat()


async def _at(start: float, offset_s: float) -> None:
    await asyncio.sleep(max(0.0, start + offset_s - time.monotonic()))


async def _every(seconds: float, beat: Callable[[], Awaitable[None]]) -> None:
    while True:
        await asyncio.sleep(seconds)
        try:
            await beat()
        except TimeoutError:
            log.warning("heartbeat write timed out")


async def run_lecture(
    teacher: Teacher,
    *,
    loops: int | None,
    timeline: Timeline | None = None,
    connect_agents: Connect | None = None,
    room: str = "",
    lecture: Path,
) -> None:
    """Play the lecture ``loops`` times (None: forever), with the timeline's agent tracks when there is one."""
    duration_ms = teacher.info.duration_ms
    beats = [asyncio.create_task(_every(HEARTBEAT_S, teacher.publish_catalog))]
    stacks: list[AsyncExitStack] = []
    closing: set[asyncio.Task[None]] = set()
    previous: str | None = None
    origin = time.monotonic()  # loop k starts at origin + k * duration: no drift over days of looping
    try:
        index = 0
        while loops is None or index < loops:
            plan = timeline.plan(index) if timeline else LoopPlan(index, duration_ms, 1)
            await teacher.publish_catalog(
                {"talk_tracks": {"loop": index, "loop_start_ms": plan.media_offset_ms, "duration_ms": duration_ms}}
            )
            tracks: AgentTracks | None = None
            if timeline is not None and connect_agents is not None:
                stack = AsyncExitStack()
                relay = await stack.enter_async_context(connect_agents())
                tracks = AgentTracks(relay, room, previous)
                previous = tracks.instance
                beat = asyncio.create_task(_every(HEARTBEAT_S, tracks.heartbeat))
                stack.callback(beat.cancel)
                stacks.append(stack)
                log.info("loop %d: agent instance %s, media from %d ms", index, tracks.instance, plan.media_offset_ms)
            else:
                log.info("loop %d: media from %d ms", index, plan.media_offset_ms)
            cues = timeline.cues(plan) if timeline else iter(())
            start = origin + index * duration_ms / 1000
            first = True
            for event in loop_events(packets(lecture), cues):
                await _at(start, event_us(event) / 1e6)
                try:
                    if isinstance(event, MediaPacket):
                        await teacher.send(event, plan)
                    elif tracks is not None:
                        await tracks.play(event)
                except TimeoutError:
                    log.warning("write timed out at %d ms", event_us(event) // 1000)
                if first and len(stacks) > 1:
                    # The new loop's instances are out: withdraw the previous loop's, without holding up the media.
                    task = asyncio.create_task(stacks.pop(0).aclose())
                    closing.add(task)
                    task.add_done_callback(closing.discard)
                first = False
            await _at(start, duration_ms / 1000)
            index += 1
    finally:
        for task in beats:
            task.cancel()
        for task in list(closing):
            with contextlib.suppress(Exception):
                await task
        for stack in stacks:
            with contextlib.suppress(Exception):
                await stack.aclose()


# --- recording --------------------------------------------------------------------------------------------------


async def follow_room(relay: Relay, room: str) -> AsyncIterator[Envelope]:
    """Each new snapshot of every agent in the room, from each agent's newest instance."""
    prefix = agents_prefix(room)
    follower = RoomFollower()
    inbox: asyncio.Queue[tuple[str, bytes]] = asyncio.Queue(maxsize=256)
    readers: dict[str, asyncio.Task[None]] = {}

    async def read(agent: str, instance: str) -> None:
        async for payload in relay.objects(f"{prefix}/{agent}/{instance}", "state"):
            await inbox.put((agent, payload))

    async def watch() -> None:
        async for path, active in relay.announced(prefix):
            found = follower.offer(path) if active else None
            if found is not None:
                agent, instance = found
                log.info("recording %s instance %s", agent, instance)
                if agent in readers:
                    readers[agent].cancel()
                readers[agent] = asyncio.create_task(read(agent, instance))

    watcher = asyncio.create_task(watch())
    try:
        while True:
            get = asyncio.ensure_future(inbox.get())
            await asyncio.wait({get, watcher}, return_when=asyncio.FIRST_COMPLETED)
            if not get.done():
                get.cancel()
                watcher.result()
                raise ConnectionError(f"stopped watching {prefix}")
            agent, payload = get.result()
            try:
                envelope = follower.accept(agent, payload)
            except ValueError:
                log.warning("skipping an object from %s that does not match the contract", agent)
                continue
            if envelope is not None:
                yield envelope
    finally:
        watcher.cancel()
        for task in readers.values():
            task.cancel()


async def teacher_clock(relay: Relay, room: str, clock: MediaClock, seen: Callable[[int], None]) -> None:
    async for payload in relay.objects(teacher_path(room), AUDIO_TRACK, idle_s=AUDIO_IDLE_S):
        if clock.observe(payload) is not None:
            seen(clock.ms)


async def record_room(relay: Relay, room: str, rec: RecordingWriter) -> None:
    """Record until cancelled. Media time comes from the teacher's audio, see ``recording``."""
    clock = MediaClock()
    audio = asyncio.create_task(teacher_clock(relay, room, clock, rec.media_seen))
    try:
        async for envelope in follow_room(relay, room):
            snapshot = rec.add(envelope, media_ms=clock.ms, wall_ms=now_ms())
            log.info("%s seq %d at media %.1f s", envelope.agent.name, envelope.seq, snapshot.media_ms / 1000)
    finally:
        audio.cancel()


# --- commands ---------------------------------------------------------------------------------------------------


def _connector(url: str, token: str | None, insecure: bool) -> Connect:
    return lambda: connect(url, token=token, insecure=insecure)


async def play(url: str, room: str, media: Path, *, loops: int | None, token: str | None, insecure: bool) -> None:
    info = probe(media)
    log.info("lecture %s: %.1f s", media.name, info.duration_ms / 1000)
    async with connect(url, token=token, insecure=insecure) as relay:
        teacher = Teacher(relay, room, info)
        await teacher.start()
        await until_closed(relay, run_lecture(teacher, loops=loops, lecture=media))


async def loop(url: str, room: str, recording: Path, *, media: Path | None, token: str | None, insecure: bool) -> None:
    manifest = load_manifest(recording)
    lecture = media or (recording / (manifest.media or LECTURE_FILE))
    info = probe(lecture)
    timeline = Timeline(recording, manifest, info.duration_ms)
    log.info(
        "looping %s (%.1f s) with %s in room %s",
        lecture.name,
        info.duration_ms / 1000,
        ", ".join(a.info.name for a in manifest.agents) or "no agent tracks",
        room,
    )
    async with connect(url, token=token, insecure=insecure) as relay:
        teacher = Teacher(relay, room, info)
        await teacher.start()
        work = run_lecture(
            teacher,
            loops=None,
            timeline=timeline,
            connect_agents=_connector(url, token, insecure),
            room=room,
            lecture=lecture,
        )
        await until_closed(relay, work)


async def record(url: str, room: str, out: Path, *, media: str | None, token: str | None, insecure: bool) -> None:
    rec = RecordingWriter(out, room, wall_ms=now_ms(), media=media)
    try:
        async with connect(url, token=token, insecure=insecure) as relay:
            await until_closed(relay, record_room(relay, room, rec))
    finally:
        manifest = rec.close(wall_ms=now_ms())
        log.info("recording in %s: %s", out, ", ".join(f"{a.info.name} {a.snapshots}" for a in manifest.agents))


def copy_lecture(media: Path, out: Path) -> Path:
    """The recording keeps its own copy of the lecture, so the directory is everything a looping room needs."""
    out.mkdir(parents=True, exist_ok=True)
    lecture = out / LECTURE_FILE
    if media.resolve() != lecture.resolve():
        shutil.copyfile(media, lecture)
    return lecture


async def generate(
    url: str, room: str, media: Path, out: Path, *, lead_in_s: float, tail_s: float, token: str | None, insecure: bool
) -> None:
    """Play the lecture once into ``room`` (where agents run) while recording their tracks into ``out``."""
    lecture = copy_lecture(media, out)
    info = probe(lecture)
    rec = RecordingWriter(out, room, wall_ms=now_ms(), media=LECTURE_FILE)
    try:
        async with (
            connect(url, token=token, insecure=insecure) as recorder,
            connect(url, insecure=insecure, token=token) as speaker,
        ):
            recording = asyncio.create_task(record_room(recorder, room, rec))
            teacher = Teacher(speaker, room, info)
            await teacher.start()
            log.info("lead-in %.0f s: the agents find the teacher broadcast", lead_in_s)
            await asyncio.sleep(lead_in_s)
            log.info("playing %s (%.1f s) into room %s", lecture.name, info.duration_ms / 1000, room)
            await until_closed(speaker, run_lecture(teacher, loops=1, lecture=lecture))
            log.info("lecture over; recording the agents' last words for %.0f s", tail_s)
            await asyncio.sleep(tail_s)
            recording.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await recording
    finally:
        manifest = rec.close(wall_ms=now_ms())
        log.info("recording in %s: %s", out, ", ".join(f"{a.info.name} {a.snapshots}" for a in manifest.agents))
