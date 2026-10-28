"""The archive on disk: rooms, runs, the speaker's fMP4 media segments and slides. Transport-free.

Agent tracks are not here: each agent records its own slices (``archive.slices``, decision 0012).

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
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, cast

from pydantic import Field, ValidationError

from ..audio import split_legacy
from ..contracts import SlideFrame, Wire
from .mp4 import OPUS_SILENCE, Sample, TrackConfig, avc_is_keyframe, init_segment, media_segment, opus_duration_us

log = logging.getLogger("talk_tracks.archive")

FORMAT = "talk-tracks-archive"
SEGMENT_US = 6_000_000  # a segment closes at the first sync sample at least this long after its start
TRACK_IDLE_MS = 3_000  # ... or when its track has been silent this long
MAX_FILL_US = 10_000_000  # an audio gap up to this long is filled with silence; a longer one starts a new segment
REORDER = 5  # samples held back to put late groups in order
CLOCK_WAIT_MS = 5_000  # teacher media is held this long for the room clock; none by then means offset 0 (the looper)
HELD_MAX = 4_000  # objects held while waiting for the clock
DEFAULT_AUDIO = TrackConfig(kind="audio", codec="opus")

OnFile = Callable[[str, bool], None]  # (path relative to the root, mutable)


# --- the JSON documents ---------------------------------------------------------------------------------------


class Doc(Wire):
    format: Literal["talk-tracks-archive"] = FORMAT
    v: Literal[1] = 1


class RoomEntry(Wire):
    room: str
    first_wall_ms: int = Field(ge=0)
    last_wall_ms: int = Field(ge=0)
    runs: int = Field(ge=0)


class RoomsIndex(Doc):
    rooms: list[RoomEntry] = Field(default_factory=list[RoomEntry])


class RoomClock(Wire):
    """An object of track ``clock`` in ``talk/<room>/slides``: room time = media timestamp + ``offset_ms``."""

    epoch_ms: int = Field(ge=0, description="Wall time of the room's first broadcast")
    offset_ms: int
    session: str = Field(description="The broadcast's start, wall ms")


class RunEntry(Wire):
    run: str
    session: str | None = None
    started_wall_ms: int = Field(ge=0)
    last_wall_ms: int = Field(ge=0)
    media_first_ms: int | None = Field(default=None, ge=0)
    media_last_ms: int | None = Field(default=None, ge=0)


class RoomIndex(Doc):
    room: str
    epoch_ms: int | None = Field(default=None, ge=0, description="Wall time of the room's first broadcast")
    runs: list[RunEntry] = Field(default_factory=list[RunEntry])


class SegmentEntry(Wire):
    n: int = Field(ge=0)
    init: str
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0, description="Exclusive")
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
    first_media_ms: int = Field(ge=0)
    last_media_ms: int = Field(ge=0)


class RunIndex(Doc):
    room: str
    run: str
    session: str | None = Field(default=None, description="The speaker's broadcast (its clock's session)")
    offset_ms: int = Field(default=0, description="Added to the speaker's media timestamps to get room time")
    started_wall_ms: int = Field(ge=0)
    last_wall_ms: int = Field(ge=0)
    media_first_ms: int | None = Field(default=None, ge=0)
    media_last_ms: int | None = Field(default=None, ge=0)
    media_last_wall_ms: int | None = Field(default=None, ge=0, description="Wall clock of the last teacher media")
    tracks: list[TrackEntry] = Field(default_factory=list[TrackEntry])
    slides: SlidesEntry | None = None


class SlideLine(Wire):
    media_ms: int = Field(ge=0)
    wall_ms: int = Field(ge=0)
    id: int = Field(ge=0)
    at_ms: int = Field(ge=0)
    mime: Literal["image/jpeg", "image/png"]
    file: str


# --- files ------------------------------------------------------------------------------------------------------


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


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
            elif kind == "video" and codec.startswith("avc1") and description:
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


# --- media ------------------------------------------------------------------------------------------------------


@dataclass
class _Pending:
    time_us: int
    data: bytes
    sync: bool


class MediaTrack:
    """One teacher track of one run: samples in, fMP4 segments out."""

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
        if self._samples and sync and time_us - self._samples[0].time_us >= SEGMENT_US:
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

    _warned = False

    def _write(self, name: str, data: bytes) -> None:
        path = self.dir / name
        write_atomic(path, data)
        self.run.archive.reported(path, mutable=False)


# --- runs and rooms ---------------------------------------------------------------------------------------------


class RunArchive:
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
        self.clock_ms = index.media_last_ms or 0
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

    def media(self, name: str, config: TrackConfig, time_us: int, data: bytes, wall_ms: int) -> None:
        self.track(name, config).push(time_us, data, wall_ms)
        ms = time_us // 1000
        i = self.index
        self.clock_ms = max(self.clock_ms, ms)
        self.index = i.model_copy(
            update={
                "media_first_ms": ms if i.media_first_ms is None else min(i.media_first_ms, ms),
                "media_last_ms": max(i.media_last_ms or 0, ms),
                "media_last_wall_ms": wall_ms,
                "last_wall_ms": max(i.last_wall_ms, wall_ms),
            }
        )  # saved with the next segment: not worth a rewrite per sample

    def slide(self, frame: SlideFrame, wall_ms: int) -> bool:
        """Keep a slide frame unless it repeats the last one. True when it was written."""
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
            media_ms=self.clock_ms, wall_ms=wall_ms, id=frame.id, at_ms=frame.at_ms, mime=frame.mime, file=file
        )
        with (folder / "frames.jsonl").open("ab") as f:
            f.write((line.model_dump_json() + "\n").encode())
        self.archive.reported(folder / "frames.jsonl", mutable=True)
        s = self.index.slides
        slides = SlidesEntry(
            frames=(s.frames if s else 0) + 1,
            first_media_ms=s.first_media_ms if s else line.media_ms,
            last_media_ms=line.media_ms,
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

    def save(self) -> None:
        if not self.dirty:
            return
        tracks = [t.entry for t in self.tracks.values()]
        self.index = self.index.model_copy(update={"tracks": tracks})
        write_atomic(self.dir / "run.json", dump(self.index))
        self.archive.reported(self.dir / "run.json", mutable=True)
        self.dirty = False

    def entry(self) -> RunEntry:
        i = self.index
        return RunEntry(
            run=i.run,
            session=i.session,
            started_wall_ms=i.started_wall_ms,
            last_wall_ms=i.last_wall_ms,
            media_first_ms=i.media_first_ms,
            media_last_ms=i.media_last_ms,
        )


@dataclass
class _Teacher:
    catalog: dict[str, TrackConfig] = field(default_factory=dict[str, TrackConfig])
    raw: bytes | None = None


class RoomArchive:
    """One room: its runs (the newest is written to) and the speaker's catalog."""

    def __init__(self, archive: Archive, room: str) -> None:
        self.archive, self.name = archive, room
        self.dir = archive.root / room
        self.teacher = _Teacher()
        self.runs: list[RunEntry] = []
        self.run: RunArchive | None = None
        self.dirty = False
        self.epoch_ms: int | None = None
        self.offset_ms: int | None = None  # None: waiting for the clock of the current teacher broadcast
        self._held: list[tuple[str, bytes, int]] = []
        self._waiting_ms: int | None = None
        self._clock: RoomClock | None = None  # the console's latest clock object, while its slides broadcast is up
        index_path = self.dir / "room.json"
        if index_path.exists():
            try:
                index = RoomIndex.model_validate_json(index_path.read_bytes())
                self.runs, self.epoch_ms = list(index.runs), index.epoch_ms
            except ValidationError:
                log.warning("room %s: room.json unreadable, starting a new run", room)
        if self.runs:
            last = self.dir / self.runs[-1].run / "run.json"
            try:
                self.run = RunArchive(self, RunIndex.model_validate_json(last.read_bytes()))
                log.info("room %s: resuming run %s", room, self.runs[-1].run)
            except (OSError, ValidationError):
                log.warning("room %s: run %s unreadable, starting a new run", room, self.runs[-1].run)

    def _new_run(self, wall_ms: int, session: str | None = None, offset_ms: int = 0) -> RunArchive:
        if self.run is not None:
            self.run.close()
            self.run.save()
            self._update_entry(self.run)
        floor = int(self.runs[-1].run) + 1 if self.runs and self.runs[-1].run.isdigit() else 0
        run_id = str(max(wall_ms, floor))
        index = RunIndex(
            room=self.name,
            run=run_id,
            session=session,
            offset_ms=offset_ms,
            started_wall_ms=wall_ms,
            last_wall_ms=wall_ms,
        )
        self.run = RunArchive(self, index)
        self.runs.append(self.run.entry())
        if self.teacher.raw is not None:
            self.run.catalog(self.teacher.raw)
        self.dirty = True
        log.info("room %s: run %s", self.name, run_id)
        return self.run

    def current(self, wall_ms: int) -> RunArchive:
        return self.run if self.run is not None else self._new_run(wall_ms)

    def _update_entry(self, run: RunArchive) -> None:
        if self.runs and self.runs[-1].run == run.id:
            entry = run.entry()
            if entry != self.runs[-1]:
                self.runs[-1] = entry
                self.dirty = True

    def catalog(self, raw: bytes, wall_ms: int) -> None:
        if raw == self.teacher.raw:
            return
        try:
            parsed = json.loads(raw)
        except ValueError:
            log.warning("room %s: catalog is not JSON", self.name)
            return
        self.teacher = _Teacher(track_configs(parsed), raw)
        self.current(wall_ms).catalog(raw)

    def config(self, track: str) -> TrackConfig | None:
        if self.teacher.raw is None:
            return DEFAULT_AUDIO if track == "audio" else None
        return self.teacher.catalog.get(track)

    def clock(self, clock: RoomClock, wall_ms: int) -> None:
        """The latest object of the speaker console's ``clock`` track (design §4.5). It applies to the next teacher
        broadcast, or to the current one if that is still waiting for its clock."""
        if self.epoch_ms is None or clock.epoch_ms < self.epoch_ms:
            self.epoch_ms = clock.epoch_ms
            self.dirty = True
        self._clock = clock
        if self.offset_ms is None and self._held:
            self._bind(clock, wall_ms)
        elif self.offset_ms is not None and self.run is not None and self.run.index.session != clock.session:
            log.info("room %s: clock session %s waits for its teacher broadcast", self.name, clock.session)

    def slides_gone(self) -> None:
        """The speaker console left: its clock goes with it, so a reload never inherits the old offset."""
        self._clock = None

    def _bind(self, clock: RoomClock, wall_ms: int) -> None:
        """Put the current teacher broadcast on ``clock``: its session is a run (a new one when it changes)."""
        run = self.run
        if run is None or run.index.session != clock.session:
            if run is not None and run.index.session is None and run.index.media_first_ms is None:
                run.index = run.index.model_copy(update={"session": clock.session, "offset_ms": clock.offset_ms})
                run.dirty = True
            else:
                run = self._new_run(wall_ms, clock.session, clock.offset_ms)
        elif run.index.offset_ms != clock.offset_ms:
            log.warning("room %s: session %s changed its offset; keeping the first", self.name, clock.session)
        self.offset_ms = run.index.offset_ms
        log.info("room %s: room time = media time + %d ms (session %s)", self.name, self.offset_ms, clock.session)
        self._release(wall_ms)

    def _release(self, wall_ms: int) -> None:
        held, self._held, self._waiting_ms = self._held, [], None
        for track, payload, at_ms in held:
            self.media(track, payload, at_ms)

    def media(self, track: str, payload: bytes, wall_ms: int) -> None:
        """One object of a teacher track (legacy container: a varint of µs, then the codec payload), written in room
        time. Held until the broadcast's clock is known, for up to ``CLOCK_WAIT_MS``."""
        config = self.config(track)
        if config is None or not payload:
            return
        if self.offset_ms is None and self._clock is not None:
            self._bind(self._clock, wall_ms)
        if self.offset_ms is None:
            if self._waiting_ms is None:
                self._waiting_ms = wall_ms
            if wall_ms - self._waiting_ms < CLOCK_WAIT_MS:
                if len(self._held) < HELD_MAX:
                    self._held.append((track, payload, wall_ms))
                return
            self._no_clock(wall_ms)
        try:
            time_us, data = split_legacy(payload)
        except IndexError:
            return
        assert self.offset_ms is not None
        self.current(wall_ms).media(track, config, time_us + self.offset_ms * 1000, data, wall_ms)

    def _no_clock(self, wall_ms: int) -> None:
        log.info("room %s: the broadcast has no clock track; room time = media time", self.name)
        self.offset_ms = 0
        self._release(wall_ms)

    @property
    def end_ms(self) -> int | None:
        """The latest room time of the speaker's media in the archive."""
        if self.run is not None:
            self._update_entry(self.run)
        ends = [r.media_last_ms for r in self.runs if r.media_last_ms is not None]
        return max(ends) if ends else None

    def slide(self, frame: SlideFrame, wall_ms: int) -> bool:
        return self.current(wall_ms).slide(frame, wall_ms)

    def teacher_gone(self) -> None:
        if self.offset_ms is None and self._held:
            self._no_clock(self._waiting_ms or 0)  # it left before any clock: it had none
        if self.run is not None:
            for track in self.run.tracks.values():
                track.flush()
        self.offset_ms, self._waiting_ms, self._held = None, None, []  # the next broadcast brings its own clock

    def tick(self, wall_ms: int) -> None:
        if self.offset_ms is None and self._waiting_ms is not None and wall_ms - self._waiting_ms >= CLOCK_WAIT_MS:
            self._no_clock(wall_ms)
        if self.run is not None:
            self.run.tick(wall_ms)

    def save(self) -> None:
        if self.run is not None:
            self.run.save()
            self._update_entry(self.run)
        if self.dirty:
            write_atomic(
                self.dir / "room.json", dump(RoomIndex(room=self.name, epoch_ms=self.epoch_ms, runs=self.runs))
            )
            self.archive.reported(self.dir / "room.json", mutable=True)
            self.dirty = False
            self.archive.dirty = True

    def close(self) -> None:
        if self.offset_ms is None and self._held:
            self._no_clock(self._waiting_ms or 0)
        if self.run is not None:
            self.run.close()
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
