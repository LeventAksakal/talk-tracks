"""Spend ledger: a hard ceiling on what the build may spend on the Meta Model API, and a cap per room.

The free credit is a fixed total that must never be exceeded. Every model call reserves its worst case before it
runs (``reserve``) and settles to the real cost after (``settle``), so calls running at once, in this process or
another, cannot pass a cap together. The ledger is a JSON-lines file so several agent processes share it.

Each line names the room it was spent for, so a room's own spend has a cap too (decision 0008): ``TT_ROOM_CAP_USD``
for any room, or the cap a judge token batch was minted with. A batch also has a total cap over all its rooms.
Batches are JSON files in the caps folder (``TT_CAPS_DIR``), written by ``deploy/mint-judge-tokens.sh``::

    {"group": "judges-1", "room_usd": 2, "total_usd": 10, "rooms": ["judge-3f9a", "judge-c41e"]}
"""

from __future__ import annotations

import contextlib
import json
import logging
import sys
import time
from collections.abc import Generator
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("talk_tracks")

ROOM_CAP_USD = 2.0
BACKFILL_SHARE = 0.25  # of a room's cap: what back-filling slices nobody watched live may spend


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


@dataclass
class Reservation:
    """A call's worst case, held in the ledger until the call settles."""

    usd: float
    what: str
    settled: bool = False


class SpendLedger:
    def __init__(
        self,
        path: Path,
        ceiling_usd: float,
        *,
        room: str | None = None,
        cap: RoomCap | None = None,
        backfill_share: float | None = None,
    ) -> None:
        self._path = path
        self._ceiling = ceiling_usd
        self._room = room
        self._cap = cap
        self._backfill = backfill_share
        self._reserved: list[float] = []
        path.parent.mkdir(parents=True, exist_ok=True)

    def for_room(self, room: str, cap: RoomCap) -> SpendLedger:
        """The same ledger file and ceiling; spend is recorded for ``room`` and held to its cap as well."""
        return SpendLedger(self._path, self._ceiling, room=room, cap=cap)

    def for_backfill(self, share: float = BACKFILL_SHARE) -> SpendLedger:
        """The room's back-fill budget: the same caps, and back-fill spend held to ``share`` of the room's cap on
        top. Each call reserves its worst case before it runs (``check``) and settles to the real cost after
        (``record``), so back-fills running at once, in this process or another, cannot pass the budget together.
        A call that fails keeps its reservation: that errs on the side of spending less."""
        if self._room is None or self._cap is None:
            raise ValueError("a back-fill budget belongs to a room")
        return SpendLedger(self._path, self._ceiling, room=self._room, cap=self._cap, backfill_share=share)

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
        """Refuse a call whose worst case would take the total over the ceiling, or the room over its caps. A
        back-fill ledger also holds its share and reserves the worst case at once (``record`` settles it)."""
        if self._backfill is None:
            self._check(self._lines(), worst_case_usd)
            return
        self._reserved.append(self.reserve(worst_case_usd, "a back-fill").usd)

    def reserve(self, worst_case_usd: float, what: str) -> Reservation:
        """Hold a call's worst case, or refuse it as ``check`` does."""
        with _locked(self._path):
            lines = self._lines()
            self._check(lines, worst_case_usd)
            if self._backfill is not None:
                assert self._cap is not None
                budget = self._cap.room_usd * self._backfill
                spent = sum(float(str(x["usd"])) for x in lines if x.get("room") == self._room and x.get("backfill"))
                if spent + worst_case_usd > budget:
                    raise BudgetExceededError(
                        f"back-fill in room {self._room} spent ${spent:.4f}; worst case ${worst_case_usd:.4f} would"
                        f" pass its budget ${budget:.2f}",
                        scope="backfill",
                    )
            self._append(worst_case_usd, f"reserved for {what}")
        return Reservation(worst_case_usd, what)

    def settle(self, reservation: Reservation, usd: float, what: str | None = None) -> None:
        """The call's real cost in place of its reservation (once)."""
        if reservation.settled:
            return
        reservation.settled = True
        with _locked(self._path):
            self._append(usd - reservation.usd, what or reservation.what)

    def release(self, reservation: Reservation) -> None:
        """A call that was refused before it was paid for."""
        self.settle(reservation, 0.0, f"released {reservation.what}")

    def _check(self, lines: list[dict[str, object]], worst_case_usd: float) -> None:
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
        """A call's real cost; on a back-fill ledger, the difference from what its ``check`` reserved."""
        reserved = self._reserved.pop(0) if self._reserved else 0.0
        with _locked(self._path):
            self._append(usd - reserved, what)

    def _append(self, usd: float, what: str) -> None:
        entry: dict[str, object] = {"t": int(time.time()), "usd": round(usd, 6), "what": what}
        if self._room is not None:
            entry["room"] = self._room
        if self._cap is not None and self._cap.group is not None:
            entry["group"] = self._cap.group
        if self._backfill is not None:
            entry["backfill"] = True
        with self._path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")


@contextlib.contextmanager
def _locked(path: Path) -> Generator[None]:
    """An exclusive lock on the ledger, across processes, where the OS has ``flock`` (the VM); a no-op elsewhere."""
    if sys.platform == "win32":
        yield
        return
    import fcntl

    with path.with_suffix(path.suffix + ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
