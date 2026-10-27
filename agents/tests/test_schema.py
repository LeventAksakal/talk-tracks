import json
from pathlib import Path

import jsonschema

from talk_tracks.contracts import ENVELOPE, AgentInfo, CaptionsState, Envelope, Usage
from talk_tracks.recording import MANIFEST, RecordingWriter
from talk_tracks.schema import CONTRACTS_DIR, render, schemas


def test_committed_schemas_are_up_to_date() -> None:
    for name, schema in schemas().items():
        committed = (CONTRACTS_DIR / name).read_text(encoding="utf-8")
        assert committed == render(schema), f"{name} is stale: run uv run python -m talk_tracks.schema"


def test_envelope_validates_against_its_own_schema() -> None:
    env = Envelope(
        agent=AgentInfo(name="captions", label="Captions", model="muse-voice-transcribe-1.0"),
        instance="1",
        seq=3,
        at_ms=10,
        usage=Usage(),
        state=CaptionsState(lang="en", lines=[]),
    )
    schema = json.loads((CONTRACTS_DIR / "envelope.schema.json").read_text(encoding="utf-8"))
    jsonschema.validate(json.loads(ENVELOPE.dump_json(env)), schema)


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
