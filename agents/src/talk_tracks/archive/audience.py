"""Everyone else's annotations and comments in one room, as the room service publishes them (decisions 0005, 0021,
0024).

Listeners never publish to the relay. They write through the room service's endpoint (``archive.listeners``), and
this module turns each write into a record of the contract on the room's tracks: ink and text marks on
``talk/<room>/annotations`` (``ink``, ``marks``), comments on ``talk/<room>/comments`` (``comments``). Every write is
validated by the contract's models, stamped with its author (``by``, from the listener's session, never from what
they sent) and the room time now, and checked against who may change what (``may_change``) before it goes out, so a
bad write publishes nothing. When the speaker shows a slide, that slide's strokes, marks and threads go out again
(container-formats.md, "re-send"), so one group is always enough to draw it.

Transport-free: the tracks are ``events.ServiceTrack``s (anything with ``records`` and ``add``), the clock a function.
"""

from __future__ import annotations

import logging
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, Protocol, cast

from pydantic import ValidationError

from ..contracts import (
    Author,
    Comment,
    CommentEdit,
    CommentRecord,
    InkBegin,
    InkEnd,
    InkErase,
    InkPoints,
    InkRecord,
    InkShape,
    InkStroke,
    MarkRecord,
    MarksClear,
    Reply,
    ShowSlide,
    TextMark,
    Unmark,
    Wire,
    may_change,
)
from ..records import comment_threads, comments_carry, element, ink_carry, ink_strokes, marks_carry, text_marks

log = logging.getLogger("talk_tracks.archive.audience")

TrackName = Literal["ink", "marks", "comments"]
Code = Literal["invalid", "forbidden", "not-live", "limit"]

MAX_POINTS = 5_000  # points in one stroke
OPEN_STROKES = 4  # strokes one person draws at once (several fingers, a pen and a mouse)


class Refusal(Exception):
    """A write that publishes nothing, with a code the client can act on and a sentence it can show."""

    def __init__(self, code: Code, message: str) -> None:
        super().__init__(message)
        self.code: Code = code
        self.message = message


class Track[R](Protocol):
    """What this module needs of a ``ServiceTrack``: the records so far, and a way to publish one more."""

    @property
    def records(self) -> list[R]: ...

    async def add(self, record: R) -> None: ...


@dataclass(frozen=True)
class Done:
    """A write that went out: its room time, and the id the room service gave a new comment or reply."""

    m: int
    id: str | None = None


def new_comment_id() -> str:
    return f"c{secrets.token_hex(5)}"


def _valid[M: Wire](model: type[M], m: int, data: dict[str, Any]) -> M:
    try:
        return model.model_validate({"m": m, "data": data})
    except ValidationError as e:
        first = e.errors()[0] if e.errors() else None
        where = ".".join(str(p) for p in first["loc"]) if first else ""
        raise Refusal("invalid", f"Not a valid record{f' ({where})' if where else ''}") from None


def _own(by: Author, id_: str, what: str) -> None:
    """A listener's stroke and mark ids start with their user id (lane-briefs §Namespaces)."""
    if not by.speaker and not id_.startswith(f"{by.id}:"):
        raise Refusal("invalid", f"A {what} id starts with your id and a colon")


class Audience:
    """One room's listener writes. ``now`` is the room time now (None before the room has a clock)."""

    def __init__(
        self,
        ink: Track[InkRecord],
        marks: Track[MarkRecord],
        comments: Track[CommentRecord],
        *,
        now: Callable[[], int | None],
        new_id: Callable[[], str] = new_comment_id,
    ) -> None:
        self.ink, self.marks, self.comments = ink, marks, comments
        self._now, self._new_id = now, new_id
        self.listeners: list[Callable[[CommentRecord], None]] = []  # each new comments record, re-sends excluded
        records: list[InkRecord | MarkRecord | CommentRecord] = [*ink.records, *marks.records, *comments.records]
        self._last_m = max((r.m for r in records), default=0)
        self._taken: set[str] = {*ink_strokes(ink.records), *text_marks(marks.records)}
        # Strokes being drawn: id -> (author id, points so far, deck, index). One a restart left open stays unfinished.
        self._drawing: dict[str, tuple[str, int, int, int]] = {}

    # --- reading ---------------------------------------------------------------------------------------------------

    def now(self) -> int | None:
        """The room time now, None before the room has a clock."""
        return self._now()

    def threads(self) -> list[CommentRecord]:
        """Every comment and reply shown now, edits applied and hidden ones left out, in the order they were made."""
        return comment_threads(self.comments.records)

    # --- writing ---------------------------------------------------------------------------------------------------

    async def write(self, by: Author, track: str, data: object, at: int | None = None) -> Done:
        """Publish one listener write on ``track`` (ink, marks or comments). ``data`` is the record's ``data``
        without ``by`` (and, for a comment or reply, without ``id`` and ``at``); ``at``, for a new comment or reply,
        is the room time of what the writer is watching (a replay's playhead), never later than now."""
        if not isinstance(data, dict):
            raise Refusal("invalid", "A write has a data object")
        fields = cast(dict[str, Any], data)
        if "by" in fields:
            raise Refusal("invalid", "The room service says who wrote it")
        now = self._now()
        if now is None:
            raise Refusal("not-live", "The talk has not started yet")
        m = max(now, self._last_m)
        if track == "ink":
            done = await self._ink(by, fields, m)
        elif track == "marks":
            done = await self._marks(by, fields, m)
        elif track == "comments":
            done = await self._comment(by, fields, m, at)
        else:
            raise Refusal("invalid", f"No track {track!r}")
        self._last_m = m
        return done

    async def _ink(self, by: Author, data: dict[str, Any], m: int) -> Done:
        kind = data.get("kind")
        if kind not in ("begin", "points", "end", "stroke", "shape", "erase", "clear"):
            raise Refusal("invalid", "Ink is begin, points, end, stroke, shape, erase or clear")
        stamped = data if kind in ("points", "end") else {**data, "by": by.model_dump()}
        record = _valid(InkRecord, m, stamped)
        d = record.data
        if isinstance(d, InkBegin):
            _own(by, d.stroke, "stroke")
            if d.stroke in self._taken:
                raise Refusal("invalid", "That stroke id is taken")
            if sum(1 for who, *_ in self._drawing.values() if who == by.id) >= OPEN_STROKES:
                raise Refusal("limit", "Finish a stroke before starting another")
            if len(d.points) > MAX_POINTS:
                raise Refusal("limit", "That stroke is too long")
            self._taken.add(d.stroke)
            self._drawing[d.stroke] = (by.id, len(d.points), d.deck, d.index)
        elif isinstance(d, InkPoints | InkEnd):
            drawing = self._drawing.get(d.stroke)
            if drawing is None or drawing[0] != by.id:
                raise Refusal("forbidden", "Not a stroke of yours being drawn")
            if isinstance(d, InkPoints):
                count = drawing[1] + len(d.points)
                if count > MAX_POINTS:
                    raise Refusal("limit", "That stroke is too long")
                self._drawing[d.stroke] = (drawing[0], count, *drawing[2:])
            else:
                del self._drawing[d.stroke]
        elif isinstance(d, InkStroke | InkShape):
            # A whole element of one's own: a shape (sent again while dragged), or a redo or undone erase restoring it.
            _own(by, d.stroke, d.kind)
            if d.stroke in self._drawing:
                raise Refusal("invalid", "That stroke is still being drawn")
            if isinstance(d, InkStroke) and not d.done:
                raise Refusal("invalid", "A whole stroke is done; draw one with begin, points and end")
            if isinstance(d, InkStroke) and len(d.points) > MAX_POINTS:
                raise Refusal("limit", "That stroke is too long")
            self._taken.add(d.stroke)
        elif isinstance(d, InkErase):
            strokes = ink_strokes(self.ink.records)
            allowed = [s for s in d.strokes if (r := strokes.get(s)) is not None and may_change(by, element(r).by)]
            if not allowed:
                raise Refusal("forbidden", "Nothing there you may erase")
            record = InkRecord(m=m, data=d.model_copy(update={"strokes": allowed}))
            for s in allowed:
                self._drawing.pop(s, None)
        else:
            for s, (who, _, deck, index) in list(self._drawing.items()):
                if (deck, index) == (d.deck, d.index) and (by.speaker or who == by.id):
                    del self._drawing[s]
        await self.ink.add(record)
        return Done(m)

    async def _marks(self, by: Author, data: dict[str, Any], m: int) -> Done:
        kind = data.get("kind")
        if kind not in ("mark", "unmark", "clear"):
            raise Refusal("invalid", "Marks are mark, unmark or clear")
        record = _valid(MarkRecord, m, {**data, "by": by.model_dump()})
        d = record.data
        if isinstance(d, TextMark):
            _own(by, d.id, "mark")
            if d.id in self._taken:
                raise Refusal("invalid", "That mark id is taken")
            self._taken.add(d.id)
        elif isinstance(d, Unmark):
            marks = text_marks(self.marks.records)
            allowed = [k for k in d.marks if (r := marks.get(k)) is not None and may_change(by, _mark(r).by)]
            if not allowed:
                raise Refusal("forbidden", "Nothing there you may remove")
            record = MarkRecord(m=m, data=d.model_copy(update={"marks": allowed}))
        else:
            assert isinstance(d, MarksClear)
        await self.marks.add(record)
        return Done(m)

    async def _comment(self, by: Author, data: dict[str, Any], m: int, at: int | None) -> Done:
        kind = data.get("kind")
        if isinstance(data.get("text"), str):
            data = {**data, "text": str(data["text"]).strip()}
        stamped: dict[str, Any] = {**data, "by": by.model_dump()}
        given: str | None = None
        if kind in ("comment", "reply"):
            if "id" in data or "at" in data:
                raise Refusal("invalid", "The room service gives a comment its id and time")
            given = self._new_id()
            posted = m if at is None else max(0, min(int(at), m))
            stamped |= {"id": given, "at": posted}
        elif kind not in ("edit", "hide"):
            raise Refusal("invalid", "Comments are comment, reply, edit or hide")
        record = _valid(CommentRecord, m, stamped)
        d = record.data
        if not isinstance(d, Comment):
            shown = {r.data.id: r.data for r in self.threads() if isinstance(r.data, Comment | Reply)}
            if isinstance(d, Reply):
                if not isinstance(shown.get(d.to), Comment):
                    raise Refusal("invalid", "No such comment to reply to")
            elif isinstance(d, CommentEdit):
                seen = shown.get(d.id)
                if seen is None or seen.by.id != by.id:
                    raise Refusal("forbidden", "Only its author edits a comment")
            else:
                seen = shown.get(d.id)
                if seen is None or not may_change(by, seen.by):
                    raise Refusal("forbidden", "Only its author or the speaker hides a comment")
        await self.comments.add(record)
        for listener in self.listeners:
            try:
                listener(record)
            except Exception:
                log.exception("a comments listener failed")
        return Done(m, given)

    # --- the speaker shows a slide ---------------------------------------------------------------------------------

    async def shown(self, show: ShowSlide, m: int) -> int:
        """The speaker shows ``show`` at room time ``m``: its strokes, marks and threads go out again, each with m =
        that moment (or the newest record's time, if later). Returns how many records were re-sent."""
        m = max(m, self._last_m)
        strokes = ink_carry(self.ink.records, show)
        marks = marks_carry(self.marks.records, show)
        threads = comments_carry(self.comments.records, show)
        for r in strokes:
            await self.ink.add(InkRecord(m=m, data=r.data))
        for r in marks:
            await self.marks.add(MarkRecord(m=m, data=r.data))
        for r in threads:
            await self.comments.add(CommentRecord(m=m, data=r.data))
        sent = len(strokes) + len(marks) + len(threads)
        if sent:
            self._last_m = m
        return sent


def _mark(r: MarkRecord) -> TextMark:
    assert isinstance(r.data, TextMark)  # text_marks keeps marks only
    return r.data
