"""Spend ledger: a hard ceiling on what the build may spend on the Meta Model API.

The free credit is a fixed total that must never be exceeded. Every call asks the ledger first (worst case for the
call) and records the real cost after. The ledger is a JSON-lines file so several agent processes share it.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path


class BudgetExceededError(RuntimeError):
    pass


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


class SpendLedger:
    def __init__(self, path: Path, ceiling_usd: float) -> None:
        self._path = path
        self._ceiling = ceiling_usd
        path.parent.mkdir(parents=True, exist_ok=True)

    def total(self) -> float:
        if not self._path.exists():
            return 0.0
        total = 0.0
        for raw in self._path.read_text(encoding="utf-8").splitlines():
            if raw.strip():
                total += float(json.loads(raw)["usd"])
        return total

    @property
    def ceiling(self) -> float:
        return self._ceiling

    def check(self, worst_case_usd: float) -> None:
        """Refuse a call whose worst case would take the total over the ceiling."""
        spent = self.total()
        if spent + worst_case_usd > self._ceiling:
            raise BudgetExceededError(
                f"spend ${spent:.4f} + worst case ${worst_case_usd:.4f} would pass the ceiling ${self._ceiling:.2f}"
            )

    def record(self, usd: float, what: str) -> None:
        line = json.dumps({"t": int(time.time()), "usd": round(usd, 6), "what": what})
        with self._path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
