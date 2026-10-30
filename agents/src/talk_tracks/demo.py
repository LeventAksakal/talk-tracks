"""Demo rooms over MoQ: play a lecture into a room, record a room's agent tracks, loop a recording as a live room.

Runs in the agents' Docker image (aiomoqt). The schedule, the recording format and the lecture mapping are in the
transport-free modules ``replay``, ``recording`` and ``lecture``.

* ``play``: the lecture on ``talk/<room>/teacher`` (catalog, video, audio), once or looping; with ``slides``, also
  its slide frames on ``talk/<room>/slides`` for the describe agent (found in the video, see ``slideshow``).
* ``record``: every agent track the room catalog lists (MSF records under stable names), rebuilt into full states and
  stamped with room time.
* ``generate``: ``record`` and ``play`` once together, for agents already running in a private room.
* ``loop``: the lecture and the recorded agent tracks together, forever, as if live: on the room clock of
  ``replay`` (anchored to the wall clock, so a restarted looper rejoins the loop in progress) and as sliced tracks
  under stable names (``slicing``, decision 0012), each answering a FETCH of any of its groups (``origin``), with
  long caption lines cut into subtitle cues first (``resegment``); with ``slides``, also the lecture's slides as the
  speaker's ``deck`` and ``slide`` tracks (``demo_slides``), live on ``talk/<room>/slides`` and for FETCH on
  ``talk/<room>/archive/slides`` too, where a player fetches the past of every speaker track (decision 0022).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import shutil
import time
from collections.abc import Awaitable, Callable, Iterator, Sequence
from pathlib import Path
from typing import cast

from .archive.events import history_path
from .contracts import (
    DECK_TRACK,
    SLICE_MS,
    SLIDE_TRACK,
    AgentInfo,
    SlideFrame,
    Usage,
    agents_prefix,
    catalog_path,
    slides_path,
    slice_of,
    teacher_path,
    wall_unix_ms,
)
from .contracts import RoomCatalog as MsfRoomCatalog
from .follow import FollowedTrack, TrackFollower, catalog_tracks
from .demo_slides import DECK_GROUP, LectureSlides, with_slides
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
from .replay import EPOCH_MS, Cue, LoopPlan, MediaClock, event_us, loop_events, position
from .resegment import resegment
from .revise import read_recording, translations_by_agent, with_patches
from .room_catalog import CATALOG_TRACK as ROOM_CATALOG_TRACK
from .room_catalog import RoomCatalog
from .runtime import now_ms
from .slicing import Placed, Room, Template, cues, room_catalog
from .slideshow import Crop, Slide, find_slides

log = logging.getLogger("talk_tracks.demo")
HEARTBEAT_S = 2.0  # how often the catalogs go out again, for late subscribers

LECTURE_FILE = "lecture.mp4"
VIDEO_QUEUE = 64  # about one GOP: what a first subscriber gets first is at most ~2.5 s old
AUDIO_QUEUE = 50  # 1 s of Opus
CATALOG_QUEUE = 2
SLIDE_REPEAT_S = 2.0  # the speaker console repeats the current slide this often


class Teacher:
    """The lecture's three tracks on ``talk/<room>/teacher``, written at real time on the room's media clock.

    ``wall_ms`` is the wall time of media time 0, which the catalog's hang ``clock`` carries: a looped room's
    ``EPOCH_MS``, or, left None, the moment ``run_lecture`` starts playing."""

    def __init__(self, relay: Relay, room: str, info: LectureInfo, *, wall_ms: int | None = None) -> None:
        self._relay, self._room, self.info, self.wall_ms = relay, room, info, wall_ms
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
        root = catalog(self.info, self._extra, wall_ms=self.wall_ms)
        await self._catalog.write(json.dumps(root, separators=(",", ":")).encode())

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


class SlideTrack:
    """The lecture's slides on ``talk/<room>/slides`` track ``frames``, as the speaker console sends them: each at the
    media time it appeared, the current one repeated every 2 s for a late subscriber. Loop k moves times by k x
    duration and ids by k x the slide count, like the agent tracks."""

    def __init__(self, relay: Relay, room: str, slides: list[Slide]) -> None:
        self._relay, self._room, self._slides = relay, room, slides
        self._sink: TrackWriter | None = None

    async def start(self) -> None:
        self._sink = await self._relay.publish(slides_path(self._room), "frames", queue=CATALOG_QUEUE)

    async def show(self, start: float, plan: LoopPlan) -> None:
        """Loop ``plan``'s slides, starting at monotonic time ``start``; runs until cancelled."""
        assert self._sink is not None
        for i, slide in enumerate(self._slides):
            await _at(start, slide.at_ms / 1000)
            frame = (
                SlideFrame(
                    id=plan.index * len(self._slides) + i,
                    at_ms=plan.media_us(slide.at_ms * 1000) // 1000,
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
    """A looped recording's agent tracks under their stable names, ``talk/<room>/agents/<agent>``: ``items`` cut in
    slices, ``outline`` for chapters. Every group is ``sliced``'s to compute, so a FETCH of any past group is
    answered from it, and what goes out live is byte for byte what a FETCH returns."""

    def __init__(self, relay: Relay, room: str, sliced: Room) -> None:
        self._relay, self._room, self.sliced = relay, room, sliced
        self._tracks: dict[str, ComputedTrack] = {}

    async def start(self, media_ms: int) -> None:
        """Publish every track with its group open at room media time ``media_ms`` filled up to then, so a late
        joiner, or a viewer of a restarted looper, gets the slice in progress at once."""
        before = media_ms - 1  # the loop's own schedule plays what is due from media_ms on
        for name, agent in self.sliced.agents.items():
            sink = await self._relay.publish(f"{agents_prefix(self._room)}/{name}", agent.track)
            track = ComputedTrack(sink, _Source(self.sliced, name))
            self._tracks[name] = track
            group = self.sliced.current(name, before)
            if group is None:
                continue
            for i, placed in enumerate(self.sliced.published(name, group, before)):
                await (track.open(group, placed.payload) if i == 0 else track.append(group, i, placed.payload))

    def cues(self, loop: int) -> Iterator[Cue]:
        return cues(self.sliced.template, loop)

    async def play(self, cue: Cue) -> None:
        track = self._tracks[cue.agent]
        payload = self.sliced.group(cue.agent, cue.group)[cue.index].payload
        await (track.open(cue.group, payload) if cue.index == 0 else track.append(cue.group, cue.index, payload))


class _Source:
    """One track's groups as they stand now on the room clock: what a FETCH gets."""

    def __init__(self, sliced: Room, agent: str) -> None:
        self._sliced, self._agent = sliced, agent

    def objects(self, group: int) -> list[bytes]:
        return [p.payload for p in self._sliced.published(self._agent, group, room_ms())]


class SpeakerSlides:
    """A looped room's slides as the speaker's ``deck`` and ``slide`` tracks (``demo_slides``): published on
    ``talk/<room>/slides`` and again on ``talk/<room>/archive/slides``, where a player fetches the past of a speaker
    track (decision 0022). Every group is computed, so either name answers a FETCH of any group."""

    def __init__(self, relay: Relay, room: str, source: LectureSlides) -> None:
        self._relay, self._room, self.source = relay, room, source
        self._deck: list[ComputedTrack] = []
        self._slide: list[ComputedTrack] = []

    async def start(self) -> None:
        for ns in (slides_path(self._room), history_path(slides_path(self._room))):
            deck = await self._relay.publish(ns, DECK_TRACK, queue=CATALOG_QUEUE)
            self._deck.append(ComputedTrack(deck, _Computed(self.source.deck_group)))
            slide = await self._relay.publish(ns, SLIDE_TRACK)
            self._slide.append(ComputedTrack(slide, _Computed(self.source.slide_group, published=True)))
        for i, placed in enumerate(self.source.deck):  # one group for the room's life: Largest Location covers it
            for track in self._deck:
                await (track.open(DECK_GROUP, placed.payload) if i == 0 else track.append(DECK_GROUP, i, placed.payload))

    async def run(self) -> None:
        """Write each slice of the slide track as it comes due on the room clock: its carry-in at the slice's start,
        each ``show`` at its time. Runs until cancelled."""
        group, sent = None, 0
        while True:
            now = room_ms()
            k = slice_of(now)
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
            await asyncio.sleep(max(0.0, (upcoming - room_ms()) / 1000))


class _Computed:
    """A ``GroupSource`` from a function of the group number; ``published`` keeps only what is out by now."""

    def __init__(self, group: Callable[[int], tuple[Placed, ...]], *, published: bool = False) -> None:
        self._group, self._published = group, published

    def objects(self, group: int) -> list[bytes]:
        now = room_ms()
        return [p.payload for p in self._group(group) if not self._published or p.media_ms <= now]


class RoomCatalogTrack:
    """A demo room's MSF catalog on ``talk/<room>/catalog`` (``room_catalog``). It never changes while the looper
    runs, and is written again as a heartbeat, like the teacher's (a new subscription starts at the next group), with
    each status entry's ``updated_ms`` refreshed: an entry older than 15 s counts as idle."""

    def __init__(self, relay: Relay, room: str, catalog: RoomCatalog) -> None:
        self._relay, self._room, self.catalog = relay, room, catalog
        self._sink: TrackWriter | None = None

    async def start(self) -> None:
        self._sink = await self._relay.publish(catalog_path(self._room), ROOM_CATALOG_TRACK, queue=CATALOG_QUEUE)
        await self.publish()

    async def publish(self) -> None:
        assert self._sink is not None
        root = self.catalog.updated(now_ms()).to_json()
        await self._sink.write(json.dumps(root, separators=(",", ":")).encode())


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


def room_ms() -> int:
    """Media time of a looped room now (``replay``: wall time since ``EPOCH_MS``)."""
    return now_ms() - EPOCH_MS


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
    lecture: Path,
    slides: SlideTrack | None = None,
    tracks: SlicedTracks | None = None,
    media_ms: int = 0,
    beats: Sequence[Callable[[], Awaitable[None]]] = (),
) -> None:
    """Play the lecture ``loops`` times (None: forever) from room media time ``media_ms``, with the slide frames with
    ``slides`` and a recording's agent tracks with ``tracks``. With tracks a loop lasts the template's period and the
    first one is joined in progress; without, a loop is the lecture. ``beats`` are repeated with the teacher's
    catalog. Media time is placed on the wall clock at ``teacher.wall_ms``, set here when the teacher has none."""
    duration_ms = teacher.info.duration_ms
    template = tracks.sliced.template if tracks else None
    period_ms, stride = (template.period_ms, template.stride) if template else (duration_ms, 1)
    first, skip_ms = position(media_ms, period_ms)
    if teacher.wall_ms is None:
        teacher.wall_ms = now_ms() - media_ms
    tasks = [asyncio.create_task(_every(HEARTBEAT_S, beat)) for beat in (teacher.publish_catalog, *beats)]
    # media time 0 on the monotonic clock: loop k starts k periods later, no drift over days
    origin = time.monotonic() - (now_ms() - teacher.wall_ms) / 1000
    show: asyncio.Task[None] | None = None
    try:
        index = first
        while loops is None or index < first + loops:
            plan = LoopPlan(index, period_ms, stride)
            loop_info = {"loop": index, "loop_start_ms": plan.media_offset_ms, "duration_ms": duration_ms}
            await teacher.publish_catalog({"talk_tracks": {**loop_info, "period_ms": period_ms}})
            skip_us = skip_ms * 1000 if index == first else 0
            log.info("loop %d: media from %d ms, from file time %d ms", index, plan.media_offset_ms, skip_us // 1000)
            start = origin + index * period_ms / 1000
            show = asyncio.create_task(slides.show(start, plan)) if slides is not None else None
            for event in loop_events(packets(lecture), tracks.cues(index) if tracks else ()):
                if event_us(event) < skip_us:
                    continue  # before the joined position: SlicedTracks.start sent the open groups
                await _at(start, event_us(event) / 1e6)
                try:
                    if isinstance(event, MediaPacket):
                        await teacher.send(event, plan)
                    elif tracks is not None:
                        await tracks.play(event)
                except TimeoutError:
                    log.warning("write timed out at %d ms", event_us(event) // 1000)
            await _at(start, period_ms / 1000)
            if show is not None:
                show.cancel()
            index += 1
    finally:
        for task in [*tasks, *([show] if show else [])]:
            task.cancel()


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
    info = probe(media)
    log.info("lecture %s: %.1f s", media.name, info.duration_ms / 1000)
    found = await _find_slides(media, slides)
    async with connect(url, token=token, insecure=insecure) as relay:
        teacher = Teacher(relay, room, info)
        await teacher.start()
        track = await _slide_track(relay, room, found)
        await until_closed(relay, run_lecture(teacher, loops=loops, lecture=media, slides=track))


async def loop(
    url: str,
    room: str,
    recording: Path,
    *,
    media: Path | None,
    token: str | None,
    insecure: bool,
    slides: Crop | None = None,
) -> None:
    manifest = load_manifest(recording)
    lecture = media or (recording / (manifest.media or LECTURE_FILE))
    info = probe(lecture)
    origin = manifest.room_origin_ms or 0  # recordings from the agents' records are on the room clock
    recorded = with_patches(recording, read_recording(recording))
    recorded = resegment(recorded, translations_by_agent(recording, recorded))
    sliced = Room(Template.build(recorded, info.duration_ms, origin_ms=origin), EPOCH_MS)
    log.info(
        "looping %s (%.1f s, a loop every %.0f s) with %s in room %s",
        lecture.name,
        info.duration_ms / 1000,
        sliced.template.period_ms / 1000,
        ", ".join(f"{a.info.name} ({a.track}, {len(a.groups)} groups a loop)" for a in sliced.template.agents)
        or "no agent tracks",
        room,
    )
    found = await _find_slides(lecture, slides)
    deck = LectureSlides.of(found, sliced.template.period_ms) if found else None
    async with connect(url, token=token, insecure=insecure) as relay:
        teacher = Teacher(relay, room, info, wall_ms=EPOCH_MS)
        await teacher.start()
        wall = hang_clock(EPOCH_MS)["wall"]
        built = room_catalog(sliced.template, room, EPOCH_MS, wall, now_ms())
        speaker: SpeakerSlides | None = None
        if deck is not None:
            built = with_slides(built, room)
            speaker = SpeakerSlides(relay, room, deck)
            await speaker.start()
            log.info("slides: a deck of %d, shown on the slide track", len(deck.slides))
        room_catalog_track = RoomCatalogTrack(relay, room, built)
        await room_catalog_track.start()
        start = room_ms()
        tracks = SlicedTracks(relay, room, sliced)
        await tracks.start(start)
        run = run_lecture(
            teacher, loops=None, lecture=lecture, tracks=tracks, media_ms=start, beats=[room_catalog_track.publish]
        )
        await until_closed(relay, _together(run, speaker.run() if speaker is not None else None))


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
            await until_closed(speaker, run_lecture(teacher, loops=1, lecture=lecture, slides=track))
            log.info("lecture over; recording the agents' last words for %.0f s", tail_s)
            await asyncio.sleep(tail_s)
            recording.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await recording
    finally:
        manifest = rec.close(wall_ms=now_ms())
        log.info("recording in %s: %s", out, ", ".join(f"{a.info.name} {a.snapshots}" for a in manifest.agents))
