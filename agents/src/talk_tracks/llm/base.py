"""Language and vision model interface. Typed methods, one per job an agent does."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Protocol

from talk_tracks.contracts import CaptionLine, Chapter, GlossaryTerm, Usage


@dataclass(frozen=True)
class OutlineDraft:
    chapters: list[Chapter] = field(default_factory=lambda: [])
    glossary: list[GlossaryTerm] = field(default_factory=lambda: [])
    recap: str = ""


class Llm(Protocol):
    @property
    def model(self) -> str: ...

    @property
    def usage(self) -> Usage: ...

    async def translate(self, text: str, *, lang: str, context: Sequence[str]) -> str:
        """Translate one caption line into ``lang``; ``context`` is the previous source lines."""
        ...

    async def describe_slide(self, image: bytes, mime: str, *, lang: str) -> str:
        """Describe a slide for a viewer who cannot see it, in ``lang``."""
        ...

    async def outline(self, lines: Sequence[CaptionLine], previous: OutlineDraft | None, *, lang: str) -> OutlineDraft:
        """Update chapters, glossary and recap from the transcript so far."""
        ...
