"""Demo rooms over MoQ: play a lecture into a room, record a room's agent tracks, run a demo lecture's live sessions
and serve its recording room (decision 0032).

Runs in the agents' Docker image (aiomoqt). The schedule, the recording format and the lecture mapping are in the
transport-free modules ``replay``, ``recording``, ``lecture`` and ``session``.

* ``play``: the lecture on ``talk/<room>/teacher`` (catalog, video, audio), once or N times; with ``slides``, also
  its slide frames on ``talk/<room>/slides`` for the describe agent (found in the video, see ``slideshow``).
* ``record``: every agent track the room catalog lists (MSF records under stable names), rebuilt into full states and
  stamped with room time.
* ``generate``: ``record`` and ``play`` once together, for agents already running in a private room.
* ``session``: a demo lecture's live sessions in ``talk/<room>``, one after the other (``session``): each plays the
  lecture once from 00:00 on a room clock of its own (``E`` is its start), says ``ended`` on the room's ``room``
  track, withdraws its broadcasts, and after a gap the next starts from 00:00 under a new ``E``. With the slides
  (``slides``), the speaker's ``deck`` and ``slide`` tracks (``demo_slides``) on ``talk/<room>/slides`` and, for
  FETCH, ``talk/<room>/archive/slides``. Its AI tracks: with ``TT_DEMO_LIVE_AGENTS`` on, the live agents' only (the
  session also sends the slide ``frames`` the describe agent reads, and its catalog lists the agents' tracks as the
  room service would); off, the recording's, each item at the delay its agent really had (``session``), as sliced
  tracks under stable names (``slicing``, decision 0012) that answer a FETCH of any group (``origin``). The catalog
  also lists the room service's chat and stats tracks, which the room service publishes there (``archive.looped``).
* ``serve_recording``: a demo lecture's recording room ``<id>-recording``, built into the archive by
  ``recording_room``: its catalog, ``room`` track and AI tracks answer FETCH from the archived slices, its slides
  from memory; the media is the archive's HLS.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import os
import shutil
import time
from collections.abc import Awaitable, Callable, Iterator
from dataclasses import replace
from pathlib import Path
from typing import cast

from .archive.catalog import Budget, CatalogFeed
from .archive.events import history_path
from .archive.looped import with_room_service
from .archive.slices import NORMAL, TrackArchive, listdir
from .contracts import (
    DECK_TRACK,
    ROOM_TRACK,
    ROOT,
    SLICE_MS,
    SLIDE_TRACK,
    AgentInfo,
    RoomStateRecord,
    SlideFrame,
    Source,
    Usage,
    agents_prefix,
    catalog_path,
    slice_of,
    slides_path,
    teacher_path,
    wall_unix_ms,
)
from .contracts import RoomCatalog as MsfRoomCatalog
from .contracts import RoomState as WireRoomState
from .demo_slides import DECK_GROUP, TRACKS, LectureSlides, with_slides
from .follow import FollowedTrack, TrackFollower, catalog_tracks
from .lecture import (
    AUDIO_TRACK,
    CATALOG_TRACK,
    CLOCK_TIMESCALE,
    VIDEO_TRACK,
    LectureInfo,
    MediaPacket,
    catalog,
    legacy_frame,
    packets,
    probe,
)
from .lecture import clock as hang_clock
from .moq import AUDIO_IDLE_S, Relay, TrackWriter, connect, until_closed
from .origin import ComputedTrack
from .recording import RecordingWriter, load_manifest
from .replay import Cue, MediaClock, event_us, session_events
from .room_catalog import CATALOG_TRACK as ROOM_CATALOG_TRACK
from .room_catalog import RoomCatalog, room_service_tracks, speaker_sources, speaker_tracks
from .runtime import now_ms
from .session import RoomStates, SessionPlan, honest_recording, next_epoch, tail_ms
from .slicing import Placed, Room, Template, cues, room_catalog
from .slideshow import Crop, Slide, find_slides

log = logging.getLogger("talk_tracks.demo")
HEARTBEAT_S = 2.0  # how often the catalogs go out again, for late subscribers

LECTURE_FILE = "lecture.mp4"
VIDEO_QUEUE = 64  # about one GOP: what a first subscriber gets first is at most ~2.5 s old
AUDIO_QUEUE = 50  # 1 s of Opus
CATALOG_QUEUE = 2
SLIDE_REPEAT_S = 2.0  # the speaker console repeats the current slide this often
POLL_S = 0.25  # how often a computed event track checks for objects come due

Clock = Callable[[], int]  # room media time now, ms


class Teacher:
    """The lecture's three tracks on ``talk/<room>/teacher``, written at real time on the room's media clock.

    ``wall_ms`` is the wall time of media time 0, which the catalog's hang ``clock`` carries: a session's ``E``, or,
    left None, the moment ``run_lecture`` starts playing."""

    def __init__(self, relay: Relay, room: str, info: LectureInfo, *, wall_ms: int | None = None) -> None:
        self._relay, self._room, self.info, self.wall_ms = relay, room, info, wall_ms
        self._catalog: TrackWriter | None = None
        self._video: TrackWriter | None = None
        self._audio: TrackWriter | None = None
        self._extra: dict[str, object] = {}
        self._gop_open = False

    async def start(self, extra: dict[str, object] | None = None) -> None:
        ns = teacher_path(self._room)
        self._catalog = await self._relay.publish(ns, CATALOG_TRACK, queue=CATALOG_QUEUE)
        if self.info.video is not None:
            self._video = await self._relay.publish(ns, VIDEO_TRACK, queue=VIDEO_QUEUE)
        if self.info.audio is not None:
            self._audio = await self._relay.publish(ns, AUDIO_TRACK, queue=AUDIO_QUEUE)
        await self.publish_catalog(extra)

    async def publish_catalog(self, extra: dict[str, object] | None = None) -> None:
        """The catalog, one group per update. Repeated as a heartbeat: a subscriber that arrives while nothing new is
        written still gets it within seconds."""
        if extra is not None:
            self._extra = extra
        assert self._catalog is not None
        root = catalog(self.info, self._extra, wall_ms=self.wall_ms)
        await self._catalog.write(json.dumps(root, separators=(",", ":")).encode())

    async def send(self, packet: MediaPacket, offset_us: int = 0) -> None:
        frame = legacy_frame(offset_us + packet.file_us, packet.data)
        if packet.kind == "audio":
            if self._audio is not None:
                await self._audio.write(frame)  # one Opus packet per group, like the speaker's browser
        elif self._video is not None:
            if packet.keyframe:
                await self._video.write(frame)  # a keyframe opens the GOP's group
                self._gop_open = True
            elif self._gop_open:
                await self._video.append(frame)


class SlideTrack:
    """The lecture's slides on ``talk/<room>/slides`` track ``frames``, as the speaker console sends them: each stamped
    with the Unix wall time it appeared (``SlideFrame.at_ms``: media time 0 is ``wall_ms``), the current one repeated
    every 2 s for a late subscriber. What the describe agent reads. ``offset_ms`` and ``first_id`` place a second play
    of the lecture after the first (``play --loops``)."""

    def __init__(self, relay: Relay, room: str, slides: list[Slide]) -> None:
        self._relay, self._room, self._slides = relay, room, slides
        self._sink: TrackWriter | None = None

    async def start(self) -> None:
        self._sink = await self._relay.publish(slides_path(self._room), "frames", queue=CATALOG_QUEUE)

    async def show(self, start: float, *, wall_ms: int, offset_ms: int = 0, first_id: int = 0) -> None:
        """The slides of one play of the lecture from monotonic time ``start`` (media time ``offset_ms``); runs until
        cancelled."""
        assert self._sink is not None
        for i, slide in enumerate(self._slides):
            await _at(start, slide.at_ms / 1000)
            frame = (
                SlideFrame(
                    id=first_id + i,
                    at_ms=wall_ms + offset_ms + slide.at_ms,
                    mime="image/jpeg",
                    data_b64=base64.b64encode(slide.jpeg).decode(),
                )
                .model_dump_json()
                .encode()
            )
            until = self._slides[i + 1].at_ms / 1000 if i + 1 < len(self._slides) else None
            while True:
                try:
                    await self._sink.write(frame)
                except TimeoutError:
                    log.warning("slide %d write timed out", i)
                if until is not None and time.monotonic() + SLIDE_REPEAT_S >= start + until:
                    break
                await asyncio.sleep(SLIDE_REPEAT_S)


class SlicedTracks:
    """A recording's agent tracks in a session (switch off) under their stable names,
    ``talk/<room>/agents/<agent>``: ``items`` cut in slices, ``outline`` for chapters. Every group is ``sliced``'s to
    compute, so a FETCH of any past group is answered from it, and what goes out live is byte for byte what a FETCH
    returns."""

    def __init__(self, relay: Relay, room: str, sliced: Room, now: Clock) -> None:
        self._relay, self._room, self.sliced, self._now = relay, room, sliced, now
        self._tracks: dict[str, ComputedTrack] = {}

    async def start(self) -> None:
        for name, agent in self.sliced.agents.items():
            sink = await self._relay.publish(f"{agents_prefix(self._room)}/{name}", agent.track)
            self._tracks[name] = ComputedTrack(sink, _Source(self.sliced, name, self._now))

    def cues(self) -> Iterator[Cue]:
        return cues(self.sliced.template)

    async def play(self, cue: Cue) -> None:
        track = self._tracks[cue.agent]
        payload = self.sliced.group(cue.agent, cue.group)[cue.index].payload
        await (track.open(cue.group, payload) if cue.index == 0 else track.append(cue.group, cue.index, payload))


class _Source:
    """One track's groups as they stand now on the room clock: what a FETCH gets."""

    def __init__(self, sliced: Room, agent: str, now: Clock) -> None:
        self._sliced, self._agent, self._now = sliced, agent, now

    def objects(self, group: int) -> list[bytes]:
        return [p.payload for p in self._sliced.published(self._agent, group, self._now())]


class SpeakerSlides:
    """A demo room's slides as the speaker's ``deck`` and ``slide`` tracks (``demo_slides``): published on
    ``talk/<room>/slides`` and again on ``talk/<room>/archive/slides``, where a player fetches the past of a speaker
    track (decision 0022). Every group is computed, so either name answers a FETCH of any group. ``now`` is the room
    time (a session's, or the recording room's end)."""

    def __init__(self, relay: Relay, room: str, source: LectureSlides, now: Clock) -> None:
        self._relay, self._room, self.source, self._now = relay, room, source, now
        self._deck: list[ComputedTrack] = []
        self._slide: list[ComputedTrack] = []

    async def start(self) -> None:
        for ns in (slides_path(self._room), history_path(slides_path(self._room))):
            # The writer's queue holds the whole deck: a smaller one drops its first objects while nobody subscribes
            # and starts new groups for the rest, so the track's Largest Location ran ahead of the one deck group.
            deck = await self._relay.publish(ns, DECK_TRACK, queue=len(self.source.deck))
            self._deck.append(ComputedTrack(deck, _Computed(self.source.deck_group, self._now)))
            slide = await self._relay.publish(ns, SLIDE_TRACK)
            self._slide.append(ComputedTrack(slide, _Computed(self.source.slide_group, self._now, published=True)))
        for i, placed in enumerate(self.source.deck):  # one group for the room's life: Largest Location covers it
            for track in self._deck:
                if i == 0:
                    await track.open(DECK_GROUP, placed.payload)
                else:
                    await track.append(DECK_GROUP, i, placed.payload)

    async def write_group(self, k: int) -> None:
        """Slice ``k`` of the slide track as it stands now, at once (the recording room's last, for Largest)."""
        due = [p for p in self.source.slide_group(k) if p.media_ms <= self._now()]
        for i, placed in enumerate(due):
            for track in self._slide:
                await (track.open(k, placed.payload) if i == 0 else track.append(k, i, placed.payload))

    async def run(self) -> None:
        """Write each slice of the slide track as it comes due on the room clock: its carry-in at the slice's start,
        each ``show`` at its time. Runs until cancelled."""
        group, sent = None, 0
        while True:
            now = self._now()
            k = slice_of(max(0, now))
            if k != group:
                group, sent = k, 0
            placed = self.source.slide_group(k)
            due = [p for p in placed if p.media_ms <= now]
            for i in range(sent, len(due)):
                for track in self._slide:
                    try:
                        await (track.open(k, due[i].payload) if i == 0 else track.append(k, i, due[i].payload))
                    except TimeoutError:
                        log.warning("slide group %d object %d write timed out", k, i)
            sent = len(due)
            upcoming = placed[sent].media_ms if sent < len(placed) else (k + 1) * SLICE_MS
            await asyncio.sleep(max(0.0, (upcoming - self._now()) / 1000))


class _Computed:
    """A ``GroupSource`` from a function of the group number; ``published`` keeps only what is out by now."""

    def __init__(self, group: Callable[[int], tuple[Placed, ...]], now: Clock, *, published: bool = False) -> None:
        self._group, self._now, self._published = group, now, published

    def objects(self, group: int) -> list[bytes]:
        now = self._now()
        return [p.payload for p in self._group(group) if not self._published or p.media_ms <= now]


class RoomCatalogTrack:
    """A demo room's MSF catalog on ``talk/<room>/catalog`` (``room_catalog``), written again as a heartbeat (a new
    subscription starts at the next group) from ``document``, which is given the wall time: each status entry's
    ``updated_ms`` refreshed (an entry older than 15 s counts as idle), and in a live-agents session the agents'
    tracks as they come and go."""

    def __init__(self, relay: Relay, room: str, document: Callable[[int], dict[str, object]]) -> None:
        self._relay, self._room, self._document = relay, room, document
        self._sink: TrackWriter | None = None

    async def start(self) -> None:
        self._sink = await self._relay.publish(catalog_path(self._room), ROOM_CATALOG_TRACK, queue=CATALOG_QUEUE)
        await self.publish()

    async def publish(self) -> None:
        assert self._sink is not None
        await self._sink.write(json.dumps(self._document(now_ms()), separators=(",", ":")).encode())


class RoomStateTrack:
    """A session's ``room`` track on ``talk/<room>/catalog`` (``session.RoomStates``): a slice every 4 s of session
    time while it runs, each opened by its carry-in; ``say`` adds a record (``on_air``, ``ended``) and writes it at
    once. After ``ended`` no slice opens: the slice holding it stays the newest, so a joining FETCH (the live agents'
    ``rooms.room_ended``, a player) finds the end."""

    def __init__(self, relay: Relay, room: str, states: RoomStates, now: Clock) -> None:
        self._relay, self._room, self.states, self._now = relay, room, states, now
        self._track: ComputedTrack | None = None
        self._group: int | None = None
        self._sent = 0
        self._lock = asyncio.Lock()
        self.ended = False

    async def start(self) -> None:
        sink = await self._relay.publish(catalog_path(self._room), ROOM_TRACK)
        self._track = ComputedTrack(sink, _Computed(self._placed, self._now))

    def _placed(self, k: int) -> tuple[Placed, ...]:
        return tuple(Placed(k * SLICE_MS, p) for p in self.states.group(k, self._now()))

    async def _write(self, k: int) -> None:
        assert self._track is not None
        objects = self.states.group(k, self._now())
        if k != self._group:
            self._group, self._sent = k, 0
        for i in range(self._sent, len(objects)):
            await (self._track.open(k, objects[i]) if i == 0 else self._track.append(k, i, objects[i]))
        self._sent = len(objects)

    async def say(self, state: WireRoomState) -> None:
        async with self._lock:
            at = max(0, self._now())
            if self.states.records:
                at = max(at, self.states.records[-1].m)
            self.states.add(RoomStateRecord(m=at, data=state))
            await self._write(slice_of(at))
            self.ended = self.ended or state.state == "ended"

    async def run(self) -> None:
        """Open each slice as session time reaches it, until the session ends. Runs until cancelled."""
        while not self.ended:
            async with self._lock:
                if not self.ended:
                    try:
                        await self._write(slice_of(max(0, self._now())))
                    except TimeoutError:
                        log.warning("room track write timed out")
            await asyncio.sleep(POLL_S)


async def _together(*work: Awaitable[None] | None) -> None:
    """Run the given coroutines until the first ends or fails; cancel the rest."""
    tasks = [asyncio.ensure_future(w) for w in work if w is not None]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        for task in tasks:
            task.cancel()


async def _at(start: float, offset_s: float) -> None:
    await asyncio.sleep(max(0.0, start + offset_s - time.monotonic()))


async def _every(seconds: float, beat: Callable[[], Awaitable[None]]) -> None:
    while True:
        await asyncio.sleep(seconds)
        try:
            await beat()
        except TimeoutError:
            log.warning("heartbeat write timed out")


async def _until_wall(wall_ms: int) -> None:
    await asyncio.sleep(max(0.0, (wall_ms - now_ms()) / 1000))


async def run_lecture(
    teacher: Teacher,
    *,
    lecture: Path,
    slides: SlideTrack | None = None,
    tracks: SlicedTracks | None = None,
    end_ms: int | None = None,
    offset_ms: int = 0,
    first_slide: int = 0,
) -> None:
    """Play the lecture once, from media time ``offset_ms`` (``play --loops``: the plays before it), with the slide
    frames with ``slides`` and a recording's agent tracks with ``tracks``; return at media time ``offset_ms + end_ms``
    (default the lecture's end). Media time is placed on the wall clock at ``teacher.wall_ms``, set here when the
    teacher has none, and the play starts when the wall clock gets there."""
    if teacher.wall_ms is None:
        teacher.wall_ms = now_ms() - offset_ms
    end = teacher.info.duration_ms if end_ms is None else end_ms
    # media time ``offset_ms`` on the monotonic clock: the schedule never drifts from the wall clock it was set on
    start = time.monotonic() + (teacher.wall_ms + offset_ms - now_ms()) / 1000
    wall = teacher.wall_ms
    show = (
        asyncio.create_task(slides.show(start, wall_ms=wall, offset_ms=offset_ms, first_id=first_slide))
        if slides
        else None
    )
    try:
        for event in session_events(packets(lecture), tracks.cues() if tracks else ()):
            await _at(start, event_us(event) / 1e6)
            try:
                if isinstance(event, MediaPacket):
                    await teacher.send(event, offset_ms * 1000)
                elif tracks is not None:
                    await tracks.play(event)
            except TimeoutError:
                log.warning("write timed out at %d ms", event_us(event) // 1000)
        await _at(start, end / 1000)
    finally:
        if show is not None:
            show.cancel()


# --- recording --------------------------------------------------------------------------------------------------


class RecorderClock:
    """The room clock as a recorder sees it: ``E`` and the shifts from the room catalog, the wall time of the
    teacher's media time 0 from its hang catalog ``clock``. ``origin`` is the room time of media time 0 once all are
    known (design §4.5)."""

    def __init__(self) -> None:
        self.epoch: int | None = None
        self.shift: dict[str, int] = {}
        self.wall: tuple[str, float] | None = None  # (clock.wall as the catalog keys it, Unix ms of media time 0)

    def origin(self) -> int | None:
        if self.epoch is None or self.wall is None or self.wall[0] not in self.shift:
            return None
        return round(self.wall[1] - self.epoch + self.shift[self.wall[0]])


async def teacher_clock(relay: Relay, room: str, clock: MediaClock, seen: Callable[[int], None]) -> None:
    async for payload in relay.objects(teacher_path(room), AUDIO_TRACK, idle_s=AUDIO_IDLE_S):
        if clock.observe(payload) is not None:
            seen(clock.ms)


async def teacher_wall(relay: Relay, room: str, room_clock: RecorderClock) -> None:
    async for payload in relay.objects(teacher_path(room), CATALOG_TRACK):
        hang: object = json.loads(payload)
        c = cast(dict[str, object], hang).get("clock") if isinstance(hang, dict) else None
        if isinstance(c, dict) and "wall" in c:
            c = cast(dict[str, object], c)
            wall, timescale = int(str(c["wall"])), int(str(c.get("timescale") or CLOCK_TIMESCALE))
            room_clock.wall = (str(wall), wall_unix_ms(wall, timescale, 0))


async def record_room(relay: Relay, room: str, rec: RecordingWriter) -> None:
    """Record until cancelled: every agent track the room catalog lists, rebuilt into full states (``follow``),
    stamped with the room time of the newest teacher audio, see ``recording``."""
    clock = MediaClock()
    room_clock = RecorderClock()
    spend: dict[str, float] = {}
    inbox: asyncio.Queue[tuple[FollowedTrack, bytes]] = asyncio.Queue(maxsize=256)
    readers: dict[tuple[str, str], asyncio.Task[None]] = {}

    def room_now(media_ms: int) -> int:
        origin = room_clock.origin()
        if origin is not None:
            rec.room_origin(origin)
        return max(0, media_ms + (origin or 0))

    async def read(track: FollowedTrack) -> None:
        async for payload in relay.objects(track.namespace, track.name):
            await inbox.put((track, payload))

    async def catalogs() -> None:
        async for payload in relay.objects(catalog_path(room), ROOM_CATALOG_TRACK):
            try:
                cat = MsfRoomCatalog.model_validate_json(payload)
            except ValueError:
                log.warning("skipping a room catalog that does not match the contract")
                continue
            room_clock.epoch, room_clock.shift = cat.tt.E, dict(cat.tt.shift)
            spend.update({name: s.spend_usd for name, s in cat.tt.status.items()})
            for track in catalog_tracks(cat):
                if (track.namespace, track.name) not in readers:
                    log.info("recording %s/%s (%s)", track.agent, track.name, track.kind)
                    readers[(track.namespace, track.name)] = asyncio.create_task(read(track))

    tasks = [
        asyncio.create_task(teacher_clock(relay, room, clock, lambda ms: rec.media_seen(room_now(ms)))),
        asyncio.create_task(teacher_wall(relay, room, room_clock)),
        asyncio.create_task(catalogs()),
    ]
    followers: dict[tuple[str, str], TrackFollower] = {}
    try:
        while True:
            track, payload = await inbox.get()
            key = (track.namespace, track.name)
            follower = followers.setdefault(key, TrackFollower(track.kind, track.lang))
            try:
                state = follower.accept(payload)
            except ValueError:
                log.warning("skipping an object from %s that does not match the contract", track.agent)
                continue
            if state is None:
                continue
            info = AgentInfo(name=track.agent, label=track.label, model="unknown")
            usage = Usage(cost_usd=spend.get(track.agent, 0.0))
            snapshot = rec.add(info, state, usage, media_ms=room_now(clock.ms), wall_ms=now_ms())
            log.info("%s at room %.1f s", track.agent, snapshot.media_ms / 1000)
    finally:
        for task in [*tasks, *readers.values()]:
            task.cancel()


# --- commands ---------------------------------------------------------------------------------------------------


async def _find_slides(media: Path, crop: Crop | None) -> list[Slide] | None:
    """Before connecting: the scan decodes every keyframe (about a minute for a 20-minute lecture)."""
    if crop is None:
        return None
    found = await asyncio.to_thread(find_slides, media, crop)
    log.info("slides: %d found in %s", len(found), media.name)
    return found


async def _slide_track(relay: Relay, room: str, found: list[Slide] | None) -> SlideTrack | None:
    if found is None:
        return None
    track = SlideTrack(relay, room, found)
    await track.start()
    return track


async def play(
    url: str,
    room: str,
    media: Path,
    *,
    loops: int | None,
    token: str | None,
    insecure: bool,
    slides: Crop | None = None,
) -> None:
    """The lecture as the speaker, ``loops`` times back to back on one rising media clock (None: forever)."""
    info = probe(media)
    log.info("lecture %s: %.1f s", media.name, info.duration_ms / 1000)
    found = await _find_slides(media, slides)
    async with connect(url, token=token, insecure=insecure) as relay:
        teacher = Teacher(relay, room, info)
        await teacher.start()
        track = await _slide_track(relay, room, found)

        async def plays() -> None:
            beat = asyncio.create_task(_every(HEARTBEAT_S, teacher.publish_catalog))
            try:
                n = 0
                while loops is None or n < loops:
                    offset = n * info.duration_ms
                    first = n * len(found or ())
                    await run_lecture(teacher, lecture=media, slides=track, offset_ms=offset, first_slide=first)
                    n += 1
            finally:
                beat.cancel()

        await until_closed(relay, plays())


def _live_document(
    feed: CatalogFeed, base: Callable[[int], RoomCatalog], skip: frozenset[str]
) -> Callable[[int], dict[str, object]]:
    """A session's catalog at wall time t: ``base`` (the recording's tracks, or none) with every other agent announced
    in the room that has a ``track.json`` (a live agent: all of them with the switch on, ``translate-any`` off)."""

    def document(wall_ms: int) -> dict[str, object]:
        built = base(wall_ms)
        tracks, status = feed.agent_tracks(wall_ms)
        extra = tuple(t for t in tracks if t.namespace.rsplit("/", 1)[-1] not in skip)
        entries = {name: s for name, s in status.items() if name not in skip}
        return replace(built, tracks=(*extra, *built.tracks), status={**built.status, **entries}).to_json()

    return document


async def _announced_agents(relay: Relay, room: str, agents: set[str]) -> None:
    """Keep ``agents`` to the agents announced in ``room`` (``talk/<room>/agents/<agent>``)."""
    async for path, active in relay.announced(ROOT):
        parts = path.split("/")
        if len(parts) == 3 and parts[0] == room and parts[1] == "agents":
            (agents.add if active else agents.discard)(parts[2])


def _budget() -> Budget:
    """The agents' spend ledger, read for ``capped`` in a live-agents session's catalog."""
    return Budget(
        Path(os.environ.get("TT_LEDGER", "data/ledger.jsonl")),
        Path(os.environ.get("TT_CAPS_DIR", "data/caps")),
        float(os.environ.get("TT_SPEND_CEILING_USD", "100")),
        float(os.environ.get("TT_ROOM_CAP_USD", "2")),
    )


async def run_session(
    url: str,
    room: str,
    plan: SessionPlan,
    *,
    lecture: Path,
    info: LectureInfo,
    template: Template | None,
    found: list[Slide] | None,
    archive_root: Path,
    gap_s: float,
    token: str | None,
    insecure: bool,
) -> None:
    """One live session: its catalog and ``room`` track on one connection, which outlives the session by the gap
    (``ended`` stays readable), and its teacher, slides and recorded tracks on another, closed at the session's end
    so the relay withdraws them. ``template`` None is the live-agents switch: no recorded AI track is published."""
    epoch = plan.epoch_ms
    wall = int(hang_clock(epoch)["wall"])

    def session_ms() -> int:
        return plan.at(now_ms())

    deck = LectureSlides.of(found, -(-plan.end_ms // SLICE_MS) * SLICE_MS) if found else None
    sliced = Room(template, epoch) if template is not None else None

    def base(wall_ms: int) -> RoomCatalog:
        if sliced is not None:
            built = room_catalog(sliced.template, room, epoch, wall, wall_ms)
        else:
            built = RoomCatalog(epoch, (), shift={wall: 0})
        if deck is not None:
            built = with_slides(built, room)
        else:
            built = replace(built, sources=speaker_sources(room, audio=True, camera=info.video is not None))
        room_track = next(t for t in room_service_tracks(room) if t.name == ROOM_TRACK)
        return with_room_service(replace(built, tracks=(*built.tracks, room_track)), room)

    feed = CatalogFeed(room, archive_root, capped=_budget().capped)  # a live agent's paid track says capped
    skip: frozenset[str] = frozenset(sliced.agents) if sliced is not None else frozenset()
    states = RoomStates([])
    async with connect(url, token=token, insecure=insecure) as control:
        listening = asyncio.create_task(_announced_agents(control, room, feed.agents))
        catalog_track = RoomCatalogTrack(control, room, _live_document(feed, base, skip))
        room_track = RoomStateTrack(control, room, states, session_ms)
        await catalog_track.start()  # the new E, before the teacher comes on air: agents stamp nothing before it
        await room_track.start()
        beat = asyncio.create_task(_every(HEARTBEAT_S, catalog_track.publish))
        try:
            await _until_wall(epoch)
            log.info(
                "session %d in room %s: E %d, %.1f s (the lecture %.1f s)",
                plan.number,
                room,
                epoch,
                plan.end_ms / 1000,
                plan.lecture_ms / 1000,
            )
            await room_track.say(WireRoomState(state="on_air"))
            async with connect(url, token=token, insecure=insecure) as media:
                teacher = Teacher(media, room, info, wall_ms=epoch)
                await teacher.start({"talk_tracks": plan.teacher_section()})
                frames = await _slide_track(media, room, found) if template is None else None
                speaker: SpeakerSlides | None = None
                if deck is not None:
                    speaker = SpeakerSlides(media, room, deck, session_ms)
                    await speaker.start()
                tracks: SlicedTracks | None = None
                if sliced is not None:
                    tracks = SlicedTracks(media, room, sliced, session_ms)
                    await tracks.start()
                run = run_lecture(teacher, lecture=lecture, slides=frames, tracks=tracks, end_ms=plan.end_ms)
                await until_closed(
                    media,
                    _together(
                        run,
                        speaker.run() if speaker is not None else None,
                        room_track.run(),
                        _every(HEARTBEAT_S, teacher.publish_catalog),
                    ),
                )
                await room_track.say(WireRoomState(state="ended"))  # before the broadcasts go: agents see the end
            log.info("session %d in room %s ended; the next in %.0f s", plan.number, room, gap_s)
            await asyncio.sleep(gap_s)
        finally:
            beat.cancel()
            listening.cancel()


async def session(
    url: str,
    room: str,
    recording: Path,
    *,
    media: Path | None,
    token: str | None,
    insecure: bool,
    slides: Crop | None = None,
    live: bool,
    gap_s: float,
    archive_root: Path,
) -> None:
    """A demo lecture's live sessions in ``room``, one after the other, forever (decision 0032). With ``live`` (the
    ``TT_DEMO_LIVE_AGENTS`` switch) the recording's agent snapshots are never read: the live agents make every AI
    track. Off, the recording's tracks go out at the delay each agent had when it was recorded."""
    manifest = load_manifest(recording)
    lecture = media or (recording / (manifest.media or LECTURE_FILE))
    info = probe(lecture)
    template: Template | None = None
    end_ms = info.duration_ms
    if live:
        log.info("live agents (TT_DEMO_LIVE_AGENTS): no recorded AI track is read or published in room %s", room)
    else:
        origin = manifest.room_origin_ms or 0  # recordings from the agents' records are on the room clock
        recorded = honest_recording(recording)
        end_ms += tail_ms(recorded, origin, info.duration_ms)
        template = Template.build(recorded, end_ms, origin_ms=origin)
        log.info(
            "room %s replays %s: %s",
            room,
            recording.name,
            ", ".join(f"{a.info.name} ({a.track}, {len(a.groups)} groups)" for a in template.agents)
            or "no agent tracks",
        )
    found = await _find_slides(lecture, slides)
    number = 0
    while True:
        plan = SessionPlan(number, next_epoch(now_ms() + 1000), info.duration_ms, end_ms)
        await run_session(
            url,
            room,
            plan,
            lecture=lecture,
            info=info,
            template=template,
            found=found,
            archive_root=archive_root,
            gap_s=gap_s,
            token=token,
            insecure=insecure,
        )
        number += 1


# --- the recording room -------------------------------------------------------------------------------------------


class _Archived:
    """A ``GroupSource`` from an archived track: each slice's objects, end markers left out."""

    def __init__(self, archive: TrackArchive) -> None:
        self._archive = archive

    def objects(self, group: int) -> list[bytes]:
        found = self._archive.read_local(group)
        return [o.payload for o in found.objects if o.status == NORMAL] if found is not None else []


async def _serve_archived(relay: Relay, namespace: str, archive: TrackArchive) -> int | None:
    """Publish an archived track whose every group answers a FETCH from the archive, and write its last group live,
    so the track's Largest Location covers all of them. Its newest group, None when it has none."""
    sink = await relay.publish(namespace, archive.track)
    track = ComputedTrack(sink, _Archived(archive))
    newest = archive.latest_group()
    if newest is not None:
        for i, payload in enumerate(_Archived(archive).objects(newest)):
            await (track.open(newest, payload) if i == 0 else track.append(newest, i, payload))
    return newest


async def serve_recording(
    url: str,
    room: str,
    *,
    archive_root: Path,
    media: Path | None,
    slides: Crop | None,
    token: str | None,
    insecure: bool,
) -> None:
    """A recording room (``<id>-recording``, built by ``recording_room``) for replay: its catalog (E from the
    archive's ``room.json``, the AI tracks from their ``track.json``, labelled recorded, the slides and the ``room``
    track), its ``room`` and AI tracks answering FETCH from the archived slices, and with ``slides`` its deck and slide
    tracks from the lecture's slides, kept in memory only (ticket 0001). Runs until cancelled."""
    index = json.loads((archive_root / room / "room.json").read_text(encoding="utf-8"))
    epoch = int(index["epoch_ms"])
    wall = int(next(iter(index["shift"])))
    states = TrackArchive.of(catalog_path(room), ROOM_TRACK, root=archive_root)
    last_slice = states.latest_group()
    if last_slice is None:
        raise FileNotFoundError(f"{room}: no room track in the archive; build it with record-archive")
    end_ms = (last_slice + 1) * SLICE_MS - 1  # within the room track's last slice, which holds the end
    agents_dir = archive_root / room / "agents"
    agents = {a: listdir(agents_dir / a) for a in listdir(agents_dir)}
    found = await _find_slides(media, slides) if media is not None else None
    deck = LectureSlides.of(found, (last_slice + 1) * SLICE_MS) if found else None
    feed = CatalogFeed(room, archive_root)
    feed.agents = set(agents)
    feed.epoch_ms, feed.shift = epoch, {str(wall): 0}
    room_track = next(t for t in room_service_tracks(room) if t.name == ROOM_TRACK)
    feed.event_tracks = (*(t for t in speaker_tracks(room) if deck is not None and t.name in TRACKS), room_track)
    slides_source = Source(kind="slides", namespace=slides_path(room), tracks=list(TRACKS))
    feed.sources = (*speaker_sources(room, audio=True, camera=True), *((slides_source,) if deck else ()))
    async with connect(url, token=token, insecure=insecure) as relay:
        for agent, tracks in agents.items():
            for name in tracks:
                archive = TrackArchive(room, agent, name, root=archive_root)
                newest = await _serve_archived(relay, f"{agents_prefix(room)}/{agent}", archive)
                log.info("%s: %s/%s, slices up to %s", room, agent, name, newest)
        await _serve_archived(relay, catalog_path(room), states)
        if deck is not None:
            speaker = SpeakerSlides(relay, room, deck, lambda: end_ms)
            await speaker.start()
            await speaker.write_group(slice_of(end_ms))
            log.info("%s: a deck of %d slides", room, len(deck.slides))

        def document(wall_ms: int) -> dict[str, object]:
            doc = feed.document(wall_ms)
            assert doc is not None
            return doc

        catalog_track = RoomCatalogTrack(relay, room, document)
        await catalog_track.start()
        log.info("serving the recording room %s (E %d, %.1f s)", room, epoch, end_ms / 1000)
        await until_closed(relay, _every(HEARTBEAT_S, catalog_track.publish))


async def record(url: str, room: str, out: Path, *, media: str | None, token: str | None, insecure: bool) -> None:
    rec = RecordingWriter(out, room, wall_ms=now_ms(), media=media)
    try:
        async with connect(url, token=token, insecure=insecure) as relay:
            await until_closed(relay, record_room(relay, room, rec))
    finally:
        manifest = rec.close(wall_ms=now_ms())
        log.info("recording in %s: %s", out, ", ".join(f"{a.info.name} {a.snapshots}" for a in manifest.agents))


def copy_lecture(media: Path, out: Path) -> Path:
    """The recording keeps its own copy of the lecture, so the directory is everything a demo room needs."""
    out.mkdir(parents=True, exist_ok=True)
    lecture = out / LECTURE_FILE
    if media.resolve() != lecture.resolve():
        shutil.copyfile(media, lecture)
    return lecture


async def generate(
    url: str,
    room: str,
    media: Path,
    out: Path,
    *,
    lead_in_s: float,
    tail_s: float,
    token: str | None,
    insecure: bool,
    slides: Crop | None = None,
) -> None:
    """Play the lecture once into ``room`` (where agents run) while recording their tracks into ``out``."""
    lecture = copy_lecture(media, out)
    info = probe(lecture)
    found = await _find_slides(lecture, slides)
    rec = RecordingWriter(out, room, wall_ms=now_ms(), media=LECTURE_FILE)
    try:
        async with (
            connect(url, token=token, insecure=insecure) as recorder,
            connect(url, insecure=insecure, token=token) as speaker,
        ):
            recording = asyncio.create_task(record_room(recorder, room, rec))
            teacher = Teacher(speaker, room, info)
            await teacher.start()
            track = await _slide_track(speaker, room, found)
            log.info("lead-in %.0f s: the agents find the teacher broadcast", lead_in_s)
            await asyncio.sleep(lead_in_s)
            log.info("playing %s (%.1f s) into room %s", lecture.name, info.duration_ms / 1000, room)
            beat = asyncio.create_task(_every(HEARTBEAT_S, teacher.publish_catalog))
            try:
                await until_closed(speaker, run_lecture(teacher, lecture=lecture, slides=track))
            finally:
                beat.cancel()
            log.info("lecture over; recording the agents' last words for %.0f s", tail_s)
            await asyncio.sleep(tail_s)
            recording.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await recording
    finally:
        manifest = rec.close(wall_ms=now_ms())
        log.info("recording in %s: %s", out, ", ".join(f"{a.info.name} {a.snapshots}" for a in manifest.agents))
