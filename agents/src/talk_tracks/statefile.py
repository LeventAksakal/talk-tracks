"""An agent's last state on local disk, so a restarted process carries on where it stopped.

The relay keeps nothing once a publisher is gone, so a replacement cannot read its predecessor's track; the file is
the bridge. A state older than ``max_age_s`` belongs to an earlier talk and is ignored.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path

from pydantic import ValidationError

from .contracts import CaptionsState

log = logging.getLogger("talk_tracks")

MAX_AGE_S = 15 * 60


def load_captions(path: Path, max_age_s: float = MAX_AGE_S) -> CaptionsState | None:
    try:
        if time.time() - path.stat().st_mtime > max_age_s:
            return None
        state = CaptionsState.model_validate_json(path.read_bytes())
    except (OSError, ValidationError):
        return None
    log.info("resuming %d caption lines from %s", len(state.lines), path)
    return state


def save(path: Path, state: CaptionsState) -> None:
    """Write-then-rename, so a crash mid-write leaves the previous state in place."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(state.model_dump_json(), encoding="utf-8")
    os.replace(tmp, path)
