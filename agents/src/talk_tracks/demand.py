"""Lazy agents (decision 0010): an agent reads its inputs, and so pays for work, only while its track is wanted.

The relay holds one upstream subscription per track while any viewer or downstream agent subscribes, and cancels
it within milliseconds of the last clean leave. But moq-relay also forwards a FETCH by subscribing upstream for as
long as the FETCH takes (8 ms, or seconds for a back-fill), so a subscription alone is not demand. ``Demand`` holds
the rule of design §5.3, per subscription:

* a SUBSCRIBE followed within 50 ms by a standalone FETCH of the track is fetch-induced. It becomes demand when it
  is still open 1 s after the last FETCH of the track completed, or 10 s after it opened, whichever comes first;
* any other SUBSCRIBE becomes demand once open for 1 s with no FETCH of the track in flight during the last 1 s;
* demand latches until the relay cancels that subscription.

``Gate`` turns it into wanted / not wanted, with a grace period so a page reload or a downstream agent resubscribing
does not pause the agent. ``gated`` opens an input while wanted and closes it (which unsubscribes upstream in turn)
while not, once the open slice is finished. Transport-free.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable, Hashable, Iterable
from dataclasses import dataclass
from typing import Any

log = logging.getLogger("talk_tracks")

WAKE_DEBOUNCE_S = 1.0  # a subscription counts once open this long with no FETCH in flight for as long
INDUCED_WITHIN_S = 0.05  # a FETCH this soon after a SUBSCRIBE means the relay subscribed to forward it
INDUCED_MAX_S = 10.0  # a fetch-induced subscription still open after this long is a viewer after all
IDLE_GRACE_S = 10.0
POLL_S = 0.1


@dataclass
class _Sub:
    opened: float
    induced: bool = False
    latched: bool = False


class Demand:
    """The track's subscriptions (keyed by the relay's request) and FETCHes, as the publisher sees them.

    ``live`` gives the subscriptions open now: one that vanishes without a cancel (its relay session died) is
    dropped too.
    """

    def __init__(
        self,
        live: Callable[[], Iterable[Hashable]] | None = None,
        *,
        quiet_s: float = WAKE_DEBOUNCE_S,
        induced_within_s: float = INDUCED_WITHIN_S,
        induced_max_s: float = INDUCED_MAX_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._live = live
        self._quiet = quiet_s
        self._within = induced_within_s
        self._max = induced_max_s
        self._clock = clock
        self._subs: dict[Hashable, _Sub] = {}
        self.in_flight = 0
        self._fetch_began: float | None = None
        self._fetch_ended: float | None = None

    def subscribed(self, key: Hashable) -> None:
        now = self._clock()
        began = self._fetch_began
        induced = self.in_flight > 0 and began is not None and now - began <= self._within
        self._subs[key] = _Sub(now, induced=induced)

    def cancelled(self, key: Hashable) -> None:
        self._subs.pop(key, None)

    def fetch_begin(self) -> None:
        now = self._clock()
        self.in_flight += 1
        self._fetch_began = now
        for sub in self._subs.values():
            if not sub.latched and now - sub.opened <= self._within:
                sub.induced = True

    def fetch_end(self) -> None:
        self.in_flight = max(0, self.in_flight - 1)
        self._fetch_ended = self._clock()

    def open(self) -> int:
        self._reconcile()
        return len(self._subs)

    def wanted(self) -> bool:
        """Whether any subscription is demand; one that becomes demand stays so until cancelled."""
        self._reconcile()
        now = self._clock()
        fetched_ago = None if self._fetch_ended is None else now - self._fetch_ended
        began_ago = None if self._fetch_began is None else now - self._fetch_began
        quiet = self.in_flight == 0 and all(t is None or t >= self._quiet for t in (fetched_ago, began_ago))
        for sub in self._subs.values():
            if sub.latched:
                continue
            age = now - sub.opened
            if sub.induced:
                after_fetch = self.in_flight == 0 and fetched_ago is not None and fetched_ago >= self._quiet
                sub.latched = after_fetch or age >= self._max
            else:
                sub.latched = age >= self._quiet and quiet
        return any(sub.latched for sub in self._subs.values())

    def _reconcile(self) -> None:
        if self._live is None:
            return
        live = set(self._live())
        for key in [k for k in self._subs if k not in live]:
            del self._subs[key]
        now = self._clock()
        for key in live - self._subs.keys():
            self._subs[key] = _Sub(now)  # seen without its SUBSCRIBE (before the hook was in place)


class Gate:
    """Wanted or not, from ``demand``; polled, as it costs nothing."""

    def __init__(
        self,
        demand: Demand,
        *,
        grace_s: float = IDLE_GRACE_S,
        poll_s: float = POLL_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.demand = demand
        self._grace = grace_s
        self._poll = poll_s
        self._clock = clock

    async def wait_wanted(self) -> None:
        while True:  # demand latches on the clock, not on an event: poll
            if self.demand.wanted():
                return
            await asyncio.sleep(self._poll)

    async def wait_unwanted(self) -> None:
        """Return once nothing has been demand for ``grace_s`` in a row."""
        since: float | None = None
        while True:
            if self.demand.wanted():
                since = None
            elif since is None:
                since = self._clock()
            elif self._clock() - since >= self._grace:
                return
            await asyncio.sleep(self._poll)


async def _stop(gate: Gate, finish: Callable[[], Awaitable[None]] | None) -> None:
    await gate.wait_unwanted()
    if finish is not None:
        await finish()


async def _next[T](source: AsyncIterator[T]) -> T:
    return await anext(source)


async def gated[T](
    gate: Gate,
    open_input: Callable[[], AsyncGenerator[T]],
    what: str,
    finish: Callable[[], Awaitable[None]] | None = None,
) -> AsyncGenerator[T | None]:
    """The items of ``open_input()`` while the gate is wanted; ``None`` each time the input closes for want of
    subscribers (an ASR session closes on it). A fresh input opens on the next subscriber.

    ``finish`` runs after the last leave, with the input still read: a sliced track finishes its open slice into the
    archive that way (at most one slice of work), so the slice is whole for a later FETCH."""
    while True:
        await gate.wait_wanted()
        log.info("%s: subscribed, reading inputs", what)
        source = open_input()
        idle = asyncio.ensure_future(_stop(gate, finish))
        try:
            while True:
                item: asyncio.Future[Any] = asyncio.ensure_future(_next(source))
                await asyncio.wait({item, idle}, return_when=asyncio.FIRST_COMPLETED)
                if not item.done():
                    item.cancel()
                    with contextlib.suppress(asyncio.CancelledError, StopAsyncIteration):
                        await item
                    break
                try:
                    value: T = item.result()
                except StopAsyncIteration:
                    return
                yield value
        finally:
            idle.cancel()
            with contextlib.suppress(Exception):
                await source.aclose()
        log.info("%s: no subscribers, idle", what)
        yield None
