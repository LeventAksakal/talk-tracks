"""Small file helpers shared by the archive modules."""

from __future__ import annotations

import os
from pathlib import Path


def write_atomic(path: Path, data: bytes) -> None:
    """Replace ``path`` with ``data`` in one step: a reader sees the old file or the new one, never a part."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)
