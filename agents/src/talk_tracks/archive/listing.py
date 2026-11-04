"""The public room list (``GET /api/rooms``): every room presenters made, for the hub's Live now and Recordings rows.

Rooms come from three places the room service already keeps: the rooms access codes created (``rooms_dir``, with
their title and speaker), the minted judge batches in the caps folder, and the track archive (``rooms.json``, any
room a speaker went on air in). The demo lectures, their recording rooms and the looped or skipped rooms are not
listed (the hub has them from its own data), nor any room the coordinator hides in the denylist file
(``TT_ROOMS_HIDDEN``, default ``rooms-hidden.txt`` beside the archive folder; ``wiki/howto/tokens.md``).

Live is the room's own state track (``RoomEvents``: ``on_air`` while a teacher broadcast sends media, ``ended`` once
the speaker pressed End talk), or, before that track exists, the archive's live flag. Times and the length come from
the room's ``room.json`` in the archive; the still is the first slide frame the archive kept.

Each entry: ``{"room", "title", "speaker", "state": "upcoming" | "live" | "ended", "created", "started", "ended",
"duration", "recording", "still"}`` (times in Unix seconds, the length in seconds, null when unknown). Never a code,
a label, a cap, a token or an address.
"""

from __future__ import annotations

import fnmatch
import logging
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .create import RECORDING_SUFFIX, CreatedRoom, Registry
from .store import RoomIndex, SlideLine

log = logging.getLogger("talk_tracks.archive.listing")

State = Literal["upcoming", "live", "ended"]
RoomState = Literal["waiting", "on_air", "paused", "ended"]
TTL_S = 5.0  # the list is built at most this often


class Denylist:
    """Rooms the coordinator hides: one room name or glob pattern a line, ``#`` comments. Read again when the file
    changes; no file, nothing hidden."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self._seen: tuple[float, int] | None = None
        self._patterns: list[str] = []

    def patterns(self) -> list[str]:
        if self.path is None:
            return []
        try:
            stat = self.path.stat()
        except OSError:
            self._seen, self._patterns = None, []
            return []
        if self._seen != (stat.st_mtime, stat.st_size):
            self._seen = (stat.st_mtime, stat.st_size)
            try:
                lines = self.path.read_text(encoding="utf-8").splitlines()
            except OSError as e:
                log.warning("the hidden rooms file is unreadable: %s", e)
                lines = []
            self._patterns = [p for line in lines if (p := line.split("#", 1)[0].strip())]
        return self._patterns

    def __call__(self, room: str) -> bool:
        return any(fnmatch.fnmatchcase(room, p) for p in self.patterns())


@dataclass(frozen=True)
class Archived:
    started_ms: int
    last_ms: int
    duration_ms: int | None
    still: str | None


def read_archived(root: Path, room: str) -> Archived | None:
    """A room's archive: when its first broadcast started and its last wrote, its length in room time, and the first
    slide frame it kept (an archive path, ``/archive/<room>/<run>/slides/<file>``). None without a recorded run."""
    try:
        runs = RoomIndex.model_validate_json((root / room / "room.json").read_bytes()).runs
    except (OSError, ValueError):
        return None
    if not runs:
        return None
    media = [r.media_last_ms + 1 for r in runs if r.media_last_ms is not None]
    still = None
    for r in runs:
        if "/" in r.run or ".." in r.run:
            continue
        try:
            with (root / room / r.run / "slides" / "frames.jsonl").open("rb") as f:
                file = SlideLine.model_validate_json(f.readline()).file
        except (OSError, ValueError):
            continue
        if "/" not in file and ".." not in file:
            still = f"/archive/{room}/{r.run}/slides/{file}"
            break
    return Archived(
        min(r.started_wall_ms for r in runs), max(r.last_wall_ms for r in runs), max(media) if media else None, still
    )


def _s(ms: int | None) -> int | None:
    return ms // 1000 if ms is not None else None


class RoomListing:
    """``GET /api/rooms``. ``archived_rooms()``: the rooms the archive knows; ``room_state(room)``: the room's state
    track now (None: none yet); ``listed(room)``: a room the hub may show (not a demo, looped or skipped room)."""

    def __init__(
        self,
        registry: Registry,
        archive_root: Path,
        *,
        archived_rooms: Callable[[], Iterable[str]],
        room_state: Callable[[str], RoomState | None],
        listed: Callable[[str], bool] = lambda _: True,
        hidden: Callable[[str], bool] = lambda _: False,
        wall: Callable[[], float] = time.time,
        ttl_s: float = TTL_S,
    ) -> None:
        self.registry, self.archive_root = registry, archive_root
        self.archived_rooms, self.room_state, self.listed, self.hidden = archived_rooms, room_state, listed, hidden
        self.wall, self.ttl_s = wall, ttl_s
        self._cached: tuple[float, dict[str, Any]] | None = None

    def answer(self) -> dict[str, Any]:
        """The list, built again once it is ``ttl_s`` old."""
        now = self.wall()
        if self._cached is None or now - self._cached[0] >= self.ttl_s:
            self._cached = (now, {"rooms": self.rooms(now)})
        return self._cached[1]

    def rooms(self, now: float) -> list[dict[str, Any]]:
        created = {c.room: c for c in self.registry.all_created()}
        names = {*created, *self.registry.batch_rooms(), *self.archived_rooms()}
        out: list[dict[str, Any]] = []
        for room in sorted(names):
            if room.endswith(RECORDING_SUFFIX) or not self.listed(room) or self.hidden(room):
                continue
            try:
                out.append(self._entry(room, created.get(room), now))
            except Exception:  # one broken room never hides the others
                log.exception("listing room %s failed", room)
        return out

    def _entry(self, room: str, created: CreatedRoom | None, now: float) -> dict[str, Any]:
        archived = read_archived(self.archive_root, room)
        said = self.room_state(room)
        recording = archived is not None and archived.duration_ms is not None
        if said == "on_air":
            state: State = "live"
        elif said == "ended" or recording:
            state = "ended"
        else:
            state = "upcoming"
        started = _s(archived.started_ms) if archived else None
        ended = _s(archived.last_ms) if archived and state == "ended" else None
        if state == "live":
            duration = int(now) - started if started is not None else None
        else:
            duration = _s(archived.duration_ms) if archived else None
        return {
            "room": room,
            "title": created.title if created is not None else room,
            "speaker": created.speaker if created is not None else None,
            "state": state,
            "created": created.created if created is not None else None,
            "started": started,
            "ended": ended,
            "duration": duration,
            "recording": recording,
            "still": archived.still if archived else None,
        }
