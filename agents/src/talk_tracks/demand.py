"""Lazy agents (decision 0010): an agent reads its inputs, and so pays for work, only while its track has subscribers.

The relay holds one upstream subscription per track while any viewer or downstream agent subscribes, and cancels
it within milliseconds of the last clean leave (wiki/howto/lazy-agents.md). ``Gate`` turns that into wanted / not
wanted, with a grace period so a page reload or a downstream agent resubscribing does not pause the agent.
``gated`` opens an input while wanted and closes it (which unsubscribes upstream in turn) while not. Transport-free.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncGenerator, AsyncIterator, Callable
from typing import Any

log = logging.getLogger("talk_tracks")

IDLE_GRACE_S = 10.0
POLL_S = 0.1


class Gate:
    """``subscribed()`` is the publisher's view (aiomoqt ``PublishedTrack.producing``); polled, as it costs nothing."""

    def __init__(
        self,
        subscribed: Callable[[], bool],
        *,
        grace_s: float = IDLE_GRACE_S,
        poll_s: float = POLL_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.subscribed = subscribed
        self._grace = grace_s
        self._poll = poll_s
        self._clock = clock

    async def wait_wanted(self) -> None:
        while not self.subscribed():  # noqa: ASYNC110 - aiomoqt has no event for it, and polling costs nothing
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


async def _next[T](source: AsyncIterator[T]) -> T:
    return await anext(source)


async def gated[T](gate: Gate, open_input: Callable[[], AsyncGenerator[T]], what: str) -> AsyncIterator[T | None]:
    """The items of ``open_input()`` while the gate is wanted; ``None`` each time the input closes for want of
    subscribers (an ASR session closes on it). A fresh input opens on the next subscriber."""
    while True:
        await gate.wait_wanted()
        log.info("%s: subscribed, reading inputs", what)
        source = open_input()
        idle = asyncio.ensure_future(gate.wait_unwanted())
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
