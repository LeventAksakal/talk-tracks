"""Captions core: ASR events in, the captions state out. Plain Python, no network, no model."""

from __future__ import annotations

from talk_tracks.asr.base import AsrEvent, AsrFinal, AsrPartial
from talk_tracks.contracts import CaptionLine, CaptionsState

WINDOW = 40


class CaptionsCore:
    def __init__(self, lang: str, next_id: int = 0) -> None:
        self._lang = lang
        self._lines: list[CaptionLine] = []
        self._interim = ""
        self._next_id = next_id

    def on_event(self, event: AsrEvent) -> CaptionLine | None:
        """Apply one event; return the new final line, if it made one."""
        if isinstance(event, AsrPartial):
            self._interim = event.text
            return None
        text = event.text.strip()
        self._interim = ""
        if not text:
            return None
        return self._add(event, text)

    def _add(self, event: AsrFinal, text: str) -> CaptionLine:
        line = CaptionLine(
            id=self._next_id, start_ms=event.start_ms, end_ms=max(event.end_ms, event.start_ms), text=text
        )
        self._next_id += 1
        self._lines.append(line)
        del self._lines[:-WINDOW]
        return line

    @property
    def next_id(self) -> int:
        return self._next_id

    def state(self) -> CaptionsState:
        return CaptionsState(lang=self._lang, lines=list(self._lines), interim=self._interim)
