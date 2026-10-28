"""Deterministic model for tests and development: no network, same output every time.

It costs nothing, unless given a ledger and a price per call: then it spends pretend money, so spend caps can be
tried locally. Never point it at the real ledger.
"""

from __future__ import annotations

from collections.abc import Sequence

from talk_tracks.contracts import CaptionLine, Chapter, GlossaryTerm, Usage

from .base import OutlineDraft
from .ledger import SpendLedger

CHAPTER_EVERY = 5


class FakeLlm:
    def __init__(self, ledger: SpendLedger | None = None, usd_per_call: float = 0.0) -> None:
        self._requests = 0
        self._ledger = ledger
        self._usd = usd_per_call

    def _call(self, what: str) -> None:
        if self._ledger is not None and self._usd > 0:
            self._ledger.check(self._usd)
            self._ledger.record(self._usd, f"fake {what}")
        self._requests += 1

    @property
    def model(self) -> str:
        return "fake"

    @property
    def usage(self) -> Usage:
        return Usage(requests=self._requests, cost_usd=round(self._requests * self._usd, 6) if self._ledger else 0.0)

    async def translate(self, text: str, *, lang: str, context: Sequence[str]) -> str:
        self._call("translate")
        return f"[{lang}] {text}"

    async def describe_slide(self, image: bytes, mime: str, *, lang: str) -> str:
        self._call("describe")
        return f"[{lang}] A slide ({mime}, {len(image)} bytes)."

    async def outline(self, lines: Sequence[CaptionLine], previous: OutlineDraft | None, *, lang: str) -> OutlineDraft:
        self._call("outline")
        chapters = [
            Chapter(
                id=i // CHAPTER_EVERY,
                start_ms=line.start_ms,
                title=f"Part {i // CHAPTER_EVERY + 1}",
                summary=line.text,
            )
            for i, line in enumerate(lines)
            if i % CHAPTER_EVERY == 0
        ]
        words = sorted({w.strip(".,;:!?").lower() for line in lines for w in line.text.split() if len(w) > 8})
        glossary = [GlossaryTerm(term=w, definition=f"[{lang}] the word {w!r}") for w in words[:5]]
        return OutlineDraft(chapters=chapters, glossary=glossary, recap=f"[{lang}] {len(lines)} lines so far.")
