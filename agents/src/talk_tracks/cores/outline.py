"""Chapters, glossary and recap core: decides when the transcript has moved enough to ask the model again."""

from __future__ import annotations

from collections.abc import Sequence

from talk_tracks.contracts import (
    CaptionLine,
    Chapter,
    ChapterData,
    GlossaryTerm,
    OutlineRecord,
    OutlineState,
    RecapData,
    TermData,
)
from talk_tracks.llm.base import OutlineDraft

EVERY_LINES = 6
EVERY_MS = 60_000
TRANSCRIPT_LINES = 120  # bound the prompt (and the cost) on a long talk; earlier chapters stay in ``previous``


class OutlineCore:
    def __init__(self, lang: str) -> None:
        self._lang = lang
        self._lines: dict[int, CaptionLine] = {}
        self._draft: OutlineDraft | None = None
        self._asked_through = -1
        self._asked_at_ms = 0

    @property
    def lang(self) -> str:
        return self._lang

    def add_lines(self, lines: list[CaptionLine]) -> None:
        for line in lines:
            self._lines[line.id] = line

    def due(self, now_ms: int) -> bool:
        new = sum(1 for i in self._lines if i > self._asked_through)  # ids are start times, not a count
        return new >= EVERY_LINES or (new > 0 and now_ms - self._asked_at_ms >= EVERY_MS)

    def request(self, now_ms: int) -> tuple[list[CaptionLine], OutlineDraft | None]:
        """The transcript window and previous draft to send; marks everything so far as asked."""
        self._asked_through = max(self._lines, default=-1)
        self._asked_at_ms = now_ms
        window = [self._lines[i] for i in sorted(self._lines)][-TRANSCRIPT_LINES:]
        return window, self._draft

    def apply(self, draft: OutlineDraft) -> None:
        self._draft = draft

    def seed(self, records: Sequence[OutlineRecord]) -> None:
        """A predecessor's newest revision: the next request refines it instead of starting over."""
        chapters = [
            Chapter(id=r.data.id, start_ms=r.data.start, title=r.data.title, summary=r.data.summary)
            for r in records
            if isinstance(r.data, ChapterData)
        ]
        terms = [
            GlossaryTerm(term=r.data.term, definition=r.data.definition)
            for r in records
            if isinstance(r.data, TermData)
        ]
        recap = next((r.data.text for r in records if isinstance(r.data, RecapData)), "")
        self._draft = OutlineDraft(chapters=chapters, glossary=terms, recap=recap)

    def records(self, watermark_ms: int) -> list[OutlineRecord]:
        """The whole outline as one timeline (design §4.3): chapters at their start, terms and the recap at the
        watermark (the newest caption this revision has read)."""
        d = self._draft or OutlineDraft()
        out = [
            OutlineRecord(m=c.start_ms, data=ChapterData(id=c.id, start=c.start_ms, title=c.title, summary=c.summary))
            for c in d.chapters
        ]
        out += [OutlineRecord(m=watermark_ms, data=TermData(term=t.term, definition=t.definition)) for t in d.glossary]
        if d.recap:
            out.append(OutlineRecord(m=watermark_ms, data=RecapData(text=d.recap)))
        return out

    def state(self) -> OutlineState:
        d = self._draft or OutlineDraft()
        return OutlineState(lang=self._lang, chapters=d.chapters, glossary=d.glossary, recap=d.recap)
