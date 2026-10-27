"""Deterministic model for tests and development: no network, no cost, same output every time."""

from __future__ import annotations

from collections.abc import Sequence

from talk_tracks.contracts import CaptionLine, Chapter, GlossaryTerm, Usage

from .base import OutlineDraft

CHAPTER_EVERY = 5


class FakeLlm:
    def __init__(self) -> None:
        self._requests = 0

    @property
    def model(self) -> str:
        return "fake"

    @property
    def usage(self) -> Usage:
        return Usage(requests=self._requests)

    async def translate(self, text: str, *, lang: str, context: Sequence[str]) -> str:
        self._requests += 1
        return f"[{lang}] {text}"

    async def describe_slide(self, image: bytes, mime: str, *, lang: str) -> str:
        self._requests += 1
        return f"[{lang}] A slide ({mime}, {len(image)} bytes)."

    async def outline(self, lines: Sequence[CaptionLine], previous: OutlineDraft | None, *, lang: str) -> OutlineDraft:
        self._requests += 1
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
