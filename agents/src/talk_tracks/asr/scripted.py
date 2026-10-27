"""Deterministic ASR for tests: words come from a script, timed by the media clock, whatever the audio holds."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from .base import AsrEvent, AsrFinal, AsrPartial, AsrSession


@dataclass(frozen=True)
class ScriptedLine:
    start_ms: int
    end_ms: int
    text: str


class ScriptedAsrSession:
    """Emits a partial for each word spoken so far in a line, then a final once the line's end time has passed."""

    def __init__(self, script: list[ScriptedLine]) -> None:
        self._script = sorted(script, key=lambda s: s.start_ms)
        self._next = 0
        self._partial_words = 0

    async def feed(self, pcm16k: NDArray[np.int16], end_ms: int) -> list[AsrEvent]:
        events: list[AsrEvent] = []
        while self._next < len(self._script):
            line = self._script[self._next]
            if end_ms >= line.end_ms:
                events.append(AsrFinal(line.text, line.start_ms, line.end_ms))
                self._next += 1
                self._partial_words = 0
                continue
            if end_ms > line.start_ms:
                words = line.text.split()
                span = max(1, line.end_ms - line.start_ms)
                heard = min(len(words), 1 + (end_ms - line.start_ms) * len(words) // span)
                if heard != self._partial_words:
                    self._partial_words = heard
                    events.append(AsrPartial(" ".join(words[:heard])))
            break
        return events

    async def close(self) -> list[AsrEvent]:
        events: list[AsrEvent] = [AsrFinal(s.text, s.start_ms, s.end_ms) for s in self._script[self._next :]]
        self._next = len(self._script)
        return events


class ScriptedAsr:
    def __init__(self, script: list[ScriptedLine]) -> None:
        self._script = script

    async def open(self, language: str, offset_ms: int = 0) -> AsrSession:
        return ScriptedAsrSession(self._script)
