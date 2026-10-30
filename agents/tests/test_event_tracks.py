"""The speaker's and the room's event tracks (ui-design §3.4, decision 0021): shapes, schemas, examples and
carry-ins."""

import json
from typing import Any

import jsonschema
import pytest
from pydantic import RootModel, ValidationError

from talk_tracks.contracts import (
    COMMENTS_TRACK,
    DECK_TRACK,
    INK_TRACK,
    MARKS_TRACK,
    POINTER_TRACK,
    ROOM_TRACK,
    SLICE_MS,
    SLIDE_TRACK,
    CommentRecord,
    CommentsObject,
    CurrentSlideObject,
    CurrentSlideRecord,
    DeckObject,
    InkObject,
    InkRecord,
    MarkRecord,
    MarksObject,
    PointerObject,
    RoomStateObject,
    annotations_path,
    comments_path,
    slides_path,
)
from talk_tracks.records import comments_carry, current_slide, encode, ink_carry, last_record, marks_carry
from talk_tracks.room_catalog import RoomCatalog, room_service_tracks, speaker_sources, speaker_tracks
from talk_tracks.schema import (
    ANNOTATIONS_INK,
    ANNOTATIONS_MARKS,
    COMMENTS,
    CONTRACTS_DIR,
    EXAMPLES_DIR,
    INK,
    MARKS,
    SLIDES,
    example_objects,
    examples,
    render,
)

MODELS: dict[str, type[RootModel[Any]]] = {
    "deck-object.schema.json": DeckObject,
    "current-slide-object.schema.json": CurrentSlideObject,
    "ink-object.schema.json": InkObject,
    "marks-object.schema.json": MarksObject,
    "pointer-object.schema.json": PointerObject,
    "comments-object.schema.json": CommentsObject,
    "room-state-object.schema.json": RoomStateObject,
}


def schema_of(name: str) -> dict[str, Any]:
    return json.loads((CONTRACTS_DIR / name).read_text(encoding="utf-8"))


def test_committed_examples_are_up_to_date() -> None:
    for name, example in examples().items():
        committed = (EXAMPLES_DIR / name).read_text(encoding="utf-8")
        assert committed == render(example), f"{name} is stale: run uv run python -m talk_tracks.schema"


def test_every_example_object_matches_its_schema_and_round_trips() -> None:
    for name, objects in example_objects().items():
        assert objects, name
        for obj in objects:
            wire = json.loads(encode(obj.root))
            jsonschema.validate(wire, schema_of(name))
            assert MODELS[name].model_validate_json(json.dumps(wire)) == obj


BY = {"id": "u-a", "name": "A"}
STYLE = {"stroke": "s", "deck": 0, "index": 0, "tool": "pen", "color": "#000000", "width": 0.01}
INK_BEGIN = {"kind": "begin", **STYLE, "by": BY}
MARK = {"kind": "mark", "id": "m", "deck": 0, "index": 0, "style": "underline", "color": "#000000", "by": BY}
IMAGE = {"kind": "image", "index": 0, "mime": "image/png", "width": 1, "height": 1, "data_b64": "AA=="}
RUN = {"id": "t1", "text": "x", "box": {"x": 0, "y": 0, "w": 0.5, "h": 0.1}}
REPLY = {"kind": "reply", "id": "r", "at": 5, "to": "c", "text": "x"}
BAD: list[tuple[str, Any]] = [
    ("ink-object.schema.json", [{"m": 1, "data": {**INK_BEGIN, "points": []}}]),
    ("ink-object.schema.json", [{"m": 1, "data": {**INK_BEGIN, "points": [[1.2, 0.5]]}}]),
    ("ink-object.schema.json", [{"m": 1, "data": {**INK_BEGIN, "points": [[0.5]]}}]),
    ("ink-object.schema.json", [{"m": 1, "data": {**INK_BEGIN, "color": "red", "points": [[0, 0]]}}]),
    ("ink-object.schema.json", [{"m": 1, "data": {**INK_BEGIN, "tool": "eraser", "points": [[0, 0]]}}]),
    ("ink-object.schema.json", [{"m": 1, "data": {"kind": "erase", "strokes": [], "by": BY}}]),
    ("ink-object.schema.json", [{"m": 1, "data": {"kind": "begin", **STYLE, "points": [[0, 0]]}}]),  # no author
    ("ink-object.schema.json", [{"m": 1, "data": {**INK_BEGIN, "by": {"id": "a b", "name": "A"}, "points": [[0, 0]]}}]),
    ("ink-object.schema.json", [{"m": 1, "data": {"kind": "clear", "deck": 0, "index": 0}}]),
    ("marks-object.schema.json", [{"m": 1, "data": {**MARK, "span": []}}]),
    ("marks-object.schema.json", [{"m": 1, "data": {**MARK, "style": "strike", "span": [{"run": "t1"}]}}]),
    ("marks-object.schema.json", [{"m": 1, "data": {"kind": "unmark", "marks": ["m"]}}]),
    ("pointer-object.schema.json", [{"m": 1, "data": {"kind": "at", "x": 0.5}}]),
    ("pointer-object.schema.json", [{"m": 1, "data": {"kind": "at", "x": 0.5, "y": -0.1}}]),
    ("current-slide-object.schema.json", [{"m": 1, "data": {"kind": "show", "deck": 0}}]),
    ("current-slide-object.schema.json", [{"m": 1, "data": {"kind": "next"}}]),
    ("deck-object.schema.json", [{"m": 1, "data": {"kind": "deck", "count": 0, "aspect": 1.5}}]),
    ("deck-object.schema.json", [{"m": 1, "data": {"kind": "image", "index": 0, "mime": "image/gif"}}]),
    (
        "deck-object.schema.json",
        [{"m": 1, "data": {**IMAGE, "runs": [{**RUN, "box": {"x": 0, "y": 0, "w": 2, "h": 1}}]}}],
    ),
    ("deck-object.schema.json", [{"m": 1, "data": {**IMAGE, "text": "a text layer without runs"}}]),
    ("room-state-object.schema.json", [{"m": 1, "data": {"kind": "state", "state": "live"}}]),
    ("comments-object.schema.json", [{"m": 1, "data": {"kind": "hide", "by": BY}}]),
    ("comments-object.schema.json", [{"m": 5, "data": {**REPLY, "by": {"id": "u", "name": ""}}}]),
    ("comments-object.schema.json", [{"m": 5, "data": {**REPLY, "author": "A"}}]),  # the field before decision 0021
]


@pytest.mark.parametrize(("name", "value"), BAD)
def test_schema_and_model_reject_what_breaks_the_contract(name: str, value: Any) -> None:
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(value, schema_of(name))
    with pytest.raises(ValidationError):
        MODELS[name].model_validate(value)


def test_model_checks_what_json_schema_cannot() -> None:
    anchor = {"deck": 0, "index": 0}
    comment = {"kind": "comment", "id": "c", "at": 5, "by": BY, "text": "x", "anchor": anchor}
    CommentsObject.model_validate([{"m": 5, "data": comment}])
    with pytest.raises(ValidationError, match="before its at"):
        CommentsObject.model_validate([{"m": 4, "data": comment}])
    backwards = [{"run": "t1", "start": 3, "end": 2}]
    with pytest.raises(ValidationError, match="ends before it starts"):
        CommentsObject.model_validate([{"m": 5, "data": {**comment, "anchor": {**anchor, "span": backwards}}}])
    with pytest.raises(ValidationError, match="ends before it starts"):
        MarksObject.model_validate([{"m": 5, "data": {**MARK, "span": backwards}}])
    with pytest.raises(ValidationError, match="run ids repeat"):
        DeckObject.model_validate([{"m": 1, "data": {**IMAGE, "runs": [RUN, RUN]}}])


def slices_before(records: list[Any], k: int) -> list[Any]:
    return [r for r in records if r.m < k * SLICE_MS]


def in_slice(records: list[Any], k: int) -> list[Any]:
    return [r for r in records if k * SLICE_MS <= r.m < (k + 1) * SLICE_MS]


@pytest.mark.parametrize("k", [2, 3, 4])
def test_a_carry_in_is_rebuilt_from_the_previous_one_alone(k: int) -> None:
    """Seeking reads one group: object 0 of slice k+1, built from slice k's carry-in and records, is the one built
    from the whole history."""
    slides_then: list[CurrentSlideRecord] = slices_before(SLIDES, k)
    slides_now: list[CurrentSlideRecord] = slices_before(SLIDES, k + 1)
    on_then, on_now = current_slide(slides_then), current_slide(slides_now)
    assert current_slide([*last_record(slides_then), *in_slice(SLIDES, k)]) == on_now

    for track in (INK, ANNOTATIONS_INK):
        ink: list[InkRecord] = [*ink_carry(slices_before(track, k), on_then), *in_slice(track, k)]
        assert ink_carry(ink, on_now) == ink_carry(slices_before(track, k + 1), on_now)

    for track in (MARKS, ANNOTATIONS_MARKS):
        marks: list[MarkRecord] = [*marks_carry(slices_before(track, k), on_then), *in_slice(track, k)]
        assert marks_carry(marks, on_now) == marks_carry(slices_before(track, k + 1), on_now)

    comments: list[CommentRecord] = [*comments_carry(slices_before(COMMENTS, k), on_then), *in_slice(COMMENTS, k)]
    assert comments_carry(comments, on_now) == comments_carry(slices_before(COMMENTS, k + 1), on_now)


def test_carry_ins_show_what_is_on_the_slide_on_screen() -> None:
    on = current_slide(slices_before(SLIDES, 4))
    assert on is not None and on.index == 1
    assert [r.data.stroke for r in ink_carry(slices_before(INK, 4), on) if r.data.kind == "stroke"] == ["s1", "s3"]
    assert [r.data.id for r in comments_carry(slices_before(COMMENTS, 4), on) if r.data.kind != "hide"] == ["c1", "c2"]
    assert ink_carry(INK, None) == [] and comments_carry(COMMENTS, None) == [] and marks_carry(MARKS, None) == []


def ids(records: list[Any]) -> list[str]:
    return [getattr(r.data, "stroke", None) or r.data.id for r in records]


def test_only_the_author_or_the_speaker_changes_an_annotation() -> None:
    on = current_slide(slices_before(SLIDES, 3))
    # Bob's erase of Ada's stroke is ignored, Ada's clear takes only her own, the speaker's erase takes Bob's.
    assert ids(ink_carry([r for r in ANNOTATIONS_INK if r.m < 11_400], on)) == ["u-ada-1", "u-bob-1", "u-ada-2"]
    assert ids(ink_carry([r for r in ANNOTATIONS_INK if r.m <= 11_400], on)) == ["u-bob-1"]
    assert ids(ink_carry(slices_before(ANNOTATIONS_INK, 4), on)) == ["u-ada-3"]
    # Bob's unmark of Ada's underline is ignored.
    assert ids(marks_carry(slices_before(ANNOTATIONS_MARKS, 3), on)) == ["u-ada-m1", "u-grace-m1"]
    # Bob's edit of Ada's comment and Eve's hide of Alan's are ignored; the speaker hid Bob's comment with its reply.
    threads = comments_carry(slices_before(COMMENTS, 4), on)
    assert [(r.data.id, getattr(r.data, "text", None)) for r in threads] == [
        ("c1", "Why 4 s slices?"),
        ("c2", "So a seek lands close."),
    ]
    assert ids(comments_carry(slices_before(COMMENTS, 4), current_slide(SLIDES[:1]))) == ["c4"]


def test_the_room_catalog_lists_sources_and_event_tracks() -> None:
    room = "physics-101"
    tracks = (*speaker_tracks(room), *room_service_tracks(room))
    sources = speaker_sources(room, camera=True, slides=True)
    doc: Any = RoomCatalog(1_800_000_000_000, tracks, {300: 0}, {}, sources).to_json()
    jsonschema.validate(doc, schema_of("room-catalog.schema.json"))

    by_name = {(t["namespace"], t["name"]): t for t in doc["tracks"]}
    slides = slides_path(room)
    annotations = annotations_path(room)
    assert set(by_name) == {
        (slides, DECK_TRACK),
        (slides, SLIDE_TRACK),
        (slides, INK_TRACK),
        (slides, MARKS_TRACK),
        (slides, POINTER_TRACK),
        (f"talk/{room}/catalog", ROOM_TRACK),
        (comments_path(room), COMMENTS_TRACK),
        (annotations, INK_TRACK),
        (annotations, MARKS_TRACK),
    }
    assert "template" not in by_name[(slides, DECK_TRACK)]
    assert by_name[(slides, INK_TRACK)]["template"][1] == SLICE_MS
    assert by_name[(annotations, MARKS_TRACK)]["eventType"] == by_name[(slides, MARKS_TRACK)]["eventType"]
    assert by_name[(annotations, INK_TRACK)]["tt"]["dependsOn"] == [f"{slides}/{SLIDE_TRACK}"]
    assert all(t["packaging"] == "eventtimeline" and t["tt"]["cost"] == "free" for t in doc["tracks"])
    assert [s["kind"] for s in doc["tt"]["sources"]] == ["audio", "camera", "slides"]
    assert MARKS_TRACK in doc["tt"]["sources"][2]["tracks"]
    assert speaker_sources(room) == speaker_sources(room, audio=True, camera=False, slides=False)
