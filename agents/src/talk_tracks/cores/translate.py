"""Translation core: which caption lines still need translating, the translated items and the carry-in."""

from __future__ import annotations

from collections.abc import Sequence

from talk_tracks.contracts import CARRY_LINES, CaptionLine, TranslatedLine, TranslationCarry, TranslationItem

WINDOW = 40


class TranslateCore:
    def __init__(self, lang: str, done: Sequence[TranslatedLine] = ()) -> None:
        """``done`` are a predecessor's lines (its newest slice): they are not translated again."""
        self._lang = lang
        self._lines: dict[int, TranslatedLine] = {line.id: line for line in done}
        self._seen = max(self._lines, default=-1)

    @property
    def lang(self) -> str:
        return self._lang

    def pending(self, lines: Sequence[CaptionLine]) -> list[CaptionLine]:
        """Source lines newer than any translated or already requested; each line is asked for once."""
        fresh = [line for line in sorted(lines, key=lambda x: x.id) if line.id > self._seen]
        if fresh:
            self._seen = fresh[-1].id
        return fresh

    def skip_to(self, lines: Sequence[CaptionLine], keep: int) -> None:
        """Leave all but the newest ``keep`` of ``lines`` untranslated: the track starts from now (decision 0010)."""
        ids = sorted(line.id for line in lines)
        if len(ids) > keep:
            self._seen = max(self._seen, ids[-keep - 1])

    def add(self, source: CaptionLine, text: str) -> TranslationItem:
        line = TranslatedLine(id=source.id, start_ms=source.start_ms, end_ms=source.end_ms, text=text)
        self._lines[line.id] = line
        for old in sorted(self._lines)[:-WINDOW]:
            del self._lines[old]
        return TranslationItem(lang=self._lang, line=line)

    def carry(self) -> TranslationCarry:
        return TranslationCarry(lang=self._lang, lines=[self._lines[i] for i in sorted(self._lines)][-CARRY_LINES:])
