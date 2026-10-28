import json
from pathlib import Path
from typing import Any

import jsonschema
import pytest
from pydantic import RootModel, ValidationError

from talk_tracks.contracts import (
    CUE_EVENT,
    MOQ_EPOCH_UNIX_MS,
    AgentInfo,
    CaptionsState,
    CarryData,
    CarryNote,
    CarryRecord,
    CatalogTrack,
    ChapterData,
    Cue,
    CueObject,
    CueRecord,
    Envelope,
    OutlineObject,
    OutlineRecord,
    RecapData,
    RoomCatalog,
    RoomTt,
    Slide,
    SlideObject,
    SlideRecord,
    TermData,
    TrackStatus,
    TrackTt,
    Usage,
    room_ms,
    slice_template,
    wall_unix_ms,
)
from talk_tracks.recording import MANIFEST, RecordingWriter
from talk_tracks.schema import CONTRACTS_DIR, render, schemas


def test_committed_schemas_are_up_to_date() -> None:
    for name, schema in schemas().items():
        committed = (CONTRACTS_DIR / name).read_text(encoding="utf-8")
        assert committed == render(schema), f"{name} is stale: run uv run python -m talk_tracks.schema"


def schema_of(name: str) -> dict[str, Any]:
    return json.loads((CONTRACTS_DIR / name).read_text(encoding="utf-8"))


CUE = Cue(start=8100, end=9900, id="8100", text="hello", rev=1, final=True)
NOTE = CarryRecord(m=8000, data=CarryData(tt=CarryNote(from_=8100)))


def test_objects_validate_against_their_own_schemas() -> None:
    cases: tuple[tuple[str, RootModel[Any]], ...] = (
        ("cue-object.schema.json", CueObject([NOTE, CueRecord(m=8100, data=CUE)])),
        ("cue-object.schema.json", CueObject([CarryRecord(m=8000, data=CarryData(tt=CarryNote(capped=True)))])),
        ("slide-object.schema.json", SlideObject([SlideRecord(m=5, data=Slide(id=1, at=5, text="a chart"))])),
        (
            "outline-object.schema.json",
            OutlineObject(
                [
                    OutlineRecord(m=0, data=ChapterData(id=0, start=0, title="Intro", summary="Why")),
                    OutlineRecord(m=9000, data=TermData(term="MoQ", definition="Media over QUIC")),
                    OutlineRecord(m=9000, data=RecapData(text="So far")),
                ]
            ),
        ),
    )
    for name, obj in cases:
        jsonschema.validate(json.loads(obj.model_dump_json(exclude_defaults=True)), schema_of(name))
        jsonschema.validate(json.loads(obj.model_dump_json()), schema_of(name))


def test_a_record_is_m_and_data_with_m_its_start() -> None:
    wire = json.loads(CueObject([NOTE, CueRecord(m=8100, data=CUE)]).model_dump_json(exclude_defaults=True))
    assert wire == [
        {"m": 8000, "data": {"tt": {"from": 8100}}},
        {"m": 8100, "data": {"start": 8100, "end": 9900, "id": "8100", "text": "hello", "rev": 1, "final": True}},
    ]
    with pytest.raises(ValidationError):
        CueRecord(m=8000, data=CUE)
    with pytest.raises(ValidationError):
        SlideRecord(m=4, data=Slide(id=1, at=5, text="x"))
    with pytest.raises(ValidationError):
        Cue(start=10, end=9, id="10", text="x", final=False)
    with pytest.raises(ValidationError):
        CueObject([CueRecord(m=8100, data=CUE), NOTE])  # the note comes first


def test_the_room_catalog_carries_epoch_shift_and_status() -> None:
    catalog = RoomCatalog(
        tracks=[
            CatalogTrack(
                name="items",
                namespace="talk/r/agents/translate-tr",
                packaging="eventtimeline",
                mimeType="application/json",
                eventType=CUE_EVENT,
                role="subtitle",
                lang="tr",
                isLive=True,
                template=slice_template(1_800_000_000_000),
                tt=TrackTt(dependsOn=["talk/r/agents/captions/items"], latenessMs=4000, cost="paid"),
            )
        ],
        tt=RoomTt(
            E=1_800_000_000_000,
            shift={"300000000000": 0},
            status={
                "translate-tr": TrackStatus(
                    status="live", producing=True, fetches_served=2, backfills=1, spend_usd=0.01, updated_ms=1
                )
            },
        ),
    )
    jsonschema.validate(json.loads(catalog.model_dump_json(exclude_none=True)), schema_of("room-catalog.schema.json"))
    with pytest.raises(ValidationError, match="whole slices"):
        RoomTt(E=1_800_000_000_001, shift={})


def test_room_time_from_the_hang_clock() -> None:
    wall = 300_000_000_000_000  # µs since 2020-01-01
    at = wall_unix_ms(wall, 1_000_000, 1_500)
    assert at == MOQ_EPOCH_UNIX_MS + 300_000_000_000 + 1_500
    assert room_ms(at, epoch=MOQ_EPOCH_UNIX_MS + 300_000_000_000, shift=8000) == 9_500


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
