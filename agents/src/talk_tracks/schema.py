"""Write the JSON Schemas of the wire contracts to ``contracts/``, and examples both test suites read back. Run:
``uv run python -m talk_tracks.schema``.

``contracts/examples/objects.json`` holds valid objects per schema; ``contracts/examples/carry-ins.json`` holds, per
speaker or room track (and the room service's annotations ink and marks), a history of records and the carry-in
``records.py`` builds from it, so the web's reducers can be checked against the same answer."""

from __future__ import annotations

import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from pydantic import BaseModel, RootModel

from .contracts import (
    Anchor,
    Author,
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
    InkTool,
    MarkRecord,
    MarksClear,
    MarksObject,
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
    RunSpan,
    ShowSlide,
    SlideFrame,
    SlideObject,
    TextMark,
    TextRun,
    Unmark,
)
from .recording import RecordedSnapshot, Recording
from .records import comments_carry, current_slide, ink_carry, last_record, marks_carry

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
        "marks-object.schema.json": MarksObject.model_json_schema(),
        "pointer-object.schema.json": PointerObject.model_json_schema(),
        "comments-object.schema.json": CommentsObject.model_json_schema(),
        "room-state-object.schema.json": RoomStateObject.model_json_schema(),
        "room-catalog.schema.json": RoomCatalog.model_json_schema(),
        "slide-frame.schema.json": SlideFrame.model_json_schema(),
        "recording.schema.json": Recording.model_json_schema(),
        "recorded-snapshot.schema.json": RecordedSnapshot.model_json_schema(),
    }


# --- examples: a short talk on one deck, loaded at 8 s -------------------------------------------------------
#
# The speaker draws and marks on their own tracks; Ada, Bob and Grace do on the room service's annotations tracks,
# where Bob's erase and unmark of Ada's work, and Eve's hide of Alan's comment, are ignored, and the speaker's
# moderation (sent through the room service) is not.

DECK = 2  # the deck track's group: loaded in slice 2
RED = "#e53935"
YELLOW = "#FFEB3B"
BLUE = "#1e88e5"

SPEAKER = Author(id="speaker", name="Levent", speaker=True)
ADA = Author(id="u-ada", name="Ada")
BOB = Author(id="u-bob", name="Bob")
GRACE = Author(id="u-grace", name="Grace")
ALAN = Author(id="u-alan", name="Alan")
EVE = Author(id="u-eve", name="Eve")

TITLE = Region(x=0.1, y=0.1, w=0.4, h=0.06)
RUNS_0 = [TextRun(id="t0", text="Talk Tracks", box=Region(x=0.3, y=0.45, w=0.4, h=0.1))]
RUNS_1 = [
    TextRun(id="t1", text="Why 4 s slices?", box=TITLE),
    TextRun(id="t2", text="A seek lands close", box=Region(x=0.1, y=0.3, w=0.5, h=0.05)),
]

SLIDES = [
    CurrentSlideRecord(m=8_000, data=ShowSlide(deck=DECK, index=0)),
    CurrentSlideRecord(m=9_500, data=ShowSlide(deck=DECK, index=1)),
    CurrentSlideRecord(m=14_200, data=ShowSlide(deck=DECK, index=0)),
    CurrentSlideRecord(m=15_000, data=HideSlide()),
    CurrentSlideRecord(m=15_500, data=ShowSlide(deck=DECK, index=1)),
]
S1 = [(0.1, 0.1), (0.12, 0.11), (0.15, 0.13)]
S3 = [(0.5, 0.5), (0.55, 0.52)]
A3 = [(0.4, 0.4), (0.45, 0.42)]


def pen(m: int, stroke: str, index: int, points: list[Point], by: Author = SPEAKER, tool: InkTool = "pen") -> InkRecord:
    color, width = (RED, 0.004) if tool == "pen" else (YELLOW, 0.02)
    return InkRecord(
        m=m,
        data=InkBegin(stroke=stroke, deck=DECK, index=index, tool=tool, color=color, width=width, points=points, by=by),
    )


def resent(m: int, stroke: str, points: list[Point], by: Author = SPEAKER) -> InkRecord:
    """A pen stroke of slide 1 sent again when the slide is shown again."""
    return InkRecord(
        m=m,
        data=InkStroke(
            stroke=stroke, deck=DECK, index=1, tool="pen", color=RED, width=0.004, points=points, by=by, done=True
        ),
    )


def end(m: int, stroke: str) -> InkRecord:
    return InkRecord(m=m, data=InkEnd(stroke=stroke))


INK = [
    pen(9_600, "s1", 1, S1[:1]),
    InkRecord(m=9_650, data=InkPoints(stroke="s1", points=S1[1:])),
    end(9_700, "s1"),
    pen(10_000, "s2", 1, [(0.2, 0.5)], tool="highlighter"),
    end(10_100, "s2"),
    InkRecord(m=10_400, data=InkErase(strokes=["s2"], by=SPEAKER)),
    pen(11_000, "s3", 1, S3[:1]),
    InkRecord(m=11_050, data=InkPoints(stroke="s3", points=S3[1:])),
    pen(14_300, "s4", 0, [(0.9, 0.9)]),  # slide 0, shown at 14.2 s with no ink
    end(14_400, "s4"),
    InkRecord(m=14_500, data=InkClear(deck=DECK, index=0, by=SPEAKER)),
    end(15_100, "s3"),
    resent(15_500, "s1", S1),  # slide 1 shown again: its ink comes back
    resent(15_500, "s3", S3),
]
ANNOTATIONS_INK = [
    pen(9_900, "u-ada-1", 1, [(0.3, 0.3)], ADA),
    end(9_950, "u-ada-1"),
    pen(10_500, "u-bob-1", 1, [(0.6, 0.6)], BOB),
    InkRecord(m=10_550, data=InkPoints(stroke="u-bob-1", points=[(0.62, 0.6)])),
    end(10_600, "u-bob-1"),
    InkRecord(m=10_700, data=InkErase(strokes=["u-ada-1"], by=BOB)),  # not Bob's: ignored
    pen(11_100, "u-ada-2", 1, [(0.2, 0.8)], ADA, tool="highlighter"),
    end(11_150, "u-ada-2"),
    InkRecord(m=11_400, data=InkClear(deck=DECK, index=1, by=ADA)),  # Ada's own strokes on slide 1 only
    InkRecord(m=12_200, data=InkErase(strokes=["u-bob-1"], by=SPEAKER)),  # the speaker moderates
    pen(12_500, "u-ada-3", 1, A3[:1], ADA),
    InkRecord(m=12_550, data=InkPoints(stroke="u-ada-3", points=A3[1:])),
    end(12_600, "u-ada-3"),
    resent(15_500, "u-ada-3", A3, ADA),  # slide 1 shown again
]


def mark(
    m: int, mark_id: str, index: int, span: list[RunSpan], by: Author = SPEAKER, *, highlight: bool = False
) -> MarkRecord:
    data = TextMark(
        id=mark_id,
        deck=DECK,
        index=index,
        style="highlight" if highlight else "underline",
        color=YELLOW if highlight else BLUE,
        span=span,
        by=by,
    )
    return MarkRecord(m=m, data=data)


WHOLE_T1 = [RunSpan(run="t1")]
SEEK = [RunSpan(run="t2", start=2, end=6)]
ACROSS = [RunSpan(run="t1", start=4), RunSpan(run="t2", end=6)]
MARKS = [
    mark(9_700, "m1", 1, WHOLE_T1),
    mark(10_900, "m2", 1, SEEK, highlight=True),
    MarkRecord(m=11_200, data=Unmark(marks=["m2"], by=SPEAKER)),
    mark(14_300, "m3", 0, [RunSpan(run="t0")]),
    MarkRecord(m=14_600, data=MarksClear(deck=DECK, index=0, by=SPEAKER)),
    mark(15_500, "m1", 1, WHOLE_T1),  # slide 1 shown again
]
ANNOTATIONS_MARKS = [
    mark(10_000, "u-ada-m1", 1, SEEK, ADA),
    MarkRecord(m=10_100, data=Unmark(marks=["u-ada-m1"], by=BOB)),  # not Bob's: ignored
    mark(11_900, "u-grace-m1", 1, ACROSS, GRACE, highlight=True),
    mark(15_500, "u-ada-m1", 1, SEEK, ADA),  # slide 1 shown again
    mark(15_500, "u-grace-m1", 1, ACROSS, GRACE, highlight=True),
]
POINTER = [
    PointerRecord(m=11_200, data=PointerAt(x=0.4, y=0.3)),
    PointerRecord(m=11_250, data=PointerAt(x=0.41, y=0.31)),
    PointerRecord(m=11_300, data=PointerOff()),
    PointerRecord(m=15_900, data=PointerAt(x=0.7, y=0.2)),
]
ASKED = Anchor(deck=DECK, index=1, region=TITLE, span=WHOLE_T1)
C1 = Comment(id="c1", at=9_800, by=ADA, text="Why 4 s slices?", anchor=ASKED, question=True)
C2 = Reply(id="c2", at=10_200, to="c1", by=GRACE, text="A seek lands close.")
C4 = Comment(id="c4", at=11_000, by=ALAN, text="Nice chart", anchor=Anchor(deck=DECK, index=0))
COMMENTS = [
    CommentRecord(m=9_800, data=C1),
    CommentRecord(m=10_200, data=C2),
    CommentRecord(m=10_300, data=Reply(id="c3", at=10_300, to="c1", by=SPEAKER, text="Slide 9 says.")),
    CommentRecord(m=10_400, data=CommentEdit(id="c2", text="So a seek lands close.", by=GRACE)),
    CommentRecord(m=10_450, data=CommentEdit(id="c1", text="spam", by=BOB)),  # not Bob's: ignored
    CommentRecord(m=11_000, data=C4),
    CommentRecord(m=11_500, data=Comment(id="c5", at=11_500, by=BOB, text="spam", anchor=Anchor(deck=DECK, index=1))),
    CommentRecord(m=11_600, data=Reply(id="c6", at=11_600, to="c5", by=EVE, text="more spam")),
    CommentRecord(m=11_700, data=CommentHide(id="c4", by=EVE)),  # not Eve's: ignored
    CommentRecord(m=12_000, data=CommentHide(id="c5", by=SPEAKER)),
    CommentRecord(m=12_100, data=CommentHide(id="c3", by=SPEAKER)),
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
                m=8_000,
                data=DeckImage(index=0, mime="image/webp", width=1600, height=900, data_b64="UklGRg==", runs=RUNS_0),
            ),
            DeckRecord(
                m=8_000,
                data=DeckImage(index=1, mime="image/png", width=1600, height=900, data_b64="iVBORw0=", runs=RUNS_1),
            ),
        ]
    ),
]


def example_objects() -> dict[str, list[RootModel[Any]]]:
    return {
        "deck-object.schema.json": list(DECK_OBJECTS),
        "current-slide-object.schema.json": [CurrentSlideObject(SLIDES), CurrentSlideObject([])],
        "ink-object.schema.json": [InkObject(INK), InkObject(ANNOTATIONS_INK)],
        "marks-object.schema.json": [MarksObject(MARKS), MarksObject(ANNOTATIONS_MARKS)],
        "pointer-object.schema.json": [PointerObject(POINTER[:3]), PointerObject(POINTER[3:])],
        "comments-object.schema.json": [CommentsObject(COMMENTS)],
        "room-state-object.schema.json": [RoomStateObject(ROOM)],
    }


def example_carry_ins() -> dict[str, dict[str, Any]]:
    """Per track: the records before a slice (in publication order), the slide on screen at its start, and the
    carry-in. Two cuts each: inside the example and after all of it. ``annotations_ink`` and ``annotations_marks`` are
    the room service's tracks of everyone else's ink and marks."""
    cases: dict[str, dict[str, Any]] = {}
    for at in (12_000, 16_000):
        slides = [r for r in SLIDES if r.m < at]
        on = current_slide(slides)
        ink = [r for r in INK if r.m < at]
        marks = [r for r in MARKS if r.m < at]
        audience_ink = [r for r in ANNOTATIONS_INK if r.m < at]
        audience_marks = [r for r in ANNOTATIONS_MARKS if r.m < at]
        comments = [r for r in COMMENTS if r.m < at]
        cases[f"at {at}"] = {
            "on": _dump(on),
            "slide": {"records": _dumps(slides), "carry": _dumps(last_record(slides))},
            "ink": {"records": _dumps(ink), "carry": _dumps(ink_carry(ink, on))},
            "marks": {"records": _dumps(marks), "carry": _dumps(marks_carry(marks, on))},
            "annotations_ink": {"records": _dumps(audience_ink), "carry": _dumps(ink_carry(audience_ink, on))},
            "annotations_marks": {"records": _dumps(audience_marks), "carry": _dumps(marks_carry(audience_marks, on))},
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
