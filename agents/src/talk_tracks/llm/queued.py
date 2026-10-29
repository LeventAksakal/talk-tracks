"""Live work first (design §5.3): an agent's back-fills run one at a time, each model call queued behind live calls.

``Priority`` is shared by an agent's live model and its back-fill model (``QueuedLlm``): a live call runs at once;
a back-fill call waits until no live call is running. ``Priority.backfill`` holds a whole back-fill, so a second one
waits for the first. Transport-free.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncGenerator, Sequence

from talk_tracks.contracts import CaptionLine, Usage

from .base import Llm, OutlineDraft


class Priority:
    def __init__(self) -> None:
        self._live = 0
        self._idle = asyncio.Event()
        self._idle.set()
        self._one = asyncio.Lock()

    @contextlib.asynccontextmanager
    async def live(self) -> AsyncGenerator[None]:
        self._live += 1
        self._idle.clear()
        try:
            yield
        finally:
            self._live -= 1
            if self._live == 0:
                self._idle.set()

    @contextlib.asynccontextmanager
    async def backfill(self) -> AsyncGenerator[None]:
        """One back-fill of this agent at a time."""
        async with self._one:
            yield

    async def wait_live_idle(self) -> None:
        while not self._idle.is_set():
            await self._idle.wait()
            await asyncio.sleep(0)  # a live call queued right behind the one that ended goes first


class QueuedLlm:
    """``llm`` with its calls marked live, or queued behind live ones (``live=False``, for back-fill)."""

    def __init__(self, llm: Llm, priority: Priority, *, live: bool) -> None:
        self._llm = llm
        self._priority = priority
        self._is_live = live

    @property
    def model(self) -> str:
        return self._llm.model

    @property
    def usage(self) -> Usage:
        return self._llm.usage

    @contextlib.asynccontextmanager
    async def _turn(self) -> AsyncGenerator[None]:
        if self._is_live:
            async with self._priority.live():
                yield
        else:
            await self._priority.wait_live_idle()
            yield

    async def translate(self, text: str, *, lang: str, context: Sequence[str]) -> str:
        async with self._turn():
            return await self._llm.translate(text, lang=lang, context=context)

    async def describe_slide(self, image: bytes, mime: str, *, lang: str) -> str:
        async with self._turn():
            return await self._llm.describe_slide(image, mime, lang=lang)

    async def outline(self, lines: Sequence[CaptionLine], previous: OutlineDraft | None, *, lang: str) -> OutlineDraft:
        async with self._turn():
            return await self._llm.outline(lines, previous, lang=lang)


def add_usage(a: Usage, b: Usage) -> Usage:
    """An agent's model usage over its live and back-fill models."""
    return Usage(
        requests=a.requests + b.requests,
        input_tokens=a.input_tokens + b.input_tokens,
        output_tokens=a.output_tokens + b.output_tokens,
        cost_usd=round(a.cost_usd + b.cost_usd, 6),
    )
