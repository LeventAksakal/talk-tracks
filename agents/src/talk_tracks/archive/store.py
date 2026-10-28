"""The archive on disk: rooms, runs, the speaker's fMP4 media segments, the HLS playlists and slides. Transport-free.

Agent tracks are not here: each agent records its own slices (``archive.slices``, decision 0012).

Everything is written in room time (design §4.5): room time (ms) = wall time of the media timestamp - ``E`` + the
broadcast's shift. The teacher's hang catalog gives the wall time of PTS zero as its root ``clock``; ``E`` is the
wall time of the room's first teacher media, rounded down to a slice, and each broadcast (one ``clock.wall``) gets one
shift, a whole number of slices, so its media never lands on a slice already used. A broadcast without a ``clock`` is
refused. Each broadcast is a run.

The format is ``wiki/howto/archive.md``. The archiver's MoQ side (``archive.relay``) feeds this module what it
reads; everything here is plain file writing, so tests run it without a relay. Every finished file is reported to
``on_file`` (a path relative to the root, and whether it may still change) so the bucket copy can follow.
"""

from __future__ import annotations

import base64
import binascii
import fnmatch
import hashlib
import heapq
import itertools
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Literal, cast

from pydantic import Field, ValidationError

from ..audio import split_legacy
from ..contracts import SlideFrame, Wire
from . import hls
from .files import write_atomic
from .mp4 import (
    OPUS_SILENCE,
    Sample,
    TrackConfig,
    avc_is_keyframe,
    from_annexb,
    init_segment,
    media_segment,
    opus_duration_us,
)
from .slices import SLICE_MS, slices_end_ms

log = logging.getLogger("talk_tracks.archive")

FORMAT = "talk-tracks-archive"
MOQ_EPOCH_MS = 1_577_836_800_000  # 2020-01-01T00:00:00Z, the zero of hang's clock.wall
GRID_US = SLICE_MS * 1000  # a segment closes at the first sync sample in a later slice of room time
TRACK_IDLE_MS = 3_000  # ... or when its track has been silent this long
MAX_FILL_US = 10_000_000  # an audio gap up to this long is filled with silence; a longer one starts a new segment
REORDER = 5  # samples held back to put late groups in order
LIVE_IDLE_MS = 30_000  # no teacher media this long: the playlists end, even if the relay never said the teacher left

OnFile = Callable[[str, bool], None]  # (path relative to the root, mutable)

__all__ = ["write_atomic"]


# --- the JSON documents ---------------------------------------------------------------------------------------


class Doc(Wire):
    format: Literal["talk-tracks-archive"] = FORMAT
    v: Literal[2] = 2


class RoomEntry(Wire):
    room: str
    first_wall_ms: int = Field(ge=0)
    last_wall_ms: int = Field(ge=0)
    runs: int = Field(ge=0)


class RoomsIndex(Doc):
    rooms: list[RoomEntry] = Field(default_factory=list[RoomEntry])


class RunEntry(Wire):
    run: str
    broadcast: str = Field(description="The teacher broadcast: its hang catalog's clock.wall")
    shift_ms: int = Field(ge=0)
    started_wall_ms: int = Field(ge=0)
    last_wall_ms: int = Field(ge=0)
    media_first_ms: int | None = Field(default=None, ge=0, description="Room time")
    media_last_ms: int | None = Field(default=None, ge=0, description="Room time")


class RoomIndex(Doc):
    room: str
    epoch_ms: int | None = Field(default=None, ge=0, description="E: room time 0, Unix ms")
    shift: dict[str, int] = Field(default_factory=dict[str, int], description="clock.wall -> shift, ms")
    runs: list[RunEntry] = Field(default_factory=list[RunEntry])


class SegmentEntry(Wire):
    n: int = Field(ge=0)
    init: str
    start_ms: int = Field(ge=0, description="Room time")
    end_ms: int = Field(ge=0, description="Room time, exclusive")
    samples: int = Field(ge=1)
    bytes: int = Field(ge=0)


class TrackEntry(Wire):
    track: str
    kind: Literal["audio", "video"]
    codec: str
    mime: str
    timescale: int = 1_000_000
    sample_rate: int | None = None
    channels: int | None = None
    width: int | None = None
    height: int | None = None
    segments: list[SegmentEntry] = Field(default_factory=list[SegmentEntry])


class SlidesEntry(Wire):
    frames: int = Field(ge=0)
    first_ms: int = Field(ge=0, description="Room time")
    last_ms: int = Field(ge=0, description="Room time")


class RunIndex(Doc):
    room: str
    run: str
    broadcast: str = Field(description="The teacher broadcast: its hang catalog's clock.wall")
    origin_ms: int = Field(ge=0, description="Wall time of the broadcast's PTS zero, Unix ms")
    shift_ms: int = Field(ge=0, description="Added to the broadcast's room time (whole slices)")
    started_wall_ms: int = Field(ge=0)
    last_wall_ms: int = Field(ge=0)
    media_first_ms: int | None = Field(default=None, ge=0, description="Room time")
    media_last_ms: int | None = Field(default=None, ge=0, description="Room time")
    tracks: list[TrackEntry] = Field(default_factory=list[TrackEntry])
    slides: SlidesEntry | None = None


class SlideLine(Wire):
    room_ms: int = Field(ge=0)
    wall_ms: int = Field(ge=0)
    id: int = Field(ge=0)
    at_ms: int = Field(ge=0)
    mime: Literal["image/jpeg", "image/png"]
    file: str


# --- files ------------------------------------------------------------------------------------------------------


def dump(doc: Wire) -> bytes:
    return (doc.model_dump_json(indent=1, exclude_none=True) + "\n").encode()


def _object(value: object) -> dict[str, Any]:
    return cast(dict[str, Any], value) if isinstance(value, dict) else {}


def track_configs(catalog: object) -> dict[str, TrackConfig]:
    """The legacy-container renditions of a hang catalog, by track name. Others are skipped."""
    found: dict[str, TrackConfig] = {}
    for kind in ("audio", "video"):
        for track, value in _object(_object(_object(catalog).get(kind)).get("renditions")).items():
            rendition = _object(value)
            if _object(rendition.get("container")).get("kind") != "legacy":
                log.warning("skipping %s track %s: not in the legacy container", kind, track)
                continue
            codec = str(rendition.get("codec", ""))
            try:
                description = bytes.fromhex(str(rendition.get("description") or ""))
            except ValueError:
                description = b""
            if kind == "audio" and codec == "opus":
                found[track] = TrackConfig(
                    "audio",
                    "opus",
                    description,
                    sample_rate=int(rendition.get("sampleRate") or 48_000),
                    channels=int(rendition.get("numberOfChannels") or 1),
                )
            elif kind == "video" and codec.startswith("avc1"):  # no description: Annex B, as @moq/publish sends
                found[track] = TrackConfig(
                    "video",
                    codec,
                    description,
                    width=int(rendition.get("codedWidth") or 0),
                    height=int(rendition.get("codedHeight") or 0),
                )
            else:
                log.warning("skipping %s track %s: codec %s not archived", kind, track, codec or "unknown")
    return found


@dataclass(frozen=True)
class Clock:
    """A hang catalog's root ``clock``: the wall time of the broadcast's PTS zero."""

    key: str  # clock.wall as published: the broadcast's name in tt.shift
    origin_us: int  # Unix µs

    @property
    def origin_ms(self) -> int:
        return self.origin_us // 1000


def broadcast_clock(catalog: object) -> Clock | None:
    """``wall_unix_ms = 1577836800000 + 1000 * wall / timescale + pts_ms`` (design §4.5). None when absent."""
    clock = _object(_object(catalog).get("clock"))
    wall, timescale = clock.get("wall"), clock.get("timescale", 1_000_000)
    if isinstance(wall, bool) or not isinstance(wall, int | float) or wall <= 0:
        return None
    if isinstance(timescale, bool) or not isinstance(timescale, int | float) or timescale <= 0:
        return None
    key = str(int(wall)) if float(wall).is_integer() else str(wall)
    return Clock(key, MOQ_EPOCH_MS * 1000 + round(wall * 1_000_000 / timescale))


def shift_for(first_ms: int, end_ms: int | None) -> int:
    """The shift of a new broadcast whose first media maps to room time ``first_ms``: 0, or the whole slices that put
    it after every slice already used (``end_ms``, exclusive), so no slice id repeats (design §4.5)."""
    if end_ms is None:
        return 0
    boundary = -(-end_ms // SLICE_MS) * SLICE_MS  # a slice partly used is used
    if first_ms >= boundary:
        return 0
    return -(-(boundary - first_ms) // SLICE_MS) * SLICE_MS


# --- media ------------------------------------------------------------------------------------------------------


@dataclass
class _Pending:
    time_us: int
    data: bytes
    sync: bool


class MediaTrack:
    """One teacher track of one run: samples in room time in, fMP4 segments out, cut on the 4 s grid."""

    def __init__(self, run: RunArchive, name: str, config: TrackConfig, entry: TrackEntry | None = None) -> None:
        self.run, self.name, self.config = run, name, config
        self.dir = run.dir / "teacher" / name
        self.entry = entry or self._entry(config, [])
        segments = self.entry.segments
        self._next_n = segments[-1].n + 1 if segments else 0
        self._next_us: int | None = segments[-1].end_ms * 1000 if segments else None
        self._init: str | None = None  # written lazily, and again when the codec setup changes
        self._samples: list[_Pending] = []
        self._heap: list[tuple[int, int, bytes, bool]] = []
        self._tie = 0
        self._warned = False
        self.last_wall_ms = 0

    @property
    def audio(self) -> bool:
        return self.config.kind == "audio"

    def _entry(self, config: TrackConfig, segments: list[SegmentEntry]) -> TrackEntry:
        audio = config.kind == "audio"
        return TrackEntry(
            track=self.name,
            kind=config.kind,
            codec=config.codec,
            mime=config.mime,
            sample_rate=config.sample_rate if audio else None,
            channels=config.channels if audio else None,
            width=None if audio else config.width,
            height=None if audio else config.height,
            segments=segments,
        )

    def reconfigure(self, config: TrackConfig) -> None:
        if config == self.config:
            return
        self.flush()
        self.config = config
        self._init = None
        self.entry = self._entry(config, list(self.entry.segments))
        self.run.dirty = True

    def push(self, time_us: int, data: bytes, wall_ms: int) -> None:
        if not data:
            return
        sync = self.audio or avc_is_keyframe(data, self.config.description)
        self.last_wall_ms = wall_ms
        self._tie += 1
        heapq.heappush(self._heap, (time_us, self._tie, data, sync))
        while len(self._heap) > REORDER:
            time_us, _, data, sync = heapq.heappop(self._heap)
            self._place(time_us, data, sync)

    def flush(self) -> None:
        """Write out everything held: the track went silent, the run ends or the archiver stops."""
        while self._heap:
            time_us, _, data, sync = heapq.heappop(self._heap)
            self._place(time_us, data, sync)
        self._close(None)

    def _end_us(self) -> int | None:
        """The earliest time the next sample may have: audio follows on, video only has to move forward."""
        if not self._samples:
            return self._next_us
        last = self._samples[-1]
        return last.time_us + ((opus_duration_us(last.data) or 20_000) if self.audio else 1)

    def _place(self, time_us: int, data: bytes, sync: bool) -> None:
        end = self._end_us()
        if end is not None and time_us < end - 1_000:
            if end - time_us > 1_000_000 and not self._warned:
                self._warned = True  # room time never goes back; this is a clock bug, not a late sample
                log.warning("%s: media time went back %d ms; dropping samples", self.dir, (end - time_us) // 1000)
            return  # too late to place, or a repeat
        if end is not None and time_us > end + MAX_FILL_US:
            self._close(None)  # a long gap: the next segment starts at this sample
            self._next_us = end = None
        if self._samples and sync and time_us // GRID_US > self._samples[0].time_us // GRID_US:
            self._close(time_us)
        if not self._samples and not sync:
            return  # a video segment opens with a keyframe
        if self.audio and end is not None and time_us > end + 1_000:
            self._fill(end, time_us)  # a gap in the speaker's audio (silence suppression): silence, as played
        self._samples.append(_Pending(time_us, data, sync))

    def _fill(self, start_us: int, until_us: int) -> None:
        silence = OPUS_SILENCE.get(self.config.channels, OPUS_SILENCE[1])
        t = start_us
        while t < until_us - 1_000:
            if self._samples and t // GRID_US > self._samples[0].time_us // GRID_US:
                self._close(t)  # silence is cut on the grid too
            self._samples.append(_Pending(t, silence, True))
            t += 20_000

    def _close(self, next_us: int | None) -> None:
        """Write the held samples as a segment. ``next_us`` is when the following sample starts, if known."""
        if not self._samples:
            return
        pending, self._samples = self._samples, []
        if self.audio:
            last = opus_duration_us(pending[-1].data) or 20_000
        elif next_us is not None:
            last = next_us - pending[-1].time_us
        else:
            last = (pending[-1].time_us - pending[0].time_us) // max(1, len(pending) - 1) or 33_333
        durations = [b.time_us - a.time_us for a, b in itertools.pairwise(pending)] + [last]
        samples = [Sample(p.time_us, max(1, d), p.data, p.sync) for p, d in zip(pending, durations, strict=True)]
        if self._init is None:
            self._init = f"init-{self._next_n}.mp4"
            self._write(self._init, init_segment(self.config))
        n = self._next_n
        data = media_segment(n + 1, samples)
        self._write(f"{n:06d}.m4s", data)
        end_us = samples[-1].time_us + samples[-1].duration_us
        segment = SegmentEntry(
            n=n,
            init=self._init,
            start_ms=samples[0].time_us // 1000,
            end_ms=-(-end_us // 1000),
            samples=len(samples),
            bytes=len(data),
        )
        self.entry = self.entry.model_copy(update={"segments": [*self.entry.segments, segment]})
        self._next_n, self._next_us = n + 1, end_us
        self.run.dirty = True

    def _write(self, name: str, data: bytes) -> None:
        path = self.dir / name
        write_atomic(path, data)
        self.run.archive.reported(path, mutable=False)


# --- runs and rooms ---------------------------------------------------------------------------------------------


class RunArchive:
    """One teacher broadcast in a room."""

    def __init__(self, room: RoomArchive, index: RunIndex) -> None:
        self.room, self.archive = room, room.archive
        self.index = index
        self.dir = room.dir / index.run
        self.dirty = True
        self.tracks: dict[str, MediaTrack] = {}
        for entry in index.tracks:
            config = TrackConfig(
                entry.kind,
                entry.codec,
                sample_rate=entry.sample_rate or 48_000,
                channels=entry.channels or 1,
                width=entry.width or 0,
                height=entry.height or 0,
            )
            self.tracks[entry.track] = MediaTrack(self, entry.track, config, entry)
        self.clock_ms = index.media_last_ms or 0  # the newest room time seen
        self._last_slide: tuple[int, str] | None = None

    @property
    def id(self) -> str:
        return self.index.run

    def track(self, name: str, config: TrackConfig) -> MediaTrack:
        track = self.tracks.get(name)
        if track is None:
            track = self.tracks[name] = MediaTrack(self, name, config)
        else:
            track.reconfigure(config)
        return track

    def media(self, name: str, config: TrackConfig, room_us: int, data: bytes, wall_ms: int) -> None:
        self.track(name, config).push(room_us, data, wall_ms)
        ms = room_us // 1000
        i = self.index
        self.clock_ms = max(self.clock_ms, ms)
        self.index = i.model_copy(
            update={
                "media_first_ms": ms if i.media_first_ms is None else min(i.media_first_ms, ms),
                "media_last_ms": max(i.media_last_ms or 0, ms),
                "last_wall_ms": max(i.last_wall_ms, wall_ms),
            }
        )  # saved with the next segment: not worth a rewrite per sample

    def slide(self, frame: SlideFrame, wall_ms: int) -> bool:
        """Keep a slide frame unless it repeats the last one, at the newest room time. True when it was written."""
        try:
            image = base64.b64decode(frame.data_b64, validate=True)
        except (binascii.Error, ValueError):
            log.warning("skipping slide %d: its image is not base64", frame.id)
            return False
        sha = hashlib.sha256(image).hexdigest()[:16]
        if self._last_slide == (frame.id, sha):
            return False
        self._last_slide = (frame.id, sha)
        folder = self.dir / "slides"
        file = f"{sha}.{'png' if frame.mime == 'image/png' else 'jpg'}"
        if not (folder / file).exists():
            write_atomic(folder / file, image)
            self.archive.reported(folder / file, mutable=False)
        line = SlideLine(
            room_ms=self.clock_ms, wall_ms=wall_ms, id=frame.id, at_ms=frame.at_ms, mime=frame.mime, file=file
        )
        with (folder / "frames.jsonl").open("ab") as f:
            f.write((line.model_dump_json() + "\n").encode())
        self.archive.reported(folder / "frames.jsonl", mutable=True)
        s = self.index.slides
        slides = SlidesEntry(
            frames=(s.frames if s else 0) + 1, first_ms=s.first_ms if s else line.room_ms, last_ms=line.room_ms
        )
        self.index = self.index.model_copy(
            update={"slides": slides, "last_wall_ms": max(self.index.last_wall_ms, wall_ms)}
        )
        self.dirty = True
        return True

    def catalog(self, raw: bytes) -> None:
        write_atomic(self.dir / "teacher" / "catalog.json", raw)
        self.archive.reported(self.dir / "teacher" / "catalog.json", mutable=True)

    def tick(self, wall_ms: int) -> None:
        for track in self.tracks.values():
            if track.last_wall_ms and wall_ms - track.last_wall_ms >= TRACK_IDLE_MS:
                track.flush()
                track.last_wall_ms = 0

    def close(self) -> None:
        for track in self.tracks.values():
            track.flush()

    def save(self) -> bool:
        """Write ``run.json`` if anything changed. True when it did."""
        if not self.dirty:
            return False
        tracks = [t.entry for t in self.tracks.values()]
        self.index = self.index.model_copy(update={"tracks": tracks})
        write_atomic(self.dir / "run.json", dump(self.index))
        self.archive.reported(self.dir / "run.json", mutable=True)
        self.dirty = False
        return True

    def entry(self) -> RunEntry:
        i = self.index
        return RunEntry(
            run=i.run,
            broadcast=i.broadcast,
            shift_ms=i.shift_ms,
            started_wall_ms=i.started_wall_ms,
            last_wall_ms=i.last_wall_ms,
            media_first_ms=i.media_first_ms,
            media_last_ms=i.media_last_ms,
        )


@dataclass
class _Teacher:
    catalog: dict[str, TrackConfig] = field(default_factory=dict[str, TrackConfig])
    raw: bytes | None = None
    clock: Clock | None = None


class RoomArchive:
    """One room: its epoch, the shift of each teacher broadcast, its runs (the newest is written to)."""

    def __init__(self, archive: Archive, room: str) -> None:
        self.archive, self.name = archive, room
        self.dir = archive.root / room
        self.teacher = _Teacher()
        self.live = False  # a teacher broadcast is up
        self._media_wall_ms = 0  # wall clock of the newest teacher media
        self.runs: list[RunEntry] = []
        self.run: RunArchive | None = None
        self.dirty = False
        self.epoch_ms: int | None = None
        self.shift: dict[str, int] = {}
        self._finished: dict[str, RunIndex] = {}  # earlier runs, read once for the playlists
        self._playlists: dict[str, bytes] = {}
        self._playlists_due = True
        self._refused: str | None = None  # the catalog last refused for having no clock
        self._slide: tuple[SlideFrame, int] | None = None  # a slide shown before the broadcast's first media
        self._avcc: dict[str, bytes] = {}  # per Annex B video track: the record from its latest SPS and PPS
        index_path = self.dir / "room.json"
        if index_path.exists():
            try:
                index = RoomIndex.model_validate_json(index_path.read_bytes())
                self.runs, self.epoch_ms, self.shift = list(index.runs), index.epoch_ms, dict(index.shift)
            except ValidationError:
                log.warning("room %s: room.json unreadable, starting afresh", room)
        if self.runs:
            last = self.dir / self.runs[-1].run / "run.json"
            try:
                self.run = RunArchive(self, RunIndex.model_validate_json(last.read_bytes()))
                log.info("room %s: resuming run %s", room, self.runs[-1].run)
            except (OSError, ValidationError):
                log.warning("room %s: run %s unreadable", room, self.runs[-1].run)

    def catalog(self, raw: bytes, wall_ms: int) -> bool:
        """The teacher's hang catalog. False when the broadcast is refused: no ``clock`` (design §4.5)."""
        if raw == self.teacher.raw:
            return self.teacher.clock is not None
        try:
            parsed = json.loads(raw)
        except ValueError:
            log.warning("room %s: catalog is not JSON", self.name)
            return False
        clock = broadcast_clock(parsed)
        self.teacher = _Teacher(track_configs(parsed), raw, clock)
        self._avcc = {}
        self.live = True
        if clock is None:
            if self._refused != raw.decode(errors="replace"):
                self._refused = raw.decode(errors="replace")
                log.error("room %s: refusing the teacher broadcast: its catalog has no clock", self.name)
            return False
        run = self.run
        if run is not None and run.index.broadcast == clock.key:
            run.catalog(raw)  # the same broadcast, reconnected or with a new track
        return True

    def config(self, track: str) -> TrackConfig | None:
        return self.teacher.catalog.get(track)

    def _bind(self, clock: Clock, first_wall_ms: int, wall_ms: int) -> RunArchive:
        """The run of broadcast ``clock``: the current one, or a new one with its shift decided."""
        run = self.run
        if run is not None and run.index.broadcast == clock.key:
            return run
        if self.epoch_ms is None:
            self.epoch_ms = first_wall_ms // SLICE_MS * SLICE_MS
            log.info("room %s: epoch E = %d", self.name, self.epoch_ms)
        shift = self.shift.get(clock.key)
        if shift is None:
            shift = self.shift[clock.key] = shift_for(first_wall_ms - self.epoch_ms, self.archived_end_ms())
            log.info("room %s: broadcast %s, shift %d ms", self.name, clock.key, shift)
        if run is not None:
            run.close()
            run.save()
            self._update_entry(run)
            self._finished[run.id] = run.index
        floor = int(self.runs[-1].run) + 1 if self.runs and self.runs[-1].run.isdigit() else 0
        index = RunIndex(
            room=self.name,
            run=str(max(clock.origin_ms, floor)),
            broadcast=clock.key,
            origin_ms=clock.origin_ms,
            shift_ms=shift,
            started_wall_ms=wall_ms,
            last_wall_ms=wall_ms,
        )
        self.run = RunArchive(self, index)
        self.runs.append(self.run.entry())
        if self.teacher.raw is not None:
            self.run.catalog(self.teacher.raw)
        self.dirty = True
        log.info("room %s: run %s", self.name, index.run)
        return self.run

    def _update_entry(self, run: RunArchive) -> None:
        if self.runs and self.runs[-1].run == run.id:
            entry = run.entry()
            if entry != self.runs[-1]:
                self.runs[-1] = entry
                self.dirty = True

    def media(self, track: str, payload: bytes, wall_ms: int) -> None:
        """One object of a teacher track (legacy container: a varint of µs since PTS zero, then the codec payload),
        written in room time. Dropped while the broadcast is refused."""
        config, clock = self.config(track), self.teacher.clock
        if config is None or clock is None or not payload:
            return
        try:
            pts_us, data = split_legacy(payload)
        except IndexError:
            return
        if config.kind == "video" and not config.description:
            converted = self._annexb(track, config, data)
            if converted is None:
                return
            config, data = converted
        wall_us = clock.origin_us + pts_us
        run = self._bind(clock, wall_us // 1000, wall_ms)
        assert self.epoch_ms is not None
        room_us = wall_us - self.epoch_ms * 1000 + run.index.shift_ms * 1000
        if room_us < 0:
            return  # before the room's epoch: a sample reordered across the first one
        run.media(track, config, room_us, data, wall_ms)
        self._media_wall_ms = wall_ms
        if not self.live:
            self.live, self._playlists_due = True, True
        if self._slide is not None:
            frame, at = self._slide
            self._slide = None
            run.slide(frame, at)

    def _annexb(self, track: str, config: TrackConfig, data: bytes) -> tuple[TrackConfig, bytes] | None:
        """An Annex B access unit as an avc1 sample, with the avcC record from the newest SPS and PPS (a keyframe
        carries them). None until the first parameter sets arrive: nothing before them can be decoded."""
        au = from_annexb(data)
        if au.avcc is not None:
            self._avcc[track] = au.avcc
        avcc = self._avcc.get(track)
        if avcc is None or not au.sample:
            return None
        return replace(config, description=avcc), au.sample

    def archived_end_ms(self) -> int | None:
        """The end of the room time in use: the speaker's media and every agent's slices (exclusive)."""
        if self.run is not None:
            self._update_entry(self.run)
        ends = [r.media_last_ms + 1 for r in self.runs if r.media_last_ms is not None]
        agents = slices_end_ms(self.archive.root, self.name)
        if agents is not None:
            ends.append(agents)
        return max(ends) if ends else None

    def slide(self, frame: SlideFrame, wall_ms: int) -> bool:
        """A slide frame, placed at the newest room time of the current broadcast. One shown before the broadcast's
        first media waits for it; only the latest such frame is kept."""
        run = self.run
        clock = self.teacher.clock
        if run is None or clock is None or run.index.broadcast != clock.key or run.index.media_last_ms is None:
            self._slide = (frame, wall_ms)
            return False
        return run.slide(frame, wall_ms)

    def teacher_gone(self) -> None:
        if self.run is not None:
            for track in self.run.tracks.values():
                track.flush()
        self.live = False
        self.teacher = _Teacher()
        self._playlists_due = True

    def tick(self, wall_ms: int) -> None:
        if self.run is not None:
            self.run.tick(wall_ms)
        if self.live and self._media_wall_ms and wall_ms - self._media_wall_ms >= LIVE_IDLE_MS:
            self.live, self._playlists_due = False, True

    def save(self) -> None:
        if self.run is not None:
            if self.run.save():
                self._playlists_due = True
            self._update_entry(self.run)
        if self.dirty:
            index = RoomIndex(room=self.name, epoch_ms=self.epoch_ms, shift=self.shift, runs=self.runs)
            write_atomic(self.dir / "room.json", dump(index))
            self.archive.reported(self.dir / "room.json", mutable=True)
            self.dirty = False
            self.archive.dirty = True
        if self._playlists_due:
            self._playlists_due = False
            self._write_playlists()

    def _run_indexes(self) -> list[RunIndex]:
        found: list[RunIndex] = []
        for entry in self.runs:
            if self.run is not None and entry.run == self.run.id:
                found.append(self.run.index)
                continue
            index = self._finished.get(entry.run)
            if index is None:
                try:
                    index = RunIndex.model_validate_json((self.dir / entry.run / "run.json").read_bytes())
                except (OSError, ValidationError):
                    continue
                self._finished[entry.run] = index
            found.append(index)
        return found

    def _write_playlists(self) -> None:
        if self.epoch_ms is None:
            return
        files = hls.playlists(self.epoch_ms, self._run_indexes(), live=self.live)
        for name, text in files.items():
            data = text.encode()
            if self._playlists.get(name) != data:
                write_atomic(self.dir / name, data)
                self._playlists[name] = data
                self.archive.reported(self.dir / name, mutable=True)

    def close(self) -> None:
        if self.run is not None:
            self.run.close()
        self.live = False
        self._playlists_due = True
        self.save()

    def entry(self) -> RoomEntry | None:
        if not self.runs:
            return None
        return RoomEntry(
            room=self.name,
            first_wall_ms=self.runs[0].started_wall_ms,
            last_wall_ms=max(r.last_wall_ms for r in self.runs),
            runs=len(self.runs),
        )


class Archive:
    """The archive root. Call ``tick`` about once a second: it closes idle segments and saves the indexes."""

    def __init__(self, root: Path, *, on_file: OnFile | None = None) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self._on_file = on_file
        self.rooms: dict[str, RoomArchive] = {}
        self._known: dict[str, RoomEntry] = {}
        self.dirty = False
        try:
            index = RoomsIndex.model_validate_json((root / "rooms.json").read_bytes())
            self._known = {r.room: r for r in index.rooms}
        except (OSError, ValidationError):
            pass

    def reported(self, path: Path, *, mutable: bool) -> None:
        if self._on_file is not None:
            self._on_file(path.relative_to(self.root).as_posix(), mutable)

    def known_rooms(self) -> list[str]:
        return sorted({*self._known, *self.rooms})

    def room(self, name: str) -> RoomArchive:
        room = self.rooms.get(name)
        if room is None:
            room = self.rooms[name] = RoomArchive(self, name)
        return room

    def tick(self, wall_ms: int) -> None:
        for room in self.rooms.values():
            room.tick(wall_ms)
        self.save()

    def save(self) -> None:
        for room in self.rooms.values():
            room.save()
        if self.dirty:
            for room in self.rooms.values():
                entry = room.entry()
                if entry is not None:
                    self._known[room.name] = entry
            index = RoomsIndex(rooms=sorted(self._known.values(), key=lambda r: r.room))
            write_atomic(self.root / "rooms.json", dump(index))
            self.reported(self.root / "rooms.json", mutable=True)
            self.dirty = False

    def close(self) -> None:
        for room in self.rooms.values():
            room.close()
        self.save()


class RoomFilter:
    """Which rooms to archive: glob patterns to keep (default all) and to skip (a looped demo room)."""

    def __init__(self, keep: str = "*", skip: str = "") -> None:
        self.keep = [p.strip() for p in keep.split(",") if p.strip()] or ["*"]
        self.skip = [p.strip() for p in skip.split(",") if p.strip()]

    def __call__(self, room: str) -> bool:
        return any(fnmatch.fnmatchcase(room, p) for p in self.keep) and not any(
            fnmatch.fnmatchcase(room, p) for p in self.skip
        )
