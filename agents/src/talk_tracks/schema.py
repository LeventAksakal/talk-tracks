"""Write the JSON Schemas of the wire contracts to ``contracts/``. Run: ``uv run python -m talk_tracks.schema``."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from .contracts import CueObject, OutlineObject, RoomCatalog, SlideFrame, SlideObject
from .recording import RecordedSnapshot, Recording

CONTRACTS_DIR = Path(__file__).resolve().parents[3] / "contracts"


def schemas() -> dict[str, dict[str, Any]]:
    return {
        "cue-object.schema.json": CueObject.model_json_schema(),
        "slide-object.schema.json": SlideObject.model_json_schema(),
        "outline-object.schema.json": OutlineObject.model_json_schema(),
        "room-catalog.schema.json": RoomCatalog.model_json_schema(),
        "slide-frame.schema.json": SlideFrame.model_json_schema(),
        "recording.schema.json": Recording.model_json_schema(),
        "recorded-snapshot.schema.json": RecordedSnapshot.model_json_schema(),
    }


def render(schema: dict[str, Any]) -> str:
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"


def main() -> None:
    CONTRACTS_DIR.mkdir(exist_ok=True)
    for name, schema in schemas().items():
        (CONTRACTS_DIR / name).write_text(render(schema), encoding="utf-8", newline="\n")
        print("wrote", CONTRACTS_DIR / name, file=sys.stderr)


if __name__ == "__main__":
    main()
