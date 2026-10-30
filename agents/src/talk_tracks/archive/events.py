"""The speaker's and the room service's event tracks in the archive, and FETCH for their past (decision 0022).

Every event track is cut in 4 s slices on the room clock with a carry-in at object 0, except the deck (one group per
deck); see ``wiki/design/lane-briefs.md`` §"Namespaces". The room service keeps two kinds:

* **Mirrored:** the speaker's tracks (``room_catalog.speaker_tracks``: deck, slide, ink, marks and pointer on
  ``talk/<room>/slides``). A browser cannot serve history, so the room service subscribes to them, which is free
  since no agent works for it (design §5.4), and writes every object as it arrives, under the speaker's own group and
  object numbers, byte for byte. It answers FETCH for them on ``history_path`` (``talk/<room>/archive/slides``: the
  same track names, group numbers and payloads). Live stays on the speaker's track.
* **Owned:** the tracks the room service publishes itself (``room_catalog.room_service_tracks``: the room's state,
  the comments and everyone else's ink and text marks, written through the listeners' endpoint, ``archive.audience``
  and decision 0024). Like an agent's track, each object goes live and into the archive byte for byte, and a FETCH on
  the same name is answered from the archive. The audience tracks' carry-ins and their re-send when a slide is shown
  need the slide on screen, which the mirrored ``slide`` track supplies.

Which tracks are kept comes from ``room_catalog``'s lists, not from names here, so a track added there is mirrored
or can be owned without a change in this module. Archive folders follow the MoQ names: ``talk/<room>/<rest>`` track
``t`` is kept in ``<room>/<rest>/<t>/`` (``TrackArchive.of``), in the slice store's format. Transport-free:
``archive.relay`` hands in the relay through ``EventRelay``, tests a fake.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from pathlib import Path
from typing import Any, Protocol, cast

from pydantic import ValidationError

from ..contracts import (
    COMMENTS_TRACK,
    INK_TRACK,
    MARKS_TRACK,
    ROOM_TRACK,
    ROOT,
    SLICE_MS,
    SLIDE_TRACK,
    CommentRecord,
    CommentsObject,
    CurrentSlideObject,
    CurrentSlideRecord,
    InkObject,
    InkRecord,
    MarkRecord,
    MarksObject,
    RoomState,
    RoomStateObject,
    RoomStateRecord,
    ShowSlide,
    Wire,
    annotations_path,
    comments_path,
    slice_of,
)
from ..live_slices import LiveOut, Refused, Stats
from ..records import (
    comment_threads,
    comments_carry,
    current_slide,
    encode,
    ink_carry,
    ink_strokes,
    last_record,
    marks_carry,
    text_marks,
)
from ..room_catalog import UNSLICED, CatalogTrack, room_service_tracks, speaker_tracks
from .audience import Audience
from .slices import FINISHED, NORMAL, Slice, SliceExists, SliceObject, TrackArchive

log = logging.getLogger("talk_tracks.archive.events")

HISTORY = "archive"  # talk/<room>/archive/<rest>: where the past of the speaker's talk/<room>/<rest> is fetched
FINISH_IDLE_S = 6.0  # a mirrored slice with no object for this long is over (a slice lasts 4 s), so it is finished

OnFile = Callable[[Path], None]  # a finished slice file, to copy to the bucket


def history_path(namespace: str) -> str:
    """Where the past of a speaker track is fetched: ``talk/<room>/<rest>`` becomes ``talk/<room>/archive/<rest>``,
    with the same track names and group numbers. The room service is the origin there (decision 0022)."""
    root, _, below = namespace.partition("/")
    room, _, rest = below.partition("/")
    if root != ROOT or not room or not rest:
        raise ValueError(f"not a track namespace of a room: {namespace!r}")
    return f"{ROOT}/{room}/{HISTORY}/{rest}"


SliceSource = Callable[[int], Awaitable[Slice]]


class TimedRecord(Protocol):
    """Every event-track record: ``m`` is the room ms it took effect."""

    @property
    def m(self) -> int: ...


class HistoryOut(LiveOut, Protocol):
    """A track the room service publishes (``moq.SlicedOut``): objects numbered by the caller, FETCH from ``serve``."""

    def serve(
        self, source: SliceSource, stats: Stats | None = None, open_slice: Callable[[], int | None] | None = None
    ) -> None: ...


class EventRelay(Protocol):
    """What the room's event tracks need of the relay (``moq.Relay``)."""

    def joined(self, namespace: str, track: str) -> AsyncIterator[tuple[int, int, bytes]]:
        """(group, object, payload) of a track: its current group from object 0 (a Joining FETCH), then live."""
        ...

    async def publish_sliced(self, namespace: str, track: str) -> HistoryOut: ...


async def from_archive(archive: TrackArchive, k: int) -> Slice:
    """Group ``k`` for a FETCH: the slice on disk (finished, or open as far as it has got), else the bucket's copy.
    A slice never archived is refused (a REQUEST_ERROR), never answered with an empty group."""
    found = await archive.read(k)
    if found is None or not any(o.status == NORMAL for o in found.objects):
        raise Refused("not in the archive")
    return found


class MirroredTrack:
    """One speaker track as the room service records it: each object under the speaker's own Location, a slice
    finished when a later one starts, when it has been quiet for ``FINISH_IDLE_S`` (a sliced track) or when the
    speaker leaves. Written once: a group seen first after its object 0 (the join came too late), or already on disk,
    is skipped. An open slice that a stopped room service left behind is started afresh from object 0."""

    def __init__(
        self,
        archive: TrackArchive,
        *,
        sliced: bool,
        on_file: OnFile | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.archive, self.sliced, self._on_file, self._clock = archive, sliced, on_file, clock
        self._open: dict[int, float] = {}  # group -> when its last object came
        self._skipped: set[int] = set()
        self._newest = archive.latest_group()

    def put(self, group: int, object_id: int, payload: bytes) -> bool:
        """Record an object as received. False when it is not kept: a repeat, or a group not kept whole."""
        if group in self._skipped:
            return False
        if group not in self._open:
            if object_id != 0 or self.archive.path(group).exists():
                self._skipped.add(group)
                if object_id != 0:
                    log.info("%s group %d: joined after its object 0, not archived", self.archive.relpath, group)
                return False
            self.archive.discard(group)  # a slice left open by a room service that stopped: written afresh
            if self.sliced:
                for older in [g for g in self._open if g < group]:
                    self._finish(older)
        try:
            self.archive.write(group, SliceObject(object_id, payload))
        except ValueError:
            return False  # a repeat: a resubscription delivers the current group again
        except SliceExists:
            self._skipped.add(group)
            return False
        self._open[group] = self._clock()
        self._newest = group if self._newest is None else max(self._newest, group)
        return True

    def tick(self) -> None:
        """Finish the slices that are over: quiet for ``FINISH_IDLE_S``. A deck stays open until the speaker leaves
        (its images may come one at a time, each before its slide is first shown)."""
        if not self.sliced:
            return
        now = self._clock()
        for group in [g for g, at in self._open.items() if now - at >= FINISH_IDLE_S]:
            self._finish(group)

    def finish_all(self) -> None:
        """The speaker left: every open group is final."""
        for group in sorted(self._open):
            self._finish(group)

    def _finish(self, group: int) -> None:
        self._open.pop(group, None)
        try:
            self.archive.end_group(group)
        except SliceExists:
            return
        if self._on_file is not None:
            self._on_file(self.archive.path(group, FINISHED))

    async def slice(self, k: int) -> Slice:
        return await from_archive(self.archive, k)

    def open_slice(self) -> int | None:
        """One past the newest group archived: FETCH answers from Largest Location = the newest group."""
        return None if self._newest is None else self._newest + 1


type Carry[R] = Callable[[Sequence[R], int], list[R]]  # (every record before slice k, k) -> object 0 of slice k


class ServiceTrack[R: Wire]:
    """A sliced track the room service publishes itself. Each slice of room time is a group: object 0 is ``carry``
    of every record before it, then one object per record; End of Group closes it. Every object goes to the archive
    and live, byte for byte, and a FETCH is answered from the archive. A slice already on disk is never written
    again: a restarted room service continues at the next one, seeded from the newest slice it finds (its carry-in
    and records), and a record in a slice it cannot write shows in the next slice's carry-in.

    ``whole``: seed from every archived slice instead, for a track whose state is more than its carry-in shows (the
    audience's strokes on every slide, not only the one on screen). ``compact`` keeps that state small: applied to
    the records whenever a slice opens, it must leave every later reduction unchanged (``records.ink_strokes``)."""

    def __init__(
        self,
        archive: TrackArchive,
        out: LiveOut,
        *,
        carry: Carry[R],
        parse: Callable[[bytes], list[R]],
        on_file: OnFile | None = None,
        whole: bool = False,
        compact: Callable[[list[R]], list[R]] | None = None,
    ) -> None:
        self.archive, self.out, self._carry, self._on_file, self._compact = archive, out, carry, on_file, compact
        self.records: list[R] = []
        self._open: int | None = None
        self._next = 0
        self._newest = archive.latest_group()
        seeds = archive.groups() if whole else [] if self._newest is None else [self._newest]
        for group in seeds:
            if (seed := archive.read_local(group)) is None:
                continue
            for obj in seed.objects:
                if obj.status == NORMAL and obj.payload:
                    try:
                        self.records += parse(obj.payload)
                    except (ValidationError, ValueError):
                        log.warning("%s: an archived object does not match the contract", archive.relpath)
        if compact is not None:
            self.records = compact(self.records)

    @property
    def open_group(self) -> int | None:
        return self._open

    async def at(self, room_ms: int, *, active: bool) -> None:
        """Room time has reached ``room_ms``: the open slice closes once it is over, and while ``active`` the slice
        of ``room_ms`` opens, so a reader seeking into it finds its carry-in."""
        k = slice_of(room_ms)
        if self._open is not None and k > self._open:
            await self.close()
        if active and self._open is None and (self._newest is None or k > self._newest):
            if self.archive.read_local(k) is not None:
                self._newest = k  # written by another process: continue at the next one
                return
            self._open, self._next, self._newest = k, 0, k
            await self._put(encode(self._carry(self.records, k)))
            if self._compact is not None:
                self.records = self._compact(self.records)

    async def add(self, record: R) -> None:
        """A new record, in the slice of its ``m`` (records come in time order)."""
        await self.at(cast(TimedRecord, record).m, active=True)
        self.records.append(record)
        if self._open is not None:
            await self._put(encode([record]))

    async def close(self) -> None:
        """End the open slice now (End of Group), live and in the archive."""
        k, self._open = self._open, None
        if k is None:
            return
        try:
            self.archive.end_group(k)
            if self._on_file is not None:
                self._on_file(self.archive.path(k, FINISHED))
        except SliceExists:
            log.warning("%s group %d: finished by another process", self.archive.relpath, k)
        try:
            await self.out.end_group(k)
        except TimeoutError:
            log.warning("%s group %d: End of Group timed out", self.archive.relpath, k)

    async def _put(self, payload: bytes) -> None:
        assert self._open is not None
        k, oid = self._open, self._next
        self._next += 1
        self.archive.write(k, SliceObject(oid, payload))
        try:
            await self.out.put(k, oid, payload)
        except TimeoutError:
            log.warning("%s group %d object %d: live write timed out (archived)", self.archive.relpath, k, oid)

    async def slice(self, k: int) -> Slice:
        return await from_archive(self.archive, k)

    def open_slice(self) -> int | None:
        return None if self._newest is None else self._newest + 1


def room_states(payload: bytes) -> list[RoomStateRecord]:
    return list(RoomStateObject.model_validate_json(payload).root)


def ink_records(payload: bytes) -> list[InkRecord]:
    return list(InkObject.model_validate_json(payload).root)


def mark_records(payload: bytes) -> list[MarkRecord]:
    return list(MarksObject.model_validate_json(payload).root)


def comment_records(payload: bytes) -> list[CommentRecord]:
    return list(CommentsObject.model_validate_json(payload).root)


SLIDES_KEPT = 64  # slide records kept for the audience tracks' carry-ins: the slide at a recent slice start


class RoomEvents:
    """One room's event tracks at the room service: the speaker's mirrored while its namespace is announced, each
    with its history served on ``history_path``; the ``room`` track (on air or paused, from the teacher broadcast)
    published and archived; and the audience's tracks (``annotations`` ink and marks, ``comments``), published once the
    speaker shows slides or a listener writes. ``tick`` about once a second with the room's newest media time drives
    them. ``room_now`` is the room time now for what listeners write (None before the room has a clock)."""

    def __init__(
        self,
        room: str,
        relay: EventRelay,
        root: Path,
        *,
        on_file: OnFile | None = None,
        clock: Callable[[], float] = time.monotonic,
        room_now: Callable[[], int | None] = lambda: None,
    ) -> None:
        self.room, self.relay, self.root, self._on_file, self._clock = room, relay, root, on_file, clock
        self.room_now = room_now
        self.speaker = {(t.namespace, t.name): t for t in speaker_tracks(room)}
        self.owned_tracks = {(t.namespace, t.name): t for t in room_service_tracks(room)}
        self.mirrors: dict[tuple[str, str], MirroredTrack] = {}
        self.history: dict[tuple[str, str], HistoryOut] = {}
        self._publishing: dict[tuple[str, str], asyncio.Future[None]] = {}
        self.announced_now: set[str] = set()  # speaker namespaces announced now
        self.owned: dict[tuple[str, str], ServiceTrack[Any]] = {}  # the tracks published so far
        self.state: ServiceTrack[RoomStateRecord] | None = None
        self.audience: Audience | None = None
        self._audience_lock = asyncio.Lock()
        self._audience_tracks: list[ServiceTrack[Any]] = []
        self.slides: list[CurrentSlideRecord] = []  # the newest records of the speaker's slide track
        self._readers: dict[str, list[asyncio.Task[None]]] = {}

    # --- the catalog's view ----------------------------------------------------------------------------------------

    def catalog_tracks(self) -> tuple[CatalogTrack, ...]:
        """The event tracks the catalog lists: the speaker's ones with a history (archived, or mirrored now), and the
        ones this service publishes."""
        return (
            *(t for key, t in self.speaker.items() if key in self.mirrors),
            *(t for key, t in self.owned_tracks.items() if key in self.owned),
        )

    def slides_on_air(self) -> bool:
        return any(ns in self.announced_now for ns, _ in self.speaker)

    # --- the speaker's tracks --------------------------------------------------------------------------------------

    async def restore(self) -> None:
        """At start: serve the history of every speaker track already in the archive (the speaker may never come
        back, but its talk stays fetchable), and of the audience's tracks."""
        for key, track in self.speaker.items():
            archive = self._archive(track)
            if archive.latest_group() is not None:
                await self._mirror(key, track)
        if any(self._archive(t).latest_group() is not None for t in self._audience_specs()):
            await self.audience_tracks()

    def announced(self, namespace: str, active: bool) -> None:
        """A namespace of the room was announced or withdrawn. The speaker's are mirrored while announced."""
        keys = [key for key in self.speaker if key[0] == namespace]
        if not keys:
            return
        if active and namespace not in self._readers:
            self.announced_now.add(namespace)
            log.info("%s: archiving %s", namespace, ", ".join(name for _, name in keys))
            self._readers[namespace] = [
                asyncio.create_task(self._follow(key, self.speaker[key]), name=f"{namespace}/{key[1]}") for key in keys
            ]
            # Slides on air: the audience may draw on them, so its tracks are published (and listed) from now on.
            self._readers[namespace].append(asyncio.create_task(self._audience_soon(), name=f"{namespace}/audience"))
        elif not active and namespace in self._readers:
            self.announced_now.discard(namespace)
            for task in self._readers.pop(namespace):
                task.cancel()
            for key in keys:
                if (mirror := self.mirrors.get(key)) is not None:
                    mirror.finish_all()

    async def _follow(self, key: tuple[str, str], track: CatalogTrack) -> None:
        mirror = await self._mirror(key, track)
        async for group, object_id, payload in self.relay.joined(track.namespace, track.name):
            try:
                mirror.put(group, object_id, payload)
            except OSError:
                log.exception("archiving %s/%s group %d failed", track.namespace, track.name, group)
            if track.name == SLIDE_TRACK:
                await self._slide_object(object_id, payload)

    async def _slide_object(self, object_id: int, payload: bytes) -> None:
        """An object of the speaker's slide track: the slide on screen for the audience's carry-ins; and a slide shown
        re-sends its audience strokes, marks and threads (from a carry-in only when it names a slide not known)."""
        try:
            records = list(CurrentSlideObject.model_validate_json(payload).root)
        except ValidationError:
            log.warning("%s: a slide object does not match the contract", self.room)
            return
        for r in records:
            before = current_slide(self.slides)
            self.slides = [*self.slides[-(SLIDES_KEPT - 1) :], r]
            if not isinstance(r.data, ShowSlide) or (object_id == 0 and r.data == before):
                continue
            try:
                audience = await self.audience_tracks()
                sent = await audience.shown(r.data, r.m)
            except Exception:
                log.exception("%s: re-sending slide %d's audience annotations failed", self.room, r.data.index)
                continue
            if sent:
                log.info("%s: slide %d shown, %d audience records re-sent", self.room, r.data.index, sent)

    async def _mirror(self, key: tuple[str, str], track: CatalogTrack) -> MirroredTrack:
        mirror = self.mirrors.get(key)
        if mirror is None:
            mirror = self.mirrors[key] = MirroredTrack(
                self._archive(track), sliced=track.kind not in UNSLICED, on_file=self._on_file, clock=self._clock
            )
        publishing = self._publishing.get(key)
        if publishing is None:  # once, though restore and a reader may both ask
            publishing = self._publishing[key] = asyncio.ensure_future(self._serve_history(key, track, mirror))
        try:
            await asyncio.shield(publishing)
        except Exception:
            self._publishing.pop(key, None)  # the next reader or restore tries again
            raise
        return mirror

    async def _serve_history(self, key: tuple[str, str], track: CatalogTrack, mirror: MirroredTrack) -> None:
        out = await self.relay.publish_sliced(history_path(track.namespace), track.name)
        out.serve(mirror.slice, None, mirror.open_slice)
        self.history[key] = out

    def _archive(self, track: CatalogTrack) -> TrackArchive:
        return TrackArchive.of(track.namespace, track.name, root=self.root)

    # --- the room service's own tracks -----------------------------------------------------------------------------

    async def room_state(self) -> ServiceTrack[RoomStateRecord]:
        if self.state is None:
            key, track = next((k, t) for k, t in self.owned_tracks.items() if t.name == ROOM_TRACK)
            archive = TrackArchive.of(track.namespace, track.name, root=self.root)
            out = await self.relay.publish_sliced(track.namespace, track.name)
            self.state = ServiceTrack(
                archive, out, carry=lambda rs, _: last_record(rs), parse=room_states, on_file=self._on_file
            )
            out.serve(self.state.slice, None, self.state.open_slice)
            self.owned[key] = self.state
        return self.state

    def _audience_specs(self) -> tuple[CatalogTrack, CatalogTrack, CatalogTrack]:
        """The comments track, then the audience's ink and marks, as ``room_catalog`` lists them."""
        ns = annotations_path(self.room)
        return (
            self.owned_tracks[(comments_path(self.room), COMMENTS_TRACK)],
            self.owned_tracks[(ns, INK_TRACK)],
            self.owned_tracks[(ns, MARKS_TRACK)],
        )

    def slide_at(self, t: int) -> ShowSlide | None:
        """The slide on screen just before room time ``t`` (a carry-in's slide), from the speaker's slide records."""
        return current_slide(r for r in self.slides if r.m < t)

    async def _audience_soon(self) -> None:
        try:
            await self.audience_tracks()
        except Exception:
            log.exception("%s: publishing the audience tracks failed", self.room)

    async def _service_track[R: Wire](
        self,
        spec: CatalogTrack,
        carry: Carry[R],
        parse: Callable[[bytes], list[R]],
        compact: Callable[[list[R]], list[R]],
    ) -> ServiceTrack[R]:
        out = await self.relay.publish_sliced(spec.namespace, spec.name)
        track = ServiceTrack(
            self._archive(spec), out, carry=carry, parse=parse, on_file=self._on_file, whole=True, compact=compact
        )
        out.serve(track.slice, None, track.open_slice)
        self.owned[(spec.namespace, spec.name)] = track
        self._audience_tracks.append(track)
        return track

    async def audience_tracks(self) -> Audience:
        """The audience's annotations and comments, published (live, archived, FETCH from the archive) on first use.
        Their carry-ins hold what is on the slide on screen at the slice start."""
        async with self._audience_lock:
            if self.audience is not None:
                return self.audience
            if not self.slides:
                self.slides = self._archived_slides()
            comments_spec, ink_spec, marks_spec = self._audience_specs()

            def on(k: int) -> ShowSlide | None:
                return self.slide_at(k * SLICE_MS)

            ink = await self._service_track(
                ink_spec, lambda rs, k: ink_carry(rs, on(k)), ink_records, lambda rs: list(ink_strokes(rs).values())
            )
            marks = await self._service_track(
                marks_spec, lambda rs, k: marks_carry(rs, on(k)), mark_records, lambda rs: list(text_marks(rs).values())
            )
            comments = await self._service_track(
                comments_spec, lambda rs, k: comments_carry(rs, on(k)), comment_records, comment_threads
            )
            self.audience = Audience(ink, marks, comments, now=self.room_now)
            log.info("%s: publishing the audience's ink, marks and comments", self.room)
            return self.audience

    def _archived_slides(self) -> list[CurrentSlideRecord]:
        """The newest archived slice of the speaker's slide track (its carry-in and records): what was on screen when
        this service stopped, for the audience's first carry-in after a restart."""
        spec = next(t for t in self.speaker.values() if t.name == SLIDE_TRACK)
        archive = self._archive(spec)
        newest = archive.latest_group()
        found = archive.read_local(newest) if newest is not None else None
        objects: Sequence[SliceObject] = found.objects if found is not None else ()
        out: list[CurrentSlideRecord] = []
        for obj in objects:
            if obj.status == NORMAL and obj.payload:
                try:
                    out += CurrentSlideObject.model_validate_json(obj.payload).root
                except ValidationError:
                    continue
        return out[-SLIDES_KEPT:]

    async def tick(self, room_ms: int | None, *, live: bool) -> None:
        """Once a second. ``room_ms``: the room's newest teacher media time (None before the room has an epoch);
        ``live``: a teacher broadcast is up. The room track says ``on_air`` while it is and ``paused`` once it is
        not, and has a slice for every 4 s on air; so have the audience's tracks, whose slices close once over."""
        for mirror in self.mirrors.values():
            mirror.tick()
        if room_ms is None:
            return
        state = await self.room_state()
        last = state.records[-1].data.state if state.records else None
        at = max(room_ms, state.records[-1].m if state.records else 0)
        if live and last != "on_air":
            await state.add(RoomStateRecord(m=at, data=RoomState(state="on_air")))
        elif not live and last == "on_air":
            await state.add(RoomStateRecord(m=at, data=RoomState(state="paused")))
        await state.at(at, active=live)
        if not live:
            await state.close()
        now = max(at, self.room_now() or 0)
        for track in self._audience_tracks:
            await track.at(now, active=live)

    async def close(self) -> None:
        """Stop reading. Open mirrored slices stay open on disk: a restarted room service writes them afresh."""
        for tasks in self._readers.values():
            for task in tasks:
                task.cancel()
        for tasks in self._readers.values():
            for task in tasks:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        self._readers.clear()
