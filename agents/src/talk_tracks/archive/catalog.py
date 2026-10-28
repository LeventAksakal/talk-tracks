"""The room catalog, ``talk/<room>/catalog``: every track of a room and its status (decision 0012, design §5.10).

Shaped after the MoQ streaming format's catalog (draft-ietf-moq-msf-01 §5): a list of tracks by namespace and name,
with ``packaging``, ``lang``, ``label`` and ``depends``. Talk Tracks adds ``kind``, ``sliceMs``, ``status`` (idle,
live or capped) and ``cost`` (paid on use, or free). Transport-free: the archiver feeds it the room's announcements
and publishes ``document()`` as a new group on every change and every ``REFRESH_S``.

Where each entry comes from, none of it a subscription to an agent track:

* the speaker's media: the hang catalog the archiver reads anyway, while ``talk/<room>/teacher`` is announced;
* slides: ``talk/<room>/slides`` announced;
* agent tracks: ``talk/<room>/agents/<agent>`` announced, with each track's ``track.json`` from the slice store.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from ..contracts import ROOT, slides_path, teacher_path
from .mp4 import TrackConfig
from .slices import TRACK_INFO, listdir

log = logging.getLogger("talk_tracks.archive.catalog")

TRACK = "catalog"
REFRESH_S = 4.0  # under moq-relay's 5 s max age, so a late joiner always gets the latest group


def catalog_path(room: str) -> str:
    return f"{ROOT}/{room}/catalog"


class RoomCatalog:
    def __init__(self, room: str, root: Path) -> None:
        self.room, self.root = room, root
        self.teacher: dict[str, TrackConfig] | None = None  # None: the speaker is not broadcasting
        self.slides = False
        self.agents: set[str] = set()
        self._last: bytes | None = None

    def document(self) -> dict[str, Any]:
        tracks: list[dict[str, Any]] = []
        for name, config in sorted((self.teacher or {}).items()):
            entry: dict[str, Any] = {
                "namespace": teacher_path(self.room),
                "name": name,
                "kind": config.kind,
                "packaging": "legacy",
                "codec": config.codec,
                "status": "live",
                "cost": "free",
            }
            tracks.append(entry)
        if self.slides:
            tracks.append(
                {
                    "namespace": slides_path(self.room),
                    "name": "frames",
                    "kind": "slides",
                    "packaging": "snapshot",
                    "status": "live",
                    "cost": "free",
                }
            )
        for agent in sorted(self.agents):
            folder = self.root / self.room / "agents" / agent
            for track in sorted(listdir(folder)):
                info = _read_info(folder / track / TRACK_INFO)
                if info is None:
                    continue
                entry = {"namespace": f"{ROOT}/{self.room}/agents/{agent}", "name": track}
                entry |= {k: v for k, v in info.items() if k not in ("name", "agent", "updated_ms") and v is not None}
                entry["depends"] = [f"{ROOT}/{self.room}/agents/{d}" for d in info.get("depends", [])]
                tracks.append(entry)
        return {"version": 1, "room": self.room, "archive": f"/archive/{self.room}/room.json", "tracks": tracks}

    def changed(self) -> bytes | None:
        """The catalog as JSON when it differs from the last one returned, else None."""
        data = json.dumps(self.document(), separators=(",", ":")).encode()
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
