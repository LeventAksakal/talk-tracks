"""Objects of the agent tracks as MSF event-timeline records (design §4.2): encode what the cores make, decode what
another agent or the archive holds. Transport-free."""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence

from pydantic import ValidationError

from .contracts import (
    SLICE_MS,
    CaptionLine,
    CarryData,
    CarryNote,
    CarryRecord,
    Cue,
    CueObject,
    CueRecord,
    OutlineObject,
    OutlineRecord,
    Slide,
    SlideObject,
    SlideRecord,
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


def encode(records: Sequence[Record]) -> bytes:
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
