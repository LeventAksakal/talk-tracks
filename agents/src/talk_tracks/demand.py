"""Lazy agents (decision 0010): an agent reads its inputs, and so pays for work, only while its track has subscribers.

The relay holds one upstream subscription per track while any viewer or downstream agent subscribes, and cancels
it within milliseconds of the last clean leave (wiki/howto/lazy-agents.md). ``Gate`` turns that into wanted / not
wanted, by the demand rule of design §5.3: moq-relay forwards a FETCH by subscribing upstream for as long as the
FETCH takes, so a subscription is demand only once it has been open for 1 s and no FETCH of the track has been in
flight for 1 s (``Fetches``). A grace period keeps a page reload or a downstream agent resubscribing from pausing it.
``gated`` opens an input while wanted and closes it (which unsubscribes upstream in turn) while not, once the open
slice is finished. Transport-free.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable
from typing import Any

log = logging.getLogger("talk_tracks")

WAKE_DEBOUNCE_S = 1.0
IDLE_GRACE_S = 10.0
POLL_S = 0.1


class Fetches:
    """The FETCHes of one track being answered now, and when the last one ended (the FETCH handler counts them)."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self.in_flight = 0
        self.ended_at: float | None = None

    def begin(self) -> None:
        self.in_flight += 1

    def end(self) -> None:
        self.in_flight -= 1
        self.ended_at = self._clock()

    def quiet(self, for_s: float) -> bool:
        """No FETCH in flight, and none ended within ``for_s``."""
        return self.in_flight == 0 and (self.ended_at is None or self._clock() - self.ended_at >= for_s)


class Gate:
    """``subscribed()`` is the publisher's view (aiomoqt ``PublishedTrack.producing``); polled, as it costs nothing."""

    def __init__(
        self,
        subscribed: Callable[[], bool],
        *,
        fetches: Fetches | None = None,
        wake_s: float = WAKE_DEBOUNCE_S,
        grace_s: float = IDLE_GRACE_S,
        poll_s: float = POLL_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.subscribed = subscribed
        self.fetches = fetches or Fetches(clock)
        self._wake = wake_s
        self._grace = grace_s
        self._poll = poll_s
        self._clock = clock

    async def wait_wanted(self) -> None:
        """Return once someone has subscribed for ``wake_s`` in a row and no FETCH has been in flight for ``wake_s``.
        moq-relay forwards a FETCH by subscribing upstream until the FETCH is answered, 8 ms or seconds (design
        §5.3); that subscription must not open a paid session. A viewer who subscribes during a FETCH shares the
        relay's upstream subscription, which then outlives the FETCH: it counts ``wake_s`` after the FETCH ends."""
        since: float | None = None
        while True:
            if not self.subscribed():
                since = None
            elif since is None:
                since = self._clock()
            if since is not None and self._clock() - since >= self._wake and self.fetches.quiet(self._wake):
                return
            await asyncio.sleep(self._poll)

    async def wait_unwanted(self) -> None:
        """Return once nobody has subscribed for ``grace_s`` in a row."""
        since: float | None = None
        while True:
            if self.subscribed():
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
