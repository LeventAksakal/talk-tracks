"""Speech recognition interface. A provider turns 16 kHz mono PCM into partial and final text events."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import numpy as np
from numpy.typing import NDArray


@dataclass(frozen=True)
class AsrPartial:
    """The turn's transcript so far, and its start when the recogniser says."""

    text: str
    start_ms: int | None = None


@dataclass(frozen=True)
class AsrFinal:
    text: str
    start_ms: int
    end_ms: int


AsrEvent = AsrPartial | AsrFinal


class AsrSession(Protocol):
    async def feed(self, pcm16k: NDArray[np.int16], end_ms: int) -> list[AsrEvent]:
        """Give the next audio, which ends at media time ``end_ms``; return the events it produced."""
        ...

    async def close(self) -> list[AsrEvent]:
        """Flush whatever is left."""
        ...


class AsrProvider(Protocol):
    async def open(self, language: str, offset_ms: int = 0) -> AsrSession:
        """Start a session whose audio begins at media time ``offset_ms``."""
        ...
