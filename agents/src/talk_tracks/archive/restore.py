"""Seeding a restarted agent from the archive: the newest snapshot of its own track. Transport-free.

The archiver rewrites ``<room>/latest/<agent>.json`` on every state change (``wiki/howto/archive.md``). Agents on the
VM see the archive on the shared data volume, next to their state folder: ``TT_ARCHIVE_DIR`` names it, and by default
it is ``archive/`` beside ``TT_STATE_DIR`` (``/data/archive`` on the VM, ``data/archive`` locally).
"""

from __future__ import annotations

import os
import time
from pathlib import Path

from pydantic import ValidationError

from ..contracts import CaptionsState, State, parse_room
from .store import Latest

MAX_AGE_S = 30 * 60  # older than this, the archived state belongs to an earlier talk (covers a VM restore)


def archive_dir(state_dir: Path) -> Path:
    configured = os.environ.get("TT_ARCHIVE_DIR")
    return Path(configured) if configured else state_dir.parent / "archive"


def max_age_s() -> float:
    return float(os.environ.get("TT_ARCHIVE_MAX_AGE_S", MAX_AGE_S))


def latest(root: Path, room: str, agent: str) -> Latest | None:
    """The newest archived snapshot of ``agent`` in ``room``, or None."""
    try:
        return Latest.model_validate_json((root / room / "latest" / f"{agent}.json").read_bytes())
    except (OSError, ValidationError):
        return None


def latest_state(
    root: Path, room: str, agent: str, *, max_age_s: float = MAX_AGE_S, now_ms: int | None = None
) -> State | None:
    """The state a restarted ``agent`` carries on from: its newest archived snapshot, unless it is too old."""
    found = latest(root, room, agent)
    if found is None:
        return None
    now = time.time_ns() // 1_000_000 if now_ms is None else now_ms
    if now - found.snapshot.wall_ms > max_age_s * 1000:
        return None
    return found.snapshot.state


def captions_for_state_file(path: Path, *, now_ms: int | None = None) -> CaptionsState | None:
    """The archived captions for the state file ``captions-<room>-<lang>.json`` that the captions agent keeps.

    The agent name is ``captions`` whatever the language, so the file name gives the room and the language to check.
    """
    stem = path.name.removesuffix(".json")
    if not stem.startswith("captions-"):
        return None
    rest = stem.removeprefix("captions-")
    root = archive_dir(path.parent)
    for i, c in enumerate(rest):  # the room may contain '-': try each split, the archived state's language decides
        if c != "-":
            continue
        room, lang = rest[:i], rest[i + 1 :]
        try:
            parse_room(room)
        except ValueError:
            continue
        state = latest_state(root, room, "captions", max_age_s=max_age_s(), now_ms=now_ms)
        if isinstance(state, CaptionsState) and state.lang == lang:
            return state
    return None
