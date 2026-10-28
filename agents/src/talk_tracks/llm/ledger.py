"""Spend ledger: a hard ceiling on what the build may spend on the Meta Model API, and a cap per room.

The free credit is a fixed total that must never be exceeded. Every call asks the ledger first (worst case for the
call) and records the real cost after. The ledger is a JSON-lines file so several agent processes share it.

Each line names the room it was spent for, so a room's own spend has a cap too (decision 0008): ``TT_ROOM_CAP_USD``
for any room, or the cap a judge token batch was minted with. A batch also has a total cap over all its rooms.
Batches are JSON files in the caps folder (``TT_CAPS_DIR``), written by ``deploy/mint-judge-tokens.sh``::

    {"group": "judges-1", "room_usd": 2, "total_usd": 10, "rooms": ["judge-3f9a", "judge-c41e"]}
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("talk_tracks")

ROOM_CAP_USD = 2.0


class BudgetExceededError(RuntimeError):
    def __init__(self, message: str, *, scope: str = "ceiling") -> None:
        super().__init__(message)
        self.scope = scope  # "ceiling", "room" or "group"


@dataclass(frozen=True)
class Prices:
    """USD per million tokens."""

    input_per_m: float
    output_per_m: float
    cached_input_per_m: float = 0.0

    def cost(self, input_tokens: int, output_tokens: int, cached_tokens: int = 0) -> float:
        fresh = max(0, input_tokens - cached_tokens)
        return (
            fresh * self.input_per_m + cached_tokens * self.cached_input_per_m + output_tokens * self.output_per_m
        ) / 1_000_000


# Muse Spark, Standard mode (Meta docs, pricing-rate-limits, fetched 2026-10-24). Re-check before relying on it.
SPARK_STANDARD = Prices(input_per_m=1.25, output_per_m=4.25, cached_input_per_m=0.15)


@dataclass(frozen=True)
class RoomCap:
    room_usd: float
    group: str | None = None
    group_usd: float | None = None


def room_cap(room: str, caps_dir: Path | None, default_usd: float = ROOM_CAP_USD) -> RoomCap:
    """The cap of the batch that lists ``room``, else ``default_usd``. A broken batch file is skipped, loudly."""
    if caps_dir is not None and caps_dir.is_dir():
        for path in sorted(caps_dir.glob("*.json")):
            try:
                batch = json.loads(path.read_text(encoding="utf-8"))
                if room in batch["rooms"]:
                    return RoomCap(float(batch["room_usd"]), str(batch["group"]), float(batch["total_usd"]))
            except (OSError, ValueError, KeyError, TypeError):
                log.warning("skipping the unreadable caps file %s", path.name)
    return RoomCap(default_usd)


class SpendLedger:
    def __init__(self, path: Path, ceiling_usd: float, *, room: str | None = None, cap: RoomCap | None = None) -> None:
        self._path = path
        self._ceiling = ceiling_usd
        self._room = room
        self._cap = cap
        path.parent.mkdir(parents=True, exist_ok=True)

    def for_room(self, room: str, cap: RoomCap) -> SpendLedger:
        """The same ledger file and ceiling; spend is recorded for ``room`` and held to its cap as well."""
        return SpendLedger(self._path, self._ceiling, room=room, cap=cap)

    def _lines(self) -> list[dict[str, object]]:
        if not self._path.exists():
            return []
        return [json.loads(raw) for raw in self._path.read_text(encoding="utf-8").splitlines() if raw.strip()]

    def total(self) -> float:
        return sum(float(str(line["usd"])) for line in self._lines())

    def room_total(self, room: str | None = None) -> float:
        room = room or self._room
        return sum(float(str(line["usd"])) for line in self._lines() if line.get("room") == room)

    def group_total(self, group: str) -> float:
        return sum(float(str(line["usd"])) for line in self._lines() if line.get("group") == group)

    @property
    def ceiling(self) -> float:
        return self._ceiling

    def check(self, worst_case_usd: float) -> None:
        """Refuse a call whose worst case would take the total over the ceiling, or the room over its caps."""
        lines = self._lines()
        spent = sum(float(str(line["usd"])) for line in lines)
        if spent + worst_case_usd > self._ceiling:
            raise BudgetExceededError(
                f"spend ${spent:.4f} + worst case ${worst_case_usd:.4f} would pass the ceiling ${self._ceiling:.2f}"
            )
        cap = self._cap
        if cap is None:
            return
        room = sum(float(str(line["usd"])) for line in lines if line.get("room") == self._room)
        if room + worst_case_usd > cap.room_usd:
            raise BudgetExceededError(
                f"room {self._room} spent ${room:.4f}; worst case ${worst_case_usd:.4f} would pass its cap"
                f" ${cap.room_usd:.2f}",
                scope="room",
            )
        if cap.group is not None and cap.group_usd is not None:
            group = sum(float(str(line["usd"])) for line in lines if line.get("group") == cap.group)
            if group + worst_case_usd > cap.group_usd:
                raise BudgetExceededError(
                    f"rooms of {cap.group} spent ${group:.4f}; worst case ${worst_case_usd:.4f} would pass their"
                    f" total cap ${cap.group_usd:.2f}",
                    scope="group",
                )

    def record(self, usd: float, what: str) -> None:
        entry: dict[str, object] = {"t": int(time.time()), "usd": round(usd, 6), "what": what}
        if self._room is not None:
            entry["room"] = self._room
        if self._cap is not None and self._cap.group is not None:
            entry["group"] = self._cap.group
        with self._path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
