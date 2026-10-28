import json
from pathlib import Path

import jsonschema
import pytest
from pydantic import ValidationError

from talk_tracks.contracts import (
    ENVELOPE,
    AgentInfo,
    CaptionItem,
    CaptionLine,
    CaptionsCarry,
    CaptionsState,
    Envelope,
    OutlineSnapshot,
    Usage,
)
from talk_tracks.recording import MANIFEST, RecordingWriter
from talk_tracks.schema import CONTRACTS_DIR, render, schemas


def test_committed_schemas_are_up_to_date() -> None:
    for name, schema in schemas().items():
        committed = (CONTRACTS_DIR / name).read_text(encoding="utf-8")
        assert committed == render(schema), f"{name} is stale: run uv run python -m talk_tracks.schema"


INFO = AgentInfo(name="captions", label="Captions", model="muse-voice-transcribe-1.0")
LINE = CaptionLine(id=7, start_ms=8100, end_ms=9900, text="hello")


def test_envelopes_validate_against_their_own_schema() -> None:
    schema = json.loads((CONTRACTS_DIR / "envelope.schema.json").read_text(encoding="utf-8"))
    for kind, body, capped in (
        ("carry", CaptionsCarry(lang="en", lines=[LINE]), False),
        ("carry", CaptionsCarry(lang="en", lines=[]), True),
        ("item", CaptionItem(lang="en", line=LINE, final=True), False),
        ("snapshot", OutlineSnapshot(lang="en", chapters=[], glossary=[]), False),
    ):
        env = Envelope(agent=INFO, slice=2, kind=kind, capped=capped, at_ms=10, usage=Usage(), body=body)
        jsonschema.validate(json.loads(ENVELOPE.dump_json(env)), schema)


def test_kind_must_match_the_body() -> None:
    with pytest.raises(ValidationError):
        Envelope(agent=INFO, slice=0, kind="item", at_ms=0, usage=Usage(), body=CaptionsCarry(lang="en", lines=[]))
    with pytest.raises(ValidationError):
        Envelope(
            agent=INFO,
            slice=0,
            kind="item",
            capped=True,
            at_ms=0,
            usage=Usage(),
            body=CaptionItem(lang="en", line=LINE, final=False),
        )


def test_recording_files_validate_against_their_schemas(tmp_path: Path) -> None:
    rec = RecordingWriter(tmp_path, "loop-gen", wall_ms=1, media="lecture.mp4")
    snapshot = rec.add(
        Envelope(
            agent=AgentInfo(name="captions", label="Captions", model="fake"),
            instance="1",
            seq=1,
            at_ms=10,
            usage=Usage(),
            state=CaptionsState(lang="en", lines=[]),
        ),
        media_ms=0,
        wall_ms=2,
    )
    rec.close(wall_ms=3)
    manifest_schema = json.loads((CONTRACTS_DIR / "recording.schema.json").read_text(encoding="utf-8"))
    snapshot_schema = json.loads((CONTRACTS_DIR / "recorded-snapshot.schema.json").read_text(encoding="utf-8"))
    jsonschema.validate(json.loads((tmp_path / MANIFEST).read_text(encoding="utf-8")), manifest_schema)
    jsonschema.validate(json.loads(snapshot.model_dump_json()), snapshot_schema)
