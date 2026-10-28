"""What the room service publishes on ``talk/<room>/catalog``: the room's MSF catalog, built with ``room_catalog``.

The document's shape is ``talk_tracks.room_catalog`` (shared with the looper) and the field names are the locked ones
in ``wiki/design/lane-briefs.md`` ("Catalog field names"). This module fills it for a live room:

* tracks: each announced agent's tracks that have a ``track.json`` (``TrackArchive(..., info=TrackInfo(...))``), never
  a subscription to an agent track, which would be demand;
* ``tt.epoch`` and ``tt.shift`` (ms per teacher ``clock.wall``): the room clock, from the archive (``store``);
* ``tt.status.<agent>``: ``status``, ``producing``, ``fetches_served``, ``backfills``, ``spend_usd`` and
  ``updated_ms``, summed over the agent's tracks from what each last wrote with ``TrackArchive.report``. A
  ``track.json`` older than 15 s counts as idle and not producing, and a room at its spend cap (or the build at its
  ceiling, from the agents' ledger) makes every paid agent's ``status`` ``capped``.

No catalog is published before the room has an epoch: every template needs E, and agents stamp nothing before it.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..contracts import ROOT
from ..room_catalog import CatalogTrack, RoomCatalog
from .slices import TRACK_INFO, listdir

log = logging.getLogger("talk_tracks.archive.catalog")

REFRESH_S = 4.0  # under moq-relay's 5 s max age, so a late joiner always gets the latest group
STALE_MS = 15_000
RANK = {"idle": 0, "live": 1, "capped": 2}
KINDS = ("captions", "translation", "slides", "outline")


def catalog_track(room: str, agent: str, track: str, info: dict[str, Any]) -> CatalogTrack | None:
    """The catalog entry of one agent track from its ``track.json``. None for a kind the catalog does not know."""
    kind = info.get("kind")
    if kind not in KINDS:
        log.warning("room %s: %s/%s has kind %r, not listed", room, agent, track, kind)
        return None
    depends = tuple(d if d.startswith(f"{ROOT}/") else f"{ROOT}/{room}/agents/{d}" for d in info.get("depends", []))
    return CatalogTrack(
        namespace=f"{ROOT}/{room}/agents/{agent}",
        name=track,
        kind=kind,
        lang=str(info.get("lang") or ""),
        label=str(info.get("label") or ""),
        lateness_ms=int(info.get("lateness_ms") or 0),
        cost="free" if info.get("cost") == "free" else "paid",
        depends_on=depends,
    )


def agent_status(infos: list[dict[str, Any]], *, capped: bool, now_ms: int) -> dict[str, Any]:
    """``tt.status.<agent>`` from its tracks' ``track.json``: the highest fresh status, counts summed."""
    status, producing, updated = "idle", False, 0
    for info in infos:
        written = int(info.get("updated_ms") or 0)
        updated = max(updated, written)
        if now_ms - written >= STALE_MS:
            continue
        said = str(info.get("status", "idle"))
        if RANK.get(said, 0) > RANK[status]:
            status = said
        producing = producing or bool(info.get("producing"))
    paid = any(info.get("cost", "paid") == "paid" for info in infos)
    if status == "capped" or (capped and paid):
        status, producing = "capped", False
    return {
        "status": status,
        "producing": producing,
        "fetches_served": sum(int(info.get("fetches_served") or 0) for info in infos),
        "backfills": sum(int(info.get("backfills") or 0) for info in infos),
        "spend_usd": round(sum(float(info.get("spend_usd") or 0) for info in infos), 6),
        "updated_ms": updated,
    }


class Budget:
    """Whether a room is at its spend cap, from the agents' ledger (decision 0008). Re-read when the file changes."""

    def __init__(self, ledger: Path, caps_dir: Path | None, ceiling_usd: float, room_cap_usd: float) -> None:
        self.ledger, self.caps_dir, self.ceiling, self.room_cap = ledger, caps_dir, ceiling_usd, room_cap_usd
        self._seen: tuple[float, int] | None = None
        self._lines: list[dict[str, Any]] = []

    def _read(self) -> list[dict[str, Any]]:
        try:
            stat = self.ledger.stat()
        except OSError:
            return []
        if self._seen != (stat.st_mtime, stat.st_size):
            self._seen = (stat.st_mtime, stat.st_size)
            lines: list[dict[str, Any]] = []
            for raw in self.ledger.read_text(encoding="utf-8").splitlines():
                try:
                    value: object = json.loads(raw)
                except ValueError:
                    continue  # a line being appended
                if isinstance(value, dict):
                    lines.append(value)  # pyright: ignore[reportUnknownArgumentType]
            self._lines = lines
        return self._lines

    def capped(self, room: str) -> bool:
        from ..llm.ledger import room_cap

        lines = self._read()
        total = sum(float(line.get("usd", 0)) for line in lines)
        spent = sum(float(line.get("usd", 0)) for line in lines if line.get("room") == room)
        cap = room_cap(room, self.caps_dir, self.room_cap)
        return total >= self.ceiling - 0.01 or spent >= cap.room_usd - 0.01


class CatalogFeed:
    """A live room's catalog, rebuilt on every tick; ``changed`` says when to publish a new group."""

    def __init__(self, room: str, root: Path, *, capped: Callable[[str], bool] | None = None) -> None:
        self.room, self.root, self._capped = room, root, capped
        self.agents: set[str] = set()  # announced now
        self.epoch_ms: int | None = None
        self.shift: dict[str, int] = {}  # clock.wall -> ms
        self._last: bytes | None = None

    def document(self, now_ms: int | None = None) -> dict[str, Any] | None:
        if self.epoch_ms is None:
            return None
        now = int(time.time() * 1000) if now_ms is None else now_ms
        capped = self._capped is not None and self._capped(self.room)
        tracks: list[CatalogTrack] = []
        status: dict[str, dict[str, Any]] = {}
        for agent in sorted(self.agents):
            folder = self.root / self.room / "agents" / agent
            infos: list[dict[str, Any]] = []
            for track in sorted(listdir(folder)):
                info = _read_info(folder / track / TRACK_INFO)
                if info is None:
                    continue
                entry = catalog_track(self.room, agent, track, info)
                if entry is not None:
                    tracks.append(entry)
                    infos.append(info)
            if infos:
                status[agent] = agent_status(infos, capped=capped, now_ms=now)
        shift = {int(float(wall)): ms for wall, ms in self.shift.items()}
        return RoomCatalog(self.epoch_ms, tuple(tracks), shift, status).to_json()

    def changed(self, now_ms: int | None = None) -> bytes | None:
        """The catalog as JSON when it differs from the last one returned, else None."""
        doc = self.document(now_ms)
        if doc is None:
            return None
        data = json.dumps(doc, separators=(",", ":")).encode()
        if data == self._last:
            return None
        self._last = data
        return data

    @property
    def latest(self) -> bytes | None:
        return self._last


def _read_info(path: Path) -> dict[str, Any] | None:
    try:
        value: object = json.loads(path.read_bytes())
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        log.warning("unreadable %s", path)
        return None
    return value if isinstance(value, dict) else None  # pyright: ignore[reportUnknownVariableType]
