"""Sliced agent tracks (design §4): live slices on the room clock, recorded as sent, and back-filled on FETCH.

Group k of a track holds the records whose room time falls in [k·4 s, (k+1)·4 s). Object 0 is the carry-in, each
later object one new record, End of Group closes the slice; End of Track comes only when the room is closed.
Objects are MSF event-timeline records (``records``). ``SlicedTrack`` owns the numbering and writes every object
twice: to the live track (``LiveOut``) and to the track's archive (``TrackArchive``), byte for byte, so a FETCH of a
slice gets exactly what subscribers got. Transport-free: tests drive it without a relay.

* **Live:** a record goes into the open slice when it is produced. The open slice is the one holding the agent's
  input watermark (``Watermark``): the newest teacher media it has processed, in room time, never its own wall
  clock. While idle its edge is the newest teacher media anyone has seen (``RoomTime.edge``).
* **Never twice:** a group already in the archive is never written live again. A restarted agent therefore starts at
  the slice after its newest one, and live output that resumes inside a back-filled slice waits for the next one
  (what it made meanwhile shows in that slice's carry-in).
* **Capped:** past the room's spend cap, each live slice is a carry-in marked ``capped`` and nothing else.
* **Start mid-slice:** a track that cannot hear the past (captions) marks the first carry-in of a run with ``from``.
* **Last leave:** ``finish`` lets the open slice run to its end (at most 4 s) and opens no new one, so the archive
  holds it whole.
* **FETCH:** a slice in the archive is served as it is; the open slice is served with the objects it has so far.
  A slice below the open one that was never produced is back-filled by the agent's ``produce`` (translation only),
  one at a time with at most ``BACKFILL_WAITING`` more waiting, stored write-once and served. Anything else is
  refused (``Refused``, a REQUEST_ERROR on the wire): never an empty or placeholder group.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Protocol

from .archive.slices import Slice, SliceExists, SliceObject, TrackArchive
from .contracts import SLICE_MS, AgentInfo, OutlineRecord, slice_of
from .llm.ledger import BudgetExceededError
from .records import Data, carry_in, encode, record

log = logging.getLogger("talk_tracks")

HOLD_S = 8.0  # the watermark counts as current this long after the last input moved it, then the slice closes
BACKFILL_WAITING = 2  # back-fills queued behind the one running; more are refused as busy


class Refused(Exception):
    """A FETCH this track does not answer with objects: the reason goes into the REQUEST_ERROR."""


class LiveOut(Protocol):
    """The live track: objects numbered by the caller, each group closed explicitly."""

    def subscribed(self) -> bool: ...

    async def put(self, group: int, object_id: int, payload: bytes) -> None: ...

    async def end_group(self, group: int) -> None: ...

    async def end_track(self) -> None: ...


class Watermark:
    """The newest room time an input reported. ``edge`` gives the room's newest teacher media for when the agent
    itself is idle."""

    def __init__(
        self,
        *,
        hold_s: float = HOLD_S,
        edge: Callable[[], int | None] = lambda: None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._hold = hold_s
        self._clock = clock
        self.edge = edge
        self._ms: int | None = None
        self._at = 0.0

    def observe(self, room_ms: int) -> None:
        """Only a newer time counts: an input that repeats itself (a stopped speaker's edge) lets it go stale."""
        if self._ms is None or room_ms > self._ms:
            self._ms, self._at = room_ms, self._clock()

    def now(self) -> int | None:
        """The watermark; None before any input, and once the inputs have been quiet for ``hold_s``."""
        if self._ms is None or self._clock() - self._at > self._hold:
            return None
        return self._ms

    def room_edge(self) -> int | None:
        """The newest room time known: this agent's watermark, or the teacher's newest media."""
        known = [t for t in (self._ms, self.edge()) if t is not None]
        return max(known) if known else None


Produce = Callable[[int], Awaitable[tuple[Sequence[Data], Sequence[Data]]]]  # k -> (carry-in, records)


@dataclass
class Stats:
    """What the room service shows per agent (design §5.10, ``tt.status``)."""

    fetches_served: int = 0
    backfills: int = 0


class SlicedTrack:
    def __init__(
        self,
        info: AgentInfo,
        out: LiveOut,
        archive: TrackArchive,
        carry: Callable[[], Sequence[Data]],
        *,
        clock: Watermark | None = None,
        marks_from: bool = False,
    ) -> None:
        self.info = info
        self.out = out
        self.archive = archive
        self.clock = clock or Watermark()
        self.capped = False
        self.paused = True  # until the first input: an idle agent produces no slices
        self.finishing = False  # the last viewer left: the open slice runs to its end, no new one opens
        self.marks_from = marks_from
        self.stats = Stats()
        self._slice_ended = asyncio.Event()
        self.carry = carry  # the core's carry-in, set once the core is seeded
        self._open: int | None = None
        self._next_object = 0
        self._run_started = False  # a slice opened since the last pause
        newest = archive.latest_group()
        self._floor = -1 if newest is None else newest  # live output only ever goes above this
        self._lock = asyncio.Lock()
        self._one = asyncio.Lock()  # one back-fill at a time
        self._filling: dict[int, asyncio.Future[Slice]] = {}

    @property
    def open_slice(self) -> int | None:
        return self._open

    def seed_objects(self) -> list[bytes]:
        """The newest slice this track has, for a restarted agent to take its state from (decision 0009). Live output
        continues at the slice after it."""
        found = None if self._floor < 0 else self.archive.read_local(self._floor)
        return payloads(found) if found else []

    # --- live --------------------------------------------------------------------------------------------------

    async def tick(self) -> None:
        """Follow the watermark: close the slice it left, open the one it is in. Call often (``run_clock``)."""
        async with self._lock:
            now = self.clock.now()
            if self.paused or now is None:
                await self._close()
                return
            await self._at(slice_of(now))

    async def item(self, data: Data) -> None:
        """Publish a record into the open slice. While none is open (the watermark is inside a slice produced
        before) the record is not published; the next carry-in shows its state. Wakes a paused track."""
        if self.capped:
            return
        async with self._lock:
            self.paused = False
            now = self.clock.now()
            if now is not None:
                await self._at(slice_of(now))
            if self._open is not None:
                await self._put(encode([record(data)]))

    def wake(self) -> None:
        self.paused = False

    async def pause(self) -> None:
        """Nobody subscribes: close the slice and produce none until the next input."""
        async with self._lock:
            self.paused = True
            self.finishing = False
            self._run_started = False
            await self._close()

    async def finish(self) -> None:
        """The last viewer left: open no new slice, and return once the open one has ended, so it is whole in the
        archive. At most one slice of work (4 s), less if the inputs stop."""
        self.finishing = True
        if self._open is None:
            return
        self._slice_ended.clear()
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._slice_ended.wait(), SLICE_MS / 1000 + 1)

    async def cap(self) -> None:
        """The room's spend cap is reached: from the next slice on, each slice is a capped carry-in only."""
        async with self._lock:
            self.capped = True
            await self._close()

    async def end(self) -> None:
        """The room is closed: the open slice ends the track."""
        async with self._lock:
            k = self._open
            if k is not None:
                self._open = None
                self.archive.end_group(k, end_of_track=True)
            await self.out.end_track()

    async def run_clock(self, every_s: float = 0.2) -> None:
        """Keep slices on time while nothing is produced. A capped track keeps slicing while subscribed, so the
        viewer sees why it is silent."""
        while True:
            await asyncio.sleep(every_s)
            if self.capped:
                self.paused = not self.out.subscribed()
            await self.tick()

    async def _at(self, k: int) -> None:
        if self._open == k:
            return
        await self._close()
        if self.finishing:
            return
        if k <= self._floor or self.archive.read_local(k) is not None:
            return  # produced before (an earlier run, a back-fill): wait for the next slice
        now = self.clock.now()
        from_ms = None
        if self.marks_from and not self._run_started and now is not None and now > k * SLICE_MS:
            from_ms = now  # the first slice of a run: nothing from before this
        self._run_started = True
        self._floor = k
        self._open, self._next_object = k, 0
        await self._put(carry_in(k, self.carry(), capped=self.capped, from_ms=from_ms))

    async def _put(self, data: bytes) -> None:
        assert self._open is not None
        k, o = self._open, self._next_object
        self._next_object += 1
        try:
            self.archive.write(k, SliceObject(object_id=o, payload=data))
        except SliceExists:
            # Opening checks the archive, so only room time that went back (or a second live publisher) gets here.
            # Room time never goes back (design §4.5): this is a bug, so say so and send nothing.
            log.error(
                "%s: SLICE %d ALREADY EXISTS in the archive: room time went back or two agents publish it; "
                "object %d not sent",
                self.info.name,
                k,
                o,
                exc_info=True,
            )
            return
        try:
            await self.out.put(k, o, data)
        except Exception as exc:  # the record stands: a FETCH still serves what the live track could not send
            log.warning("%s: live object %d/%d not sent: %s", self.info.name, k, o, exc)

    async def _close(self) -> None:
        k = self._open
        if k is None:
            return
        self._open = None
        try:
            self.archive.end_group(k)
        except SliceExists:
            log.error("%s: slice %d was finished by another process", self.info.name, k, exc_info=True)
        self._slice_ended.set()
        await self.out.end_group(k)

    # --- history -----------------------------------------------------------------------------------------------

    def current_slice(self) -> int | None:
        """The open slice, or while idle the slice of the room's newest teacher media."""
        if self._open is not None:
            return self._open
        edge = self.clock.room_edge()
        return None if edge is None else slice_of(edge)

    async def slice(self, k: int, produce: Produce | None) -> Slice:
        """Group k for a FETCH: from the archive (disk, then the bucket), the open slice as far as it has got, else
        back-filled now and stored once. Raises ``Refused`` when it cannot be served."""
        if k < 0:
            raise Refused("no such slice")
        found = await self.archive.read(k)
        if found is not None:
            return found
        current = self.current_slice()
        if current is None:
            raise Refused("room time is not known yet")
        if k >= current:
            raise Refused("the open slice or later")
        if produce is None:
            raise Refused("never produced, and this track does not back-fill")
        if self.capped:
            raise Refused("the room reached its spend cap")
        running = self._filling.get(k)
        if running is None:
            if len(self._filling) > BACKFILL_WAITING:
                raise Refused("busy")
            running = asyncio.ensure_future(self._backfill(k, produce))
            self._filling[k] = running
            running.add_done_callback(lambda _: self._filling.pop(k, None))
        return await asyncio.shield(running)

    async def _backfill(self, k: int, produce: Produce) -> Slice:
        async with self._one:
            if (found := await self.archive.read(k)) is not None:
                return found  # made while this one waited
            try:
                carry, items = await produce(k)
            except BudgetExceededError as exc:
                log.warning("%s: no back-fill of slice %d: %s", self.info.name, k, exc)
                raise Refused("out of back-fill budget") from exc
            except LookupError as exc:
                raise Refused(f"no input: {exc}"[:100]) from exc
        objects = [carry_in(k, carry)] + [encode([record(d)]) for d in items]
        stored, created = self.archive.create(k, [SliceObject(object_id=o, payload=p) for o, p in enumerate(objects)])
        if not created:
            log.info("%s: slice %d was written meanwhile: serving that copy", self.info.name, k)
            return stored
        self.stats.backfills += 1
        log.info("%s: back-filled slice %d with %d records", self.info.name, k, len(items))
        return stored


class SnapshotTrack:
    """The outline (design §4.3): each revision is a group of one object, the whole outline as a timeline. While
    subscribed the newest revision is repeated once per slice, so a late joiner always finds a group young enough
    for moq-relay to deliver (it drops groups older than 5 s). Group ids follow room time, so they never repeat
    across restarts."""

    def __init__(self, info: AgentInfo, out: LiveOut, archive: TrackArchive, *, clock: Watermark | None = None) -> None:
        self.info = info
        self.out = out
        self.archive = archive
        self.clock = clock or Watermark()
        self.stats = Stats()
        newest = archive.latest_group()
        self._last = -1 if newest is None else newest
        self._payload: bytes | None = None
        self._lock = asyncio.Lock()

    def seed_object(self) -> bytes | None:
        """The newest revision on record, for a restarted agent to carry on from."""
        found = None if self._last < 0 else self.archive.read_local(self._last)
        objects = payloads(found) if found else []
        return objects[-1] if objects else None

    async def publish(self, records: Sequence[OutlineRecord]) -> None:
        async with self._lock:
            self._payload = encode(records)
            await self._write(self._payload)

    async def run_clock(self, every_s: float = 0.5) -> None:
        while True:
            await asyncio.sleep(every_s)
            edge = self.clock.room_edge()
            if self._payload is None or edge is None or not self.out.subscribed() or slice_of(edge) <= self._last:
                continue
            async with self._lock:
                await self._write(self._payload)

    async def _write(self, data: bytes) -> None:
        edge = self.clock.room_edge()
        k = max(self._last + 1, slice_of(edge) if edge is not None else 0)
        while self.archive.read_local(k) is not None:
            k += 1
        self._last = k
        self.archive.write(k, SliceObject(object_id=0, payload=data))
        self.archive.end_group(k)
        try:
            await self.out.put(k, 0, data)
            await self.out.end_group(k)
        except Exception as exc:
            log.warning("%s: outline revision %d not sent: %s", self.info.name, k, exc)

    async def slice(self, k: int) -> Slice:
        """A revision for a FETCH: only what was published (an outline is never back-filled)."""
        found = await self.archive.read(k) if k >= 0 else None
        if found is None:
            raise Refused("no revision in this group")
        return found


def payloads(found: Slice) -> list[bytes]:
    """The objects of a slice, end marker left out."""
    return [o.payload for o in found.objects if o.payload]
