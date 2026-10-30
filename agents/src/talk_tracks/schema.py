"""Write the JSON Schemas of the wire contracts to ``contracts/``, and examples both test suites read back. Run:
``uv run python -m talk_tracks.schema``.

``contracts/examples/objects.json`` holds valid objects per schema; ``contracts/examples/carry-ins.json`` holds, per
speaker or room track, a history of records and the carry-in ``records.py`` builds from it, so the web's reducers
can be checked against the same answer."""

from __future__ import annotations

import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from pydantic import BaseModel, RootModel

from .contracts import (
    Anchor,
    Comment,
    CommentEdit,
    CommentHide,
    CommentRecord,
    CommentsObject,
    CueObject,
    CurrentSlideObject,
    CurrentSlideRecord,
    DeckImage,
    DeckInfo,
    DeckObject,
    DeckRecord,
    HideSlide,
    InkBegin,
    InkClear,
    InkEnd,
    InkErase,
    InkObject,
    InkPoints,
    InkRecord,
    InkStroke,
    OutlineObject,
    Point,
    PointerAt,
    PointerObject,
    PointerOff,
    PointerRecord,
    Region,
    Reply,
    RoomCatalog,
    RoomState,
    RoomStateObject,
    RoomStateRecord,
    ShowSlide,
    SlideFrame,
    SlideObject,
    TextSpan,
)
from .recording import RecordedSnapshot, Recording
from .records import comments_carry, current_slide, ink_carry, last_record

CONTRACTS_DIR = Path(__file__).resolve().parents[3] / "contracts"
EXAMPLES_DIR = CONTRACTS_DIR / "examples"


def schemas() -> dict[str, dict[str, Any]]:
    return {
        "cue-object.schema.json": CueObject.model_json_schema(),
        "slide-object.schema.json": SlideObject.model_json_schema(),
        "outline-object.schema.json": OutlineObject.model_json_schema(),
        "deck-object.schema.json": DeckObject.model_json_schema(),
        "current-slide-object.schema.json": CurrentSlideObject.model_json_schema(),
        "ink-object.schema.json": InkObject.model_json_schema(),
        "pointer-object.schema.json": PointerObject.model_json_schema(),
        "comments-object.schema.json": CommentsObject.model_json_schema(),
        "room-state-object.schema.json": RoomStateObject.model_json_schema(),
        "room-catalog.schema.json": RoomCatalog.model_json_schema(),
        "slide-frame.schema.json": SlideFrame.model_json_schema(),
        "recording.schema.json": Recording.model_json_schema(),
        "recorded-snapshot.schema.json": RecordedSnapshot.model_json_schema(),
    }


# --- examples: a short talk on one deck, loaded at 8 s -------------------------------------------------------

DECK = 2  # the deck track's group: loaded in slice 2
RED = "#e53935"

SLIDES = [
    CurrentSlideRecord(m=8_000, data=ShowSlide(deck=DECK, index=0)),
    CurrentSlideRecord(m=9_500, data=ShowSlide(deck=DECK, index=1)),
    CurrentSlideRecord(m=14_200, data=ShowSlide(deck=DECK, index=0)),
    CurrentSlideRecord(m=15_000, data=HideSlide()),
    CurrentSlideRecord(m=15_500, data=ShowSlide(deck=DECK, index=1)),
]
S1 = [(0.1, 0.1), (0.12, 0.11), (0.15, 0.13)]
S3 = [(0.5, 0.5), (0.55, 0.52)]


def pen(m: int, stroke: str, index: int, points: list[Point]) -> InkRecord:
    return InkRecord(
        m=m, data=InkBegin(stroke=stroke, deck=DECK, index=index, tool="pen", color=RED, width=0.004, points=points)
    )


def resent(m: int, stroke: str, points: list[Point]) -> InkRecord:
    """A stroke of slide 1 sent again when the slide is shown again."""
    return InkRecord(
        m=m,
        data=InkStroke(stroke=stroke, deck=DECK, index=1, tool="pen", color=RED, width=0.004, points=points, done=True),
    )


INK = [
    pen(9_600, "s1", 1, S1[:1]),
    InkRecord(m=9_650, data=InkPoints(stroke="s1", points=S1[1:])),
    InkRecord(m=9_700, data=InkEnd(stroke="s1")),
    InkRecord(
        m=10_000,
        data=InkBegin(
            stroke="s2", deck=DECK, index=1, tool="highlighter", color="#FFEB3B", width=0.02, points=[(0.2, 0.5)]
        ),
    ),
    InkRecord(m=10_100, data=InkEnd(stroke="s2")),
    InkRecord(m=10_400, data=InkErase(strokes=["s2"])),
    pen(11_000, "s3", 1, S3[:1]),
    InkRecord(m=11_050, data=InkPoints(stroke="s3", points=S3[1:])),
    pen(14_300, "s4", 0, [(0.9, 0.9)]),  # slide 0, shown at 14.2 s with no ink
    InkRecord(m=14_400, data=InkEnd(stroke="s4")),
    InkRecord(m=14_500, data=InkClear(deck=DECK, index=0)),
    InkRecord(m=15_100, data=InkEnd(stroke="s3")),
    resent(15_500, "s1", S1),  # slide 1 shown again: its ink comes back
    resent(15_500, "s3", S3),
]
POINTER = [
    PointerRecord(m=11_200, data=PointerAt(x=0.4, y=0.3)),
    PointerRecord(m=11_250, data=PointerAt(x=0.41, y=0.31)),
    PointerRecord(m=11_300, data=PointerOff()),
    PointerRecord(m=15_900, data=PointerAt(x=0.7, y=0.2)),
]
ASKED = Anchor(deck=DECK, index=1, region=Region(x=0.1, y=0.1, w=0.3, h=0.1), span=TextSpan(start=0, end=12))
C1 = Comment(id="c1", at=9_800, author="Ada", text="Why 4 s slices?", anchor=ASKED, question=True)
C2 = Reply(id="c2", at=10_200, to="c1", author="Grace", text="A seek lands close.")
C4 = Comment(id="c4", at=11_000, author="Alan", text="Nice chart", anchor=Anchor(deck=DECK, index=0))
COMMENTS = [
    CommentRecord(m=9_800, data=C1),
    CommentRecord(m=10_200, data=C2),
    CommentRecord(
        m=10_300, data=Reply(id="c3", at=10_300, to="c1", author="Levent", text="Slide 9 says.", speaker=True)
    ),
    CommentRecord(m=10_400, data=CommentEdit(id="c2", text="So a seek lands close.")),
    CommentRecord(m=11_000, data=C4),
    CommentRecord(
        m=11_500, data=Comment(id="c5", at=11_500, author="Bob", text="spam", anchor=Anchor(deck=DECK, index=1))
    ),
    CommentRecord(m=11_600, data=Reply(id="c6", at=11_600, to="c5", author="Eve", text="more spam")),
    CommentRecord(m=12_000, data=CommentHide(id="c5")),
    CommentRecord(m=12_100, data=CommentHide(id="c3")),
    CommentRecord(m=14_200, data=C4),  # slide 0 shown: its threads come back
    CommentRecord(m=15_500, data=C1),  # slide 1 shown again
    CommentRecord(m=15_500, data=C2.model_copy(update={"text": "So a seek lands close."})),
]
ROOM = [
    RoomStateRecord(m=0, data=RoomState(state="waiting", title="Talk Tracks", speaker="Levent")),
    RoomStateRecord(m=8_000, data=RoomState(state="on_air", title="Talk Tracks", speaker="Levent")),
    RoomStateRecord(m=13_000, data=RoomState(state="paused", title="Talk Tracks", speaker="Levent")),
]
DECK_OBJECTS = [
    DeckObject([DeckRecord(m=8_000, data=DeckInfo(count=2, aspect=16 / 9, title="Talk Tracks"))]),
    DeckObject(
        [
            DeckRecord(
                m=8_000, data=DeckImage(index=0, mime="image/webp", width=1600, height=900, data_b64="UklGRg==")
            ),
            DeckRecord(
                m=8_000,
                data=DeckImage(
                    index=1, mime="image/png", width=1600, height=900, data_b64="iVBORw0=", text="Why 4 s slices?"
                ),
            ),
        ]
    ),
]


def example_objects() -> dict[str, list[RootModel[Any]]]:
    return {
        "deck-object.schema.json": list(DECK_OBJECTS),
        "current-slide-object.schema.json": [CurrentSlideObject(SLIDES), CurrentSlideObject([])],
        "ink-object.schema.json": [InkObject(INK)],
        "pointer-object.schema.json": [PointerObject(POINTER[:3]), PointerObject(POINTER[3:])],
        "comments-object.schema.json": [CommentsObject(COMMENTS)],
        "room-state-object.schema.json": [RoomStateObject(ROOM)],
    }


def example_carry_ins() -> dict[str, dict[str, Any]]:
    """Per track: the records before a slice (in publication order), the slide on screen at its start, and the
    carry-in. Two cuts each: inside the example and after all of it."""
    cases: dict[str, dict[str, Any]] = {}
    for at in (12_000, 16_000):
        slides = [r for r in SLIDES if r.m < at]
        on = current_slide(slides)
        ink = [r for r in INK if r.m < at]
        comments = [r for r in COMMENTS if r.m < at]
        cases[f"at {at}"] = {
            "on": _dump(on),
            "slide": {"records": _dumps(slides), "carry": _dumps(last_record(slides))},
            "ink": {"records": _dumps(ink), "carry": _dumps(ink_carry(ink, on))},
            "pointer": {"records": _dumps(p := [r for r in POINTER if r.m < at]), "carry": _dumps(last_record(p))},
            "comments": {"records": _dumps(comments), "carry": _dumps(comments_carry(comments, on))},
            "room": {"records": _dumps(r := [x for x in ROOM if x.m < at]), "carry": _dumps(last_record(r))},
        }
    return cases


def _dump(model: BaseModel | None) -> Any:
    return None if model is None else model.model_dump(mode="json", exclude_none=True)


def _dumps(models: Sequence[BaseModel]) -> list[Any]:
    return [_dump(m) for m in models]


def examples() -> dict[str, Any]:
    return {
        "objects.json": {name: [_dump(o) for o in objs] for name, objs in example_objects().items()},
        "carry-ins.json": example_carry_ins(),
    }


def render(schema: dict[str, Any]) -> str:
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"


def main() -> None:
    EXAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    for name, schema in schemas().items():
        (CONTRACTS_DIR / name).write_text(render(schema), encoding="utf-8", newline="\n")
        print("wrote", CONTRACTS_DIR / name, file=sys.stderr)
    for name, example in examples().items():
        (EXAMPLES_DIR / name).write_text(render(example), encoding="utf-8", newline="\n")
        print("wrote", EXAMPLES_DIR / name, file=sys.stderr)


if __name__ == "__main__":
    main()
