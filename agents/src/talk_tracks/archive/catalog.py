"""The room catalog, ``talk/<room>/catalog``: an MSF catalog of the room's AI tracks (design §5.10).

``msf_catalog`` builds the document (draft-ietf-moq-msf-01 §5), so a looper can publish the same shape for its demo
rooms:

* root ``version: "draft-01"`` and the Talk Tracks extension ``tt``: the room epoch ``E``, ``shift`` (one entry per
  teacher broadcast, keyed by its hang ``clock.wall``, in ms, design §4.5), ``status`` (per agent: ``live``, ``idle``
  or ``capped``) and ``media`` (the speaker's HLS playlist, for rewind);
* one track object per AI track: ``name``, ``namespace``, ``packaging: "eventtimeline"``, ``mimeType``,
  ``eventType``, ``role`` (captions and translations), ``lang``, ``isLive``, ``template`` (the 4 s slices on room
  time, MSF §7.4; not on the outline) and ``tt`` with ``dependsOn`` (full track paths), ``latenessMs`` and ``cost``.

Status is not a track attribute, because MSF forbids changing a declared track (MSF §5.3). It comes from each track's
``track.json`` in the slice store (``TrackArchive.set_status``) and from the spend ledger: a room at its cap, or the
build at its ceiling, is ``capped`` for every paid agent.

``RoomCatalog`` is what the archiver publishes: agents as they are announced (never a subscription to their tracks,
which would be demand), each track's ``track.json``, and the room's clock from the archive. Each change is a new group
whose object 0 is the full catalog.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..contracts import ROOT
from .slices import SLICE_MS, TRACK_INFO, listdir

log = logging.getLogger("talk_tracks.archive.catalog")

TRACK = "catalog"
REFRESH_S = 4.0  # under moq-relay's 5 s max age, so a late joiner always gets the latest group
VERSION = "draft-01"
STALE_MS = 30_000  # a track.json not rewritten for this long is idle: its agent stopped without saying so
EVENT_TYPES = {
    "captions": "urn:msf:captions:webvtt",
    "translation": "urn:msf:captions:webvtt",
    "slides": "com.talktracks.slides",
    "outline": "com.talktracks.outline",
}
ROLES = {"captions": "caption", "translation": "subtitle"}
RANK = {"idle": 0, "live": 1, "capped": 2}


def catalog_path(room: str) -> str:
    return f"{ROOT}/{room}/catalog"


def agent_path(room: str, agent: str) -> str:
    return f"{ROOT}/{room}/agents/{agent}"


def template(epoch_ms: int) -> list[Any]:
    """MSF §7.4: group k starts at E + k * 4000 ms, object 0 at its start."""
    return [0, SLICE_MS, [0, 0], [1, 0], epoch_ms, SLICE_MS]


def track_object(room: str, agent: str, track: str, info: dict[str, Any], epoch_ms: int | None) -> dict[str, Any]:
    """One MSF track object from a ``track.json`` (``TrackInfo``)."""
    kind = str(info.get("kind", ""))
    entry: dict[str, Any] = {
        "name": track,
        "namespace": agent_path(room, agent),
        "packaging": "eventtimeline",
        "mimeType": "application/json",
        "eventType": EVENT_TYPES.get(kind, f"com.talktracks.{kind or 'items'}"),
    }
    if kind in ROLES:
        entry["role"] = ROLES[kind]
    if info.get("label"):
        entry["label"] = info["label"]
    if info.get("lang"):
        entry["lang"] = info["lang"]
    entry["isLive"] = True
    if kind != "outline" and epoch_ms is not None:
        entry["template"] = template(epoch_ms)
    entry["tt"] = {
        "dependsOn": [f"{ROOT}/{room}/agents/{d}" for d in info.get("depends", [])],
        "latenessMs": int(info.get("lateness_ms") or 0),
        "cost": info.get("cost", "paid"),
    }
    return entry


def msf_catalog(
    room: str,
    tracks: list[dict[str, Any]],
    *,
    epoch_ms: int | None,
    shift: dict[str, int],
    status: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    tt: dict[str, Any] = {"shift": dict(shift), "status": status, "media": f"/archive/{room}/index.m3u8"}
    if epoch_ms is not None:
        tt = {"E": epoch_ms, **tt}
    return {"version": VERSION, "tt": tt, "tracks": tracks}


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


class RoomCatalog:
    def __init__(self, room: str, root: Path, *, capped: Callable[[str], bool] | None = None) -> None:
        self.room, self.root, self._capped = room, root, capped
        self.agents: set[str] = set()  # announced now
        self.epoch_ms: int | None = None
        self.shift: dict[str, int] = {}
        self._last: bytes | None = None

    def document(self, now_ms: int | None = None) -> dict[str, Any]:
        now = int(time.time() * 1000) if now_ms is None else now_ms
        capped = self._capped is not None and self._capped(self.room)
        tracks: list[dict[str, Any]] = []
        status: dict[str, dict[str, Any]] = {}
        for agent in sorted(self.agents):
            folder = self.root / self.room / "agents" / agent
            state = "idle"
            paid = False
            for track in sorted(listdir(folder)):
                info = _read_info(folder / track / TRACK_INFO)
                if info is None:
                    continue
                tracks.append(track_object(self.room, agent, track, info, self.epoch_ms))
                paid = paid or info.get("cost", "paid") == "paid"
                said = str(info.get("status", "idle"))
                if said in RANK and now - int(info.get("updated_ms") or 0) < STALE_MS and RANK[said] > RANK[state]:
                    state = said
            if capped and paid:
                state = "capped"
            status[agent_path(self.room, agent)] = {"state": state}
        return msf_catalog(self.room, tracks, epoch_ms=self.epoch_ms, shift=self.shift, status=status)

    def changed(self, now_ms: int | None = None) -> bytes | None:
        """The catalog as JSON when it differs from the last one returned, else None."""
        data = json.dumps(self.document(now_ms), separators=(",", ":")).encode()
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
