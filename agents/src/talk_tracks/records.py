"""Objects of the event tracks as MSF event-timeline records (design §4.2, ui-design §3.4): encode what the cores
and the console make, decode what another agent or the archive holds, and build the carry-ins (object 0) of the
speaker's and the room's tracks. Transport-free."""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable, Sequence

from pydantic import ValidationError

from .contracts import (
    SLICE_MS,
    Anchor,
    CaptionLine,
    CarryData,
    CarryNote,
    CarryRecord,
    Comment,
    CommentEdit,
    CommentHide,
    CommentRecord,
    Cue,
    CueObject,
    CueRecord,
    CurrentSlideRecord,
    InkBegin,
    InkClear,
    InkElement,
    InkEnd,
    InkErase,
    InkPoints,
    InkRecord,
    InkShape,
    InkStroke,
    MarkRecord,
    MarksClear,
    OutlineObject,
    OutlineRecord,
    Reply,
    ShowSlide,
    Slide,
    SlideObject,
    SlideRecord,
    TextMark,
    Unmark,
    Wire,
    may_change,
)

log = logging.getLogger("talk_tracks")

Record = CarryRecord | CueRecord | SlideRecord | OutlineRecord
Data = Cue | Slide


def record(data: Data) -> CueRecord | SlideRecord:
    return CueRecord(m=data.start, data=data) if isinstance(data, Cue) else SlideRecord(m=data.at, data=data)


def note(k: int, *, capped: bool = False, from_ms: int | None = None) -> CarryRecord | None:
    """The carry-in's note for slice ``k``, or None when there is nothing to say."""
    if not capped and from_ms is None:
        return None
    return CarryRecord(m=k * SLICE_MS, data=CarryData(tt=CarryNote(capped=capped, from_=from_ms)))


def encode(records: Sequence[Wire]) -> bytes:
    """One object: a JSON array of records (no ``from`` when there is none)."""
    return json.dumps([r.model_dump(mode="json", exclude_none=True) for r in records], separators=(",", ":")).encode()


def carry_in(k: int, carry: Sequence[Data], *, capped: bool = False, from_ms: int | None = None) -> bytes:
    """Object 0 of slice ``k``: the note, if any, then the records that make the slice useful on its own."""
    first = note(k, capped=capped, from_ms=from_ms)
    return encode([*([first] if first else []), *(record(d) for d in carry)])


def cues_of(payload: bytes) -> tuple[CarryNote | None, list[Cue]]:
    """The note and cues of an object of a captions or translation track; nothing for one that breaks the contract."""
    try:
        obj = CueObject.model_validate_json(payload)
    except ValidationError:
        log.warning("skipping a cue object that does not match the contract")
        return None, []
    notes = [r.data.tt for r in obj.root if isinstance(r, CarryRecord)]
    return (notes[0] if notes else None), [r.data for r in obj.root if isinstance(r, CueRecord)]


def slides_of(payload: bytes) -> tuple[CarryNote | None, list[Slide]]:
    try:
        obj = SlideObject.model_validate_json(payload)
    except ValidationError:
        log.warning("skipping a slide object that does not match the contract")
        return None, []
    notes = [r.data.tt for r in obj.root if isinstance(r, CarryRecord)]
    return (notes[0] if notes else None), [r.data for r in obj.root if isinstance(r, SlideRecord)]


def outline_of(payload: bytes) -> list[OutlineRecord] | None:
    try:
        return list(OutlineObject.model_validate_json(payload).root)
    except ValidationError:
        log.warning("skipping an outline object that does not match the contract")
        return None


def latest(cues: Sequence[Cue]) -> list[Cue]:
    """One cue per id, its highest revision, in id order (ids rise with time)."""
    best: dict[str, Cue] = {}
    for cue in cues:
        if (seen := best.get(cue.id)) is None or cue.rev >= seen.rev:
            best[cue.id] = cue
    return sorted(best.values(), key=lambda c: (c.start, cue_number(c)))


def cue_number(cue: Cue) -> int:
    """Our cue ids are decimal numbers that rise with time."""
    return int(cue.id) if cue.id.isdigit() else 0


def line_of(cue: Cue) -> CaptionLine:
    """A cue as the models' transcript line."""
    return CaptionLine(id=cue_number(cue), start_ms=cue.start, end_ms=cue.end, text=cue.text)


# --- carry-ins of the speaker's and the room's tracks (ui-design §3.4, container-formats.md) -----------------
#
# Each function takes every record of one track before slice k, in publication order (earlier slices' objects
# 1 and up, or the previous carry-in followed by its slice's records), and returns object 0 of slice k. Given the
# records up to a time t instead, it returns what is on screen at t. web/src/contracts/tracks.ts mirrors them; both
# are checked against contracts/examples/carry-ins.json.


def last_record[R: Wire](records: Sequence[R]) -> list[R]:
    """The carry-in of the slide, pointer and room tracks: their last record (the state still in effect)."""
    return list(records[-1:])


def current_slide(records: Iterable[CurrentSlideRecord]) -> ShowSlide | None:
    """The slide on screen after these records; None when none is shown."""
    shown: ShowSlide | None = None
    for r in records:
        shown = r.data if isinstance(r.data, ShowSlide) else None
    return shown


def ink_strokes(records: Iterable[InkRecord]) -> dict[str, InkRecord]:
    """Every element (stroke or shape) still on some slide after these records (of one ink track), by id, as a whole
    ``stroke`` or ``shape`` record whose m is when it appeared. Points, end or erase of an element never seen are
    ignored, and so are erase and clear of elements their author may not change (``may_change``). A whole record
    replaces the element with its id, which is how a re-send, a shape being dragged and a redo all work."""
    strokes: dict[str, tuple[int, InkElement]] = {}
    for r in records:
        d = r.data
        if isinstance(d, InkBegin):
            strokes[d.stroke] = (r.m, InkStroke(**d.model_dump(exclude={"kind"}), done=False))
        elif isinstance(d, InkStroke | InkShape):
            strokes[d.stroke] = (r.m, d)
        elif isinstance(d, InkPoints):
            if (seen := strokes.get(d.stroke)) is not None and isinstance(seen[1], InkStroke):
                strokes[d.stroke] = (seen[0], seen[1].model_copy(update={"points": [*seen[1].points, *d.points]}))
        elif isinstance(d, InkEnd):
            if (seen := strokes.get(d.stroke)) is not None and isinstance(seen[1], InkStroke):
                strokes[d.stroke] = (seen[0], seen[1].model_copy(update={"done": True}))
        elif isinstance(d, InkErase):
            for stroke in d.strokes:
                if (seen := strokes.get(stroke)) is not None and may_change(d.by, seen[1].by):
                    del strokes[stroke]
        else:
            strokes = {k: v for k, v in strokes.items() if not (_on(v[1], d) and may_change(d.by, v[1].by))}
    return {k: InkRecord(m=m, data=s) for k, (m, s) in strokes.items()}


def ink_carry(records: Iterable[InkRecord], on: ShowSlide | None) -> list[InkRecord]:
    """Object 0 of the ink track: the strokes and shapes visible on the slide on screen (``on``), oldest first."""
    if on is None:
        return []
    visible = [r for r in ink_strokes(records).values() if _on(element(r), on)]
    return sorted(visible, key=lambda r: r.m)


def text_marks(records: Iterable[MarkRecord]) -> dict[str, MarkRecord]:
    """Every text mark still on some slide after these records (of one marks track), by id, with the m of when it
    appeared. Unmark and clear apply only to marks their author may change."""
    marks: dict[str, MarkRecord] = {}
    for r in records:
        d = r.data
        if isinstance(d, TextMark):
            marks[d.id] = r
        elif isinstance(d, Unmark):
            for mark in d.marks:
                if (seen := marks.get(mark)) is not None and may_change(d.by, _mark(seen).by):
                    del marks[mark]
        else:
            marks = {k: v for k, v in marks.items() if not (_on(_mark(v), d) and may_change(d.by, _mark(v).by))}
    return marks


def marks_carry(records: Iterable[MarkRecord], on: ShowSlide | None) -> list[MarkRecord]:
    """Object 0 of a marks track: the marks on the slide on screen (``on``), oldest first."""
    if on is None:
        return []
    return sorted((r for r in text_marks(records).values() if _on(_mark(r), on)), key=lambda r: r.m)


def comment_threads(records: Iterable[CommentRecord]) -> list[CommentRecord]:
    """Every comment and reply still shown after these records, edits applied and hidden ones (with a hidden
    comment's replies) left out, in the order they were made. A reply to a comment not shown is dropped; an edit by
    anyone but the author, or a hide by anyone but the author or the speaker, is ignored."""
    shown: dict[str, CommentRecord] = {}
    for r in records:
        d = r.data
        if isinstance(d, Comment) or (isinstance(d, Reply) and _is_comment(shown.get(d.to))):
            shown[d.id] = r
        elif isinstance(d, CommentEdit):
            if (seen := shown.get(d.id)) is not None and _posted(seen).by.id == d.by.id:
                shown[d.id] = seen.model_copy(update={"data": _posted(seen).model_copy(update={"text": d.text})})
        elif (
            isinstance(d, CommentHide) and (seen := shown.get(d.id)) is not None and may_change(d.by, _posted(seen).by)
        ):
            shown = {k: v for k, v in shown.items() if d.id not in (k, _to(v))}
    return list(shown.values())


def comments_carry(records: Iterable[CommentRecord], on: ShowSlide | None) -> list[CommentRecord]:
    """Object 0 of the comments track: the threads anchored on the slide on screen (``on``)."""
    if on is None:
        return []
    threads = comment_threads(records)
    anchored = {r.data.id for r in threads if isinstance(r.data, Comment) and _on(r.data.anchor, on)}
    return [r for r in threads if r.data.id in anchored or _to(r) in anchored]


def _on(where: InkElement | TextMark | ShowSlide | Anchor, slide: InkClear | MarksClear | ShowSlide) -> bool:
    return (where.deck, where.index) == (slide.deck, slide.index)


def element(r: InkRecord) -> InkElement:
    """The stroke or shape of a record that ``ink_strokes`` kept."""
    assert isinstance(r.data, InkStroke | InkShape)  # ink_strokes keeps whole strokes and shapes only
    return r.data


def _mark(r: MarkRecord) -> TextMark:
    assert isinstance(r.data, TextMark)  # text_marks keeps only marks
    return r.data


def _posted(r: CommentRecord) -> Comment | Reply:
    assert isinstance(r.data, Comment | Reply)  # comment_threads keeps only comments and replies
    return r.data


def _is_comment(r: CommentRecord | None) -> bool:
    return r is not None and isinstance(r.data, Comment)


def _to(r: CommentRecord) -> str | None:
    return r.data.to if isinstance(r.data, Reply) else None
