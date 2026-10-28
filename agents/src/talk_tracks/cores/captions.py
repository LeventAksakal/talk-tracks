"""Captions core: ASR events in, caption items and the carry-in out. Plain Python, no network, no model."""

from __future__ import annotations

from collections.abc import Sequence

from talk_tracks.asr.base import AsrEvent, AsrFinal, AsrPartial
from talk_tracks.contracts import CARRY_LINES, CaptionItem, CaptionLine, CaptionsCarry, CaptionsState

WINDOW = 40


class CaptionsCore:
    def __init__(self, lang: str, lines: Sequence[CaptionLine] = ()) -> None:
        """``lines`` are a predecessor's (its newest slice), so a restarted agent carries on after them."""
        self._lang = lang
        unique = {line.id: line for line in lines}  # a carry-in repeats lines of the slice before
        self._lines: list[CaptionLine] = [unique[i] for i in sorted(unique)][-WINDOW:]
        self._interim = ""

    @property
    def lang(self) -> str:
        return self._lang

    def on_event(self, event: AsrEvent, now_ms: int) -> CaptionItem | None:
        """Apply one event at media time ``now_ms``; return the item to publish, if any.

        A final line's id is its start time in media ms (one more than the previous id if that is taken), so ids
        rise with time, survive restarts and never collide with a line back-filled later for an earlier slice.
        An interim version has the id the line would get now; whatever item comes next replaces it.
        """
        if isinstance(event, AsrPartial):
            if not event.text.strip() or event.text == self._interim:
                return None
            self._interim = event.text
            start = self._lines[-1].end_ms if self._lines else 0
            line = CaptionLine(id=self._id(start), start_ms=start, end_ms=max(start, now_ms), text=event.text)
            return CaptionItem(lang=self._lang, line=line, final=False)
        self._interim = ""
        text = event.text.strip()
        if not text:
            return None
        return CaptionItem(lang=self._lang, line=self._add(event, text), final=True)

    def _id(self, start_ms: int) -> int:
        return max(start_ms, self._lines[-1].id + 1 if self._lines else 0)

    def _add(self, event: AsrFinal, text: str) -> CaptionLine:
        line = CaptionLine(
            id=self._id(event.start_ms), start_ms=event.start_ms, end_ms=max(event.end_ms, event.start_ms), text=text
        )
        self._lines.append(line)
        del self._lines[:-WINDOW]
        return line

    @property
    def lines(self) -> list[CaptionLine]:
        return list(self._lines)

    def carry(self) -> CaptionsCarry:
        return CaptionsCarry(lang=self._lang, lines=self._lines[-CARRY_LINES:])

    def state(self) -> CaptionsState:
        return CaptionsState(lang=self._lang, lines=list(self._lines), interim=self._interim)
