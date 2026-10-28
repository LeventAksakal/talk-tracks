"""Sliced agent tracks (decision 0012): live slices on the room clock, recorded as sent, and back-filled on FETCH.

Group k of a track covers room time [k·4 s, (k+1)·4 s) (design §4.5). Object 0 is the carry-in, the items follow,
End of Group closes the slice and End of Track the talk. ``SlicedTrack`` owns the numbering and writes every object
twice: to the live track (``LiveOut``) and to the track's archive (``TrackArchive``), byte for byte, so a FETCH of a
slice gets exactly what subscribers got. Transport-free: tests drive it without a relay.

* **Live:** an item goes into the slice open when it is produced. The slice follows a ``MediaClock`` that the
  agent's inputs set (audio timestamps, the captions it reads, slide times) and that runs on between them.
* **Never twice:** a group already in the archive is never written live again. A restarted agent therefore starts at
  the slice after its newest one, and live output that resumes inside a back-filled slice waits for the next one
  (what it made meanwhile shows in that slice's carry-in).
* **Capped:** past the room's spend cap, each live slice is a carry-in marked ``capped`` and nothing else.
* **Last leave:** ``finish`` lets the open slice run to its end on the clock (at most 4 s) and opens no new one, so
  the archive holds it whole.
* **FETCH:** a slice in the archive is served as it is; the open slice is served with the objects it has so far.
  A slice that was never produced is back-filled once by the agent's ``produce`` (translation only), stored
  write-once and served. Anything else is refused (``Refused``, a REQUEST_ERROR on the wire): never an empty or
  placeholder group.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable, Sequence
from typing import Literal, Protocol

from .archive.slices import Slice, SliceExists, SliceObject, TrackArchive
from .contracts import ENVELOPE, SLICE_MS, AgentInfo, Body, Carry, Envelope, Item, Usage, slice_of
from .llm.ledger import BudgetExceededError

log = logging.getLogger("talk_tracks")


class Refused(Exception):
    """A FETCH this track does not answer with objects: the reason goes into the REQUEST_ERROR."""


HOLD_S = 8.0  # the clock runs on this long past the last media time an input gave, then stops (the speaker left)


class LiveOut(Protocol):
    """The live track: objects numbered by the caller, each group closed explicitly."""

    def subscribed(self) -> bool: ...

    async def put(self, group: int, object_id: int, payload: bytes) -> None: ...

    async def end_group(self, group: int) -> None: ...

    async def end_track(self) -> None: ...


class MediaClock:
    """Room time (the speaker's media time plus the room clock's offset), from the newest time an input reported,
    running on with the wall clock."""

    def __init__(self, *, hold_s: float | None = HOLD_S, clock: Callable[[], float] = time.monotonic) -> None:
        self._hold = hold_s
        self._clock = clock
        self._media_ms: int | None = None
        self._at = 0.0

    def observe(self, media_ms: int) -> None:
        now = self.now()
        if now is None or media_ms > now:  # inputs lag the clock a little: never step it back
            self._media_ms, self._at = media_ms, self._clock()

    def now(self) -> int | None:
        """None before any input, and once the inputs have been quiet for ``hold_s``."""
        if self._media_ms is None:
            return None
        elapsed = self._clock() - self._at
        if self._hold is not None and elapsed > self._hold:
            return None
        return self._media_ms + int(elapsed * 1000)

    def now_or(self, default: int) -> int:
        now = self.now()
        return default if now is None else now


Produce = Callable[[int], Awaitable[tuple[Carry, Sequence[Item]]]]


class SlicedTrack:
    def __init__(
        self,
        info: AgentInfo,
        out: LiveOut,
        archive: TrackArchive,
        usage: Callable[[], Usage],
        carry: Callable[[], Carry],
        *,
        clock: MediaClock | None = None,
        wall_ms: Callable[[], int] = lambda: time.time_ns() // 1_000_000,
    ) -> None:
        self.info = info
        self.out = out
        self.archive = archive
        self.clock = clock or MediaClock()
        self.capped = False
        self.paused = True  # until the first input: an idle agent produces no slices
        self.finishing = False  # the last viewer left: the open slice runs to its end, no new one opens
        self._slice_ended = asyncio.Event()
        self._usage = usage
        self.carry = carry  # the core's carry-in, set once the core is seeded
        self._wall = wall_ms
        self._open: int | None = None
        self._next_object = 0
        newest = archive.latest_group()
        self._floor = -1 if newest is None else newest  # live output only ever goes above this
        self._lock = asyncio.Lock()
        self._filling: dict[int, asyncio.Future[Slice]] = {}

    @property
    def open_slice(self) -> int | None:
        return self._open

    def seed_envelopes(self) -> list[Envelope]:
        """The newest slice this track has, for a restarted agent to take its state from (decision 0009). Live output
        continues at the slice after it."""
        found = None if self._floor < 0 else self.archive.read_local(self._floor)
        return envelopes_of(found) if found else []

    # --- live --------------------------------------------------------------------------------------------------

    async def tick(self) -> None:
        """Follow the clock: close the slice it left, open the one it is in. Call often (``run_clock``)."""
        async with self._lock:
            now = self.clock.now()
            if self.paused or now is None:
                await self._close()
                return
            await self._at(slice_of(now))

    async def item(self, body: Item) -> None:
        """Publish an item into the open slice. While none is open (the clock is inside a slice produced before) the
        item is not published; the next carry-in shows its state. Wakes a paused track."""
        if self.capped:
            return
        async with self._lock:
            self.paused = False
            now = self.clock.now()
            if now is not None:
                await self._at(slice_of(now))
            if self._open is not None:
                await self._write(body)

    def wake(self) -> None:
        self.paused = False

    async def pause(self) -> None:
        """Nobody subscribes: close the slice and produce none until the next input."""
        async with self._lock:
            self.paused = True
            self.finishing = False
            await self._close()

    async def finish(self) -> None:
        """The last viewer left: open no new slice, and return once the open one has ended on the clock, so it is
        whole in the archive. At most one slice of work (4 s), less if the inputs stop."""
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
        """The talk is over: the open slice ends the track."""
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
        self._floor = k
        self._open, self._next_object = k, 0
        await self._put(self._envelope(k, "carry", self.carry(), capped=self.capped))

    async def _write(self, body: Item) -> None:
        assert self._open is not None
        await self._put(self._envelope(self._open, "item", body))

    async def _put(self, data: bytes) -> None:
        assert self._open is not None
        k, o = self._open, self._next_object
        self._next_object += 1
        try:
            self.archive.write(k, SliceObject(object_id=o, payload=data))
        except SliceExists:
            # Opening checks the archive, so only a room clock that went back (or a second live publisher) gets
            # here. The room clock never goes back (design §4.5): this is a bug, so say so and send nothing.
            log.error(
                "%s: SLICE %d ALREADY EXISTS in the archive: the room clock went back or two agents publish it; "
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
        self.archive.end_group(k)
        self._slice_ended.set()
        await self.out.end_group(k)

    def _envelope(self, k: int, kind: Literal["carry", "item"], body: Body, *, capped: bool = False) -> bytes:
        env = Envelope(
            agent=self.info, slice=k, kind=kind, capped=capped, at_ms=self._wall(), usage=self._usage(), body=body
        )
        return ENVELOPE.dump_json(env)

    # --- history -----------------------------------------------------------------------------------------------

    async def slice(self, k: int, produce: Produce | None) -> Slice:
        """Group k for a FETCH: from the archive (disk, then the bucket), the open slice as far as it has got, else
        back-filled now and stored once. Raises ``Refused`` when it cannot be served."""
        if k < 0:
            raise Refused("no such slice")
        found = await self.archive.read(k)
        if found is not None:
            return found
        if self._open is not None and k >= self._open:
            raise Refused("the open slice or later")
        now = self.clock.now()
        if now is not None and k >= slice_of(now):
            raise Refused("not yet")
        if produce is None:
            raise Refused("never produced, and this track does not back-fill")
        if self.capped:
            raise Refused("the room reached its spend cap")
        running = self._filling.get(k)
        if running is None:
            running = asyncio.ensure_future(self._backfill(k, produce))
            self._filling[k] = running
            running.add_done_callback(lambda _: self._filling.pop(k, None))
        return await asyncio.shield(running)

    async def _backfill(self, k: int, produce: Produce) -> Slice:
        try:
            carry, items = await produce(k)
        except BudgetExceededError as exc:
            log.warning("%s: no back-fill of slice %d: %s", self.info.name, k, exc)
            raise Refused("out of back-fill budget") from exc
        except LookupError as exc:
            raise Refused(f"no input: {exc}") from exc
        objects = [self._envelope(k, "carry", carry)] + [self._envelope(k, "item", body) for body in items]
        async with self._lock:
            try:  # write-once: the archive creates a slice only when no process has it yet
                for o, data in enumerate(objects):
                    self.archive.write(k, SliceObject(object_id=o, payload=data))
                stored = self.archive.end_group(k)
            except SliceExists:
                stored = None
        if stored is None:
            first = await self.archive.read(k)
            if first is None:
                raise Refused("written by another process, and gone again")
            log.info("%s: slice %d was written meanwhile: serving that copy", self.info.name, k)
            return first
        log.info("%s: back-filled slice %d with %d items", self.info.name, k, len(items))
        return stored


class SnapshotTrack:
    """The outline (design §4.3): each revision is a group of one object. While subscribed the newest revision is
    repeated once per slice, so a late joiner always finds a group young enough for moq-relay to deliver (it drops
    groups older than 5 s). Group ids come from the room clock, so they never repeat across restarts."""

    def __init__(
        self,
        info: AgentInfo,
        out: LiveOut,
        archive: TrackArchive,
        usage: Callable[[], Usage],
        *,
        clock: MediaClock | None = None,
        wall_ms: Callable[[], int] = lambda: time.time_ns() // 1_000_000,
    ) -> None:
        self.info = info
        self.out = out
        self.archive = archive
        self.clock = clock or MediaClock()
        self._usage = usage
        self._wall = wall_ms
        newest = archive.latest_group()
        self._last = -1 if newest is None else newest
        self._body: Body | None = None
        self._lock = asyncio.Lock()

    def seed(self) -> Envelope | None:
        """The newest revision on record, for a restarted agent to carry on from."""
        found = None if self._last < 0 else self.archive.read_local(self._last)
        envelopes = envelopes_of(found) if found else []
        return envelopes[-1] if envelopes else None

    async def publish(self, body: Body) -> None:
        async with self._lock:
            self._body = body
            await self._write(body)

    async def run_clock(self, every_s: float = 0.5) -> None:
        while True:
            await asyncio.sleep(every_s)
            now = self.clock.now()
            if self._body is not None and now is not None and self.out.subscribed() and slice_of(now) > self._last:
                async with self._lock:
                    await self._write(self._body)

    async def _write(self, body: Body) -> None:
        now = self.clock.now()
        k = max(self._last + 1, slice_of(now) if now is not None else 0)
        while self.archive.read_local(k) is not None:
            k += 1
        self._last = k
        env = Envelope(agent=self.info, slice=k, kind="snapshot", at_ms=self._wall(), usage=self._usage(), body=body)
        data = ENVELOPE.dump_json(env)
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


def items_of(objects: list[bytes]) -> list[Envelope]:
    """The envelopes of a slice's payloads, skipping any that do not match the contract."""
    out: list[Envelope] = []
    for payload in objects:
        try:
            out.append(ENVELOPE.validate_json(payload))
        except ValueError:
            log.warning("skipping an object that does not match the contract")
    return out


def envelopes_of(found: Slice) -> list[Envelope]:
    return items_of([o.payload for o in found.objects if o.payload])
