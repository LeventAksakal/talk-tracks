"""Translation core: which caption cues still need translating, the translated cues and the carry-in.

A translated cue keeps its caption's id, start and end, so a viewer lines the two tracks up cue by cue.
"""

from __future__ import annotations

from collections.abc import Sequence

from talk_tracks.contracts import CARRY_CUES, Cue
from talk_tracks.records import cue_number

WINDOW = 40


class TranslateCore:
    def __init__(self, lang: str, done: Sequence[Cue] = ()) -> None:
        """``done`` are a predecessor's cues (its newest slice): they are not translated again."""
        self._lang = lang
        self._cues: dict[int, Cue] = {cue_number(c): c for c in done}
        self._seen = max(self._cues, default=-1)

    @property
    def lang(self) -> str:
        return self._lang

    def pending(self, cues: Sequence[Cue]) -> list[Cue]:
        """Final caption cues newer than any translated or already requested; each one is asked for once."""
        fresh = sorted((c for c in cues if c.final and cue_number(c) > self._seen), key=cue_number)
        if fresh:
            self._seen = cue_number(fresh[-1])
        return fresh

    def skip_before(self, start_ms: int) -> None:
        """Leave the cues that start before ``start_ms`` untranslated: the track starts there (decision 0010)."""
        self._seen = max(self._seen, start_ms - 1)

    def add(self, source: Cue, text: str) -> Cue:
        cue = Cue(start=source.start, end=source.end, id=source.id, text=text, rev=0, final=True)
        self._cues[cue_number(cue)] = cue
        for old in sorted(self._cues)[:-WINDOW]:
            del self._cues[old]
        return cue

    def carry(self) -> list[Cue]:
        return [self._cues[i] for i in sorted(self._cues)][-CARRY_CUES:]
