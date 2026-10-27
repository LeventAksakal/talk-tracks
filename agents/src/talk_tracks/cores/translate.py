"""Translation core: which caption lines still need translating, and the translation state."""

from __future__ import annotations

from talk_tracks.contracts import CaptionLine, TranslatedLine, TranslationState

WINDOW = 40


class TranslateCore:
    def __init__(self, lang: str) -> None:
        self._lang = lang
        self._lines: dict[int, TranslatedLine] = {}
        self._seen = -1

    def pending(self, lines: list[CaptionLine]) -> list[CaptionLine]:
        """Source lines newer than any translated or already requested; each line is asked for once."""
        fresh = [line for line in sorted(lines, key=lambda x: x.id) if line.id > self._seen]
        if fresh:
            self._seen = fresh[-1].id
        return fresh

    def add(self, line_id: int, text: str) -> None:
        self._lines[line_id] = TranslatedLine(id=line_id, text=text)
        for old in sorted(self._lines)[:-WINDOW]:
            del self._lines[old]

    def state(self) -> TranslationState:
        return TranslationState(lang=self._lang, lines=[self._lines[i] for i in sorted(self._lines)])
