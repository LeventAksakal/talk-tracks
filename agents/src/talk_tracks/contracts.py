"""Wire contracts: what every agent publishes and what every viewer validates (design §4, decision 0012).

An agent publishes ``talk/<room>/agents/<agent>`` under a stable name. Its ``items`` track is an MSF event timeline
cut into **slices** on the room clock: group k holds the records whose room time falls in [k·4 s, (k+1)·4 s). Each
object is a JSON array of records ``{"m": <room ms>, "data": {...}}`` (MSF §8.1): ``CueObject`` for captions and
translations (WebVTT-MSF cues), ``SlideObject`` for slide descriptions. Object 0 is the carry-in (the last cues, or
the slide on screen), objects 1 and up are the slice's new records; End of Group closes the slice, and End of Track
comes only when the room service closes the room. The chapters agent's ``outline`` track has one group per
revision, whose single ``OutlineObject`` holds the whole outline. The Location (group, object) is the sequence.

Room time (Unix ms) = wall time of the speaker's media - ``E`` (+ the broadcast's ``tt.shift``), from the teacher's
hang catalog ``clock`` and the room catalog (``RoomCatalog``), which the room service publishes.

The full states (``CaptionsState`` and the rest) are what the cores keep and what recordings store; they are not on
the wire. The JSON Schemas generated from these models are committed in ``contracts/`` and checked by both test
suites.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Annotated, Any, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, RootModel, TypeAdapter, model_validator

SLICE_MS = 4000  # group k of a sliced track covers room time [k * SLICE_MS, (k + 1) * SLICE_MS)
CARRY_CUES = 2  # cues a carry-in repeats from before its slice


class Wire(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# --- full states, one per kind of agent: what the cores keep and recordings store (not on the wire) -----------


class CaptionLine(Wire):
    id: int = Field(
        ge=0,
        description="Rises with time: the start time in media ms (or one more than the previous id); stable across"
        " restarts and back-fill",
    )
    start_ms: int = Field(ge=0, description="Media time of the first word")
    end_ms: int = Field(ge=0)
    text: str


class CaptionsState(Wire):
    kind: Literal["captions"] = "captions"
    lang: str
    lines: list[CaptionLine]
    interim: str = ""


class TranslatedLine(Wire):
    id: int = Field(ge=0, description="The source caption line's id")
    start_ms: int = Field(ge=0, default=0, description="The source line's media times")
    end_ms: int = Field(ge=0, default=0)
    text: str


class TranslationState(Wire):
    kind: Literal["translation"] = "translation"
    lang: str
    lines: list[TranslatedLine]


class SlideNote(Wire):
    id: int = Field(ge=0)
    at_ms: int = Field(ge=0, description="Media time when the slide appeared")
    description: str


class SlidesState(Wire):
    kind: Literal["slides"] = "slides"
    lang: str
    slides: list[SlideNote]


class Chapter(Wire):
    id: int = Field(ge=0)
    start_ms: int = Field(ge=0)
    title: str
    summary: str


class GlossaryTerm(Wire):
    term: str
    definition: str


class OutlineState(Wire):
    kind: Literal["outline"] = "outline"
    lang: str
    chapters: list[Chapter]
    glossary: list[GlossaryTerm]
    recap: str = ""


State = Annotated[
    CaptionsState | TranslationState | SlidesState | OutlineState,
    Field(discriminator="kind"),
]


# --- room time (design §4.5) -------------------------------------------------------------------------------

MOQ_EPOCH_UNIX_MS = 1_577_836_800_000  # 2020-01-01T00:00:00Z, where hang's clock.wall counts from


def wall_unix_ms(wall: int, timescale: int, pts_ms: float) -> float:
    """Wall time of a media timestamp, from the teacher hang catalog's root ``clock`` (``@moq/hang`` wallClockTime)."""
    return MOQ_EPOCH_UNIX_MS + 1000 * wall / timescale + pts_ms


def room_ms(wall_ms: float, epoch: int, shift: int) -> int:
    """Room time of a wall time: minus the room epoch ``E``, plus this broadcast's ``tt.shift``."""
    return int(wall_ms - epoch + shift)


# --- what goes on the wire: MSF event timelines (design §4.2) ----------------------------------------------
#
# Every object of an ``items`` track is a JSON array of records ``{"m": <room ms>, "data": {...}}`` (MSF §8.1).
# Object 0 of a slice is the carry-in: an optional ``CarryRecord`` first, then the last cues before the slice (at
# most CARRY_CUES) or the slide on screen. Objects 1 and up hold the slice's new records in publication order.


class Cue(Wire):
    """A WebVTT-MSF cue (WebVTT-MSF §3) plus ``rev`` and ``final`` for interim results."""

    start: int = Field(ge=0, description="Room ms of the first word")
    end: int = Field(ge=0, description="Room ms of the end of the last word")
    id: str = Field(
        min_length=1,
        description="Stable across revisions, restarts and back-fill; a translated cue keeps its caption's id",
    )
    text: str
    rev: int = Field(ge=0, default=0, description="Revision of this id; a viewer keeps the highest")
    final: bool = Field(description="False while the speaker is still saying it")

    @model_validator(mode="after")
    def _ends_after_start(self) -> Cue:
        if self.end < self.start:
            raise ValueError("a cue ends before it starts")
        return self


class CueRecord(Wire):
    m: int = Field(ge=0, description="Room ms: the cue's start")
    data: Cue

    @model_validator(mode="after")
    def _m_is_start(self) -> CueRecord:
        if self.m != self.data.start:
            raise ValueError("a cue record's m is its start (WebVTT-MSF §3)")
        return self


class Slide(Wire):
    id: int = Field(ge=0)
    at: int = Field(ge=0, description="Room ms when the slide appeared")
    text: str = Field(description="What the slide shows, described for a viewer who cannot see it")


class SlideRecord(Wire):
    m: int = Field(ge=0, description="Room ms: the slide's at")
    data: Slide

    @model_validator(mode="after")
    def _m_is_at(self) -> SlideRecord:
        if self.m != self.data.at:
            raise ValueError("a slide record's m is its at")
        return self


class CarryNote(Wire):
    model_config = ConfigDict(extra="forbid", frozen=True, serialize_by_alias=True)

    capped: bool = Field(
        default=False, description="The room reached its spend cap: no new records follow in this slice"
    )
    from_: int | None = Field(
        default=None,
        validation_alias=AliasChoices("from", "from_"),
        serialization_alias="from",
        ge=0,
        description="Room ms where this agent started inside the slice: it has nothing from before (captions)",
    )


class CarryData(Wire):
    tt: CarryNote


class CarryRecord(Wire):
    """Talk Tracks' note on a carry-in, its first record and only when there is something to say."""

    m: int = Field(ge=0, description="Room ms of the slice start, k * 4000")
    data: CarryData


def _carry_note_first(records: Sequence[object]) -> None:
    if any(isinstance(r, CarryRecord) for r in records[1:]):
        raise ValueError("a carry-in note is the first record of object 0")


class CueObject(RootModel[list[CarryRecord | CueRecord]]):
    """One object of a captions or translation ``items`` track (eventType ``urn:msf:captions:webvtt``)."""

    model_config = ConfigDict(frozen=True)

    @model_validator(mode="after")
    def _note_first(self) -> CueObject:
        _carry_note_first(self.root)
        return self


class SlideObject(RootModel[list[CarryRecord | SlideRecord]]):
    """One object of the slide descriptions' ``items`` track (eventType ``com.talktracks.slides``)."""

    model_config = ConfigDict(frozen=True)

    @model_validator(mode="after")
    def _note_first(self) -> SlideObject:
        _carry_note_first(self.root)
        return self


# The chapters agent's ``outline`` track (design §4.3): one group per revision, whose only object is the whole
# outline as a timeline (MSF §8.3), eventType ``com.talktracks.outline``.


class ChapterData(Wire):
    kind: Literal["chapter"] = "chapter"
    id: int = Field(ge=0)
    start: int = Field(ge=0, description="Room ms where the chapter starts")
    title: str
    summary: str


class TermData(Wire):
    kind: Literal["term"] = "term"
    term: str
    definition: str


class RecapData(Wire):
    kind: Literal["recap"] = "recap"
    text: str


class OutlineRecord(Wire):
    m: int = Field(ge=0, description="Room ms: a chapter's start; for a term or the recap, the revision's watermark")
    data: Annotated[ChapterData | TermData | RecapData, Field(discriminator="kind")]

    @model_validator(mode="after")
    def _m_is_start(self) -> OutlineRecord:
        if isinstance(self.data, ChapterData) and self.m != self.data.start:
            raise ValueError("a chapter record's m is its start")
        return self


class OutlineObject(RootModel[list[OutlineRecord]]):
    model_config = ConfigDict(frozen=True)


CUE_EVENT = "urn:msf:captions:webvtt"
SLIDES_EVENT = "com.talktracks.slides"
OUTLINE_EVENT = "com.talktracks.outline"


# --- the speaker's and the room's event tracks (ui-design §3.4, decisions 0017 and 0018) --------------------
#
# Same model as the agent tracks: every object is a JSON array of records ``{"m": <room ms>, "data": {...}}``, and
# every ``data`` names its ``kind``. The sliced tracks (slide, ink, marks, pointer, comments, room) cut group k at room
# time [k * 4 s, (k + 1) * 4 s); object 0 is the carry-in, the state needed to draw the slice's start without earlier
# slices (``records.py`` builds it), and objects 1 and up are the slice's new records in publication order. A
# carry-in record keeps the m of when it took effect, so its m may precede the slice. The deck track is not sliced:
# one group per deck, like the outline. Positions and sizes are fractions of the slide, never pixels: x from the
# left, y from the top. Group, object 0 and deltas of every track: wiki/design/container-formats.md.
#
# Three separate tools (decision 0021): the laser (``pointer``, ephemeral), the pencil (``ink``, kept on its slide)
# and text marks (``marks``, kept on a range of the slide's text). The deck with its ink, marks and comments is shared
# state; anyone in the room may change it, the speaker on their own tracks and everyone else through the room service.

Fraction = Annotated[float, Field(ge=0, le=1)]
Point = tuple[Fraction, Fraction]
SlideIndex = Annotated[int, Field(ge=0, description="The slide's 0-based position in its deck")]
DeckGroup = Annotated[int, Field(ge=0, description="The deck track's group that holds the deck")]


class Region(Wire):
    """A box on the slide, in fractions of it: x, y the top-left corner."""

    x: Fraction
    y: Fraction
    w: Fraction
    h: Fraction


# The deck and its annotations are shared state (decision 0021). Every annotation mutation names who made it: an
# ``Author``, stamped by the publisher (the speaker's console on its own tracks, the room service for everyone
# else), never taken from what a listener sent.

UserId = Annotated[
    str,
    Field(
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9_-]+$",
        description="Stable for one person in the room: given by the room service (listeners) or the console (speaker)",
    ),
]
DisplayName = Annotated[str, Field(min_length=1, max_length=60, description="Display name, no account")]


class Author(Wire):
    id: UserId
    name: DisplayName
    speaker: bool = Field(default=False, description="The speaker: may erase, unmark or hide anyone's annotations")


def may_change(by: Author, owner: Author) -> bool:
    """Whether ``by`` may erase, unmark, clear or hide what ``owner`` made: their own, or anyone's for the speaker."""
    return by.speaker or by.id == owner.id


# deck: track ``deck`` in ``talk/<room>/slides``, one group per deck. Object 0 holds the ``DeckInfo``; each later
# object holds slide images, sent at once or each before it is first shown. The group number is the deck's id that
# the slide, ink and comment records name: the room slice the deck was loaded in, or one more than the previous
# deck's group if that is not larger, so ids never repeat.


class DeckInfo(Wire):
    kind: Literal["deck"] = "deck"
    count: int = Field(ge=1, description="Number of slides")
    aspect: float = Field(gt=0, description="Slide width / height, for layout before the images arrive")
    title: str | None = Field(default=None, description="The deck's title, if the speaker gave one")


RunId = Annotated[str, Field(min_length=1, max_length=32, description="Unique within its slide, e.g. t23")]


class TextRun(Wire):
    """A run of the slide's text layer (a word or a line of one style, from the PDF's text content), so text marks and
    comment anchors can address it: 'underline slide 13, run t23'."""

    id: RunId
    text: str = Field(min_length=1)
    box: Region = Field(description="Where the run sits on the slide; a part of a run is placed by character count")


class DeckImage(Wire):
    kind: Literal["image"] = "image"
    index: SlideIndex
    mime: Literal["image/webp", "image/jpeg", "image/png"]
    width: int = Field(ge=1, description="Pixels")
    height: int = Field(ge=1, description="Pixels")
    data_b64: str = Field(min_length=1)
    runs: list[TextRun] = Field(
        default_factory=list[TextRun],
        description="The slide's text layer in reading order, which text marks and comment anchors address; empty for"
        " a slide without text",
    )

    @model_validator(mode="after")
    def _unique_runs(self) -> DeckImage:
        if len({r.id for r in self.runs}) != len(self.runs):
            raise ValueError("run ids repeat within a slide")
        return self


class DeckRecord(Wire):
    m: int = Field(ge=0, description="Room ms when the deck was loaded or the image sent")
    data: Annotated[DeckInfo | DeckImage, Field(discriminator="kind")]


class DeckObject(RootModel[list[DeckRecord]]):
    """One object of the ``deck`` track (eventType ``com.talktracks.deck``)."""

    model_config = ConfigDict(frozen=True)


# slide: which slide is on screen. Carry-in: the last record (the slide on screen, or hidden).


class ShowSlide(Wire):
    kind: Literal["show"] = "show"
    deck: DeckGroup
    index: SlideIndex


class HideSlide(Wire):
    """The speaker stopped showing slides."""

    kind: Literal["hide"] = "hide"


class CurrentSlideRecord(Wire):
    m: int = Field(ge=0, description="Room ms when the slide was shown or hidden")
    data: Annotated[ShowSlide | HideSlide, Field(discriminator="kind")]


class CurrentSlideObject(RootModel[list[CurrentSlideRecord]]):
    """One object of the ``slide`` track (eventType ``com.talktracks.current-slide``)."""

    model_config = ConfigDict(frozen=True)


# ink (the pencil tool): freehand strokes that stay on their slide. A stroke is ``begin``, ``points`` (any number),
# ``end``. ``stroke`` states a whole stroke at once: in the carry-in (every stroke visible on the slide on screen,
# ``done`` false while still being drawn) and, re-sent at the moment a slide that kept its ink is shown again, so a
# reader that started from a later carry-in sees it too. ``erase`` removes strokes, ``clear`` a slide's ink. ``m`` is
# when the record took effect on screen; a re-sent stroke's m is when its slide was shown.
#
# The same object is used on the speaker's track (``talk/<room>/slides`` ``ink``) and on the room service's track of
# everyone else's ink (``talk/<room>/annotations`` ``ink``). ``begin``, ``stroke``, ``erase`` and ``clear`` name
# their author (``by``); ``points`` and ``end`` belong to their stroke's author. A record changes only its own
# track's strokes, and only those ``by`` may change (``may_change``): ``clear`` removes the strokes on the slide that
# its author may change, so the speaker's clear empties the slide and a listener's removes their own.


InkTool = Literal["pen", "highlighter"]
StrokeId = Annotated[
    str,
    Field(
        min_length=1,
        description="Unique in the room, stable across re-sends; the room service prefixes a listener's with their id",
    ),
]
Colour = Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$", description="#rrggbb")]
Width = Annotated[float, Field(gt=0, le=1, description="Line width as a fraction of the slide's width")]
Points = Annotated[list[Point], Field(min_length=1, description="[x, y] fractions of the slide, in drawing order")]


class InkBegin(Wire):
    kind: Literal["begin"] = "begin"
    stroke: StrokeId
    deck: DeckGroup
    index: SlideIndex
    tool: InkTool
    color: Colour
    width: Width
    points: Points
    by: Author


class InkPoints(Wire):
    kind: Literal["points"] = "points"
    stroke: StrokeId
    points: Points


class InkEnd(Wire):
    kind: Literal["end"] = "end"
    stroke: StrokeId


class InkStroke(Wire):
    kind: Literal["stroke"] = "stroke"
    stroke: StrokeId
    deck: DeckGroup
    index: SlideIndex
    tool: InkTool
    color: Colour
    width: Width
    points: Points
    by: Author
    done: bool = Field(description="False while its author is still drawing it: points and end follow")


class InkErase(Wire):
    kind: Literal["erase"] = "erase"
    strokes: list[StrokeId] = Field(min_length=1)
    by: Author


class InkClear(Wire):
    kind: Literal["clear"] = "clear"
    deck: DeckGroup
    index: SlideIndex
    by: Author


InkData = Annotated[InkBegin | InkPoints | InkEnd | InkStroke | InkErase | InkClear, Field(discriminator="kind")]


class InkRecord(Wire):
    m: int = Field(ge=0, description="Room ms when it took effect on screen")
    data: InkData


class InkObject(RootModel[list[InkRecord]]):
    """One object of an ``ink`` track (eventType ``com.talktracks.ink``): the speaker's or the room service's."""

    model_config = ConfigDict(frozen=True)


# marks (the text tool): underlines and highlights anchored to a range of the slide's text layer (``DeckImage.runs``),
# not to pixels, so they follow the text. A mark is one ``mark`` record (no begin/points/end: it is made whole);
# ``unmark`` removes marks, ``clear`` a slide's marks, with the same author rules as ink. Carry-in: the marks on the
# slide on screen; when a slide is shown its marks are re-sent with m = that moment. Speaker's track:
# ``talk/<room>/slides`` ``marks``; everyone else's: ``talk/<room>/annotations`` ``marks``.


class RunSpan(Wire):
    """Characters [start, end) of one text run; the whole run by default."""

    run: RunId
    start: int = Field(default=0, ge=0, description="First character in the run")
    end: int | None = Field(default=None, ge=0, description="One past the last character; none for the run's end")

    @model_validator(mode="after")
    def _ordered(self) -> RunSpan:
        if self.end is not None and self.end < self.start:
            raise ValueError("a run span ends before it starts")
        return self


TextRange = Annotated[
    list[RunSpan], Field(min_length=1, description="Spans of the slide's text runs, in reading order")
]
MarkId = Annotated[
    str,
    Field(min_length=1, description="Unique in the room; the room service prefixes a listener's with their id"),
]


class TextMark(Wire):
    kind: Literal["mark"] = "mark"
    id: MarkId
    deck: DeckGroup
    index: SlideIndex
    style: Literal["underline", "highlight"]
    color: Colour
    span: TextRange
    by: Author


class Unmark(Wire):
    kind: Literal["unmark"] = "unmark"
    marks: list[MarkId] = Field(min_length=1)
    by: Author


class MarksClear(Wire):
    kind: Literal["clear"] = "clear"
    deck: DeckGroup
    index: SlideIndex
    by: Author


class MarkRecord(Wire):
    m: int = Field(ge=0, description="Room ms when it took effect on screen (a re-sent mark: when its slide was shown)")
    data: Annotated[TextMark | Unmark | MarksClear, Field(discriminator="kind")]


class MarksObject(RootModel[list[MarkRecord]]):
    """One object of a ``marks`` track (eventType ``com.talktracks.marks``): the speaker's or the room service's."""

    model_config = ConfigDict(frozen=True)


# pointer (the laser tool): where the speaker points, sampled about 20 times a second while held; an object may batch a
# few samples but never crosses a slice. Ephemeral: never part of the deck's state, never re-sent, never kept per
# slide; the console sends ``off`` when the laser is released or the slide changes. Carry-in: the last record.


class PointerAt(Wire):
    kind: Literal["at"] = "at"
    x: Fraction
    y: Fraction


class PointerOff(Wire):
    kind: Literal["off"] = "off"


class PointerRecord(Wire):
    m: int = Field(ge=0)
    data: Annotated[PointerAt | PointerOff, Field(discriminator="kind")]


class PointerObject(RootModel[list[PointerRecord]]):
    """One object of the ``pointer`` track (eventType ``com.talktracks.pointer``)."""

    model_config = ConfigDict(frozen=True)


# comments: listeners post through the room service, which publishes them (decision 0005). A thread is a
# ``comment`` and its ``reply`` records; ``edit`` replaces a text (its author only), ``hide`` removes a comment or
# reply (its author or the speaker). Carry-in: the threads anchored on the slide on screen, as their comment and reply
# records with edits applied and hidden ones left out. As with ink, when a slide is shown the room service re-sends its
# threads (comment, then replies, current text) with m = that moment; ``at`` keeps when each was posted.


class Anchor(Wire):
    """Where on a slide: a region, a text range, both (the range's box), or neither (the whole slide)."""

    deck: DeckGroup
    index: SlideIndex
    region: Region | None = None
    span: TextRange | None = Field(default=None, description="Spans of the slide's text runs")


CommentId = Annotated[str, Field(min_length=1, description="Given by the room service, unique in the room")]
CommentText = Annotated[str, Field(min_length=1, max_length=2000)]


PostedAt = Annotated[int, Field(ge=0, description="Room ms it was posted at; the record's m is when it appeared")]


class Comment(Wire):
    kind: Literal["comment"] = "comment"
    id: CommentId
    at: PostedAt
    by: Author
    text: CommentText
    anchor: Anchor
    question: bool = Field(default=False, description="Asked as a question for the speaker")


class Reply(Wire):
    kind: Literal["reply"] = "reply"
    id: CommentId
    at: PostedAt
    to: CommentId = Field(description="The thread's comment")
    by: Author = Field(description="The speaker's replies are shown first")
    text: CommentText


class CommentEdit(Wire):
    kind: Literal["edit"] = "edit"
    id: CommentId
    text: CommentText
    by: Author


class CommentHide(Wire):
    kind: Literal["hide"] = "hide"
    id: CommentId
    by: Author


CommentData = Annotated[Comment | Reply | CommentEdit | CommentHide, Field(discriminator="kind")]


class CommentRecord(Wire):
    m: int = Field(ge=0, description="Room ms when it took effect: posted, edited, hidden, or its slide shown again")
    data: CommentData

    @model_validator(mode="after")
    def _not_before_posted(self) -> CommentRecord:
        if isinstance(self.data, Comment | Reply) and self.m < self.data.at:
            raise ValueError("a comment record's m is not before its at")
        return self


class CommentsObject(RootModel[list[CommentRecord]]):
    """One object of the ``comments`` track (eventType ``com.talktracks.comments``)."""

    model_config = ConfigDict(frozen=True)


# room: the room's state, published by the room service. Carry-in: the last record.


class RoomState(Wire):
    kind: Literal["state"] = "state"
    state: Literal["waiting", "on_air", "paused", "ended"]
    title: str | None = Field(default=None, description="The talk's title")
    speaker: str | None = Field(default=None, description="The speaker's display name")


class RoomStateRecord(Wire):
    m: int = Field(ge=0)
    data: RoomState


class RoomStateObject(RootModel[list[RoomStateRecord]]):
    """One object of the ``room`` track (eventType ``com.talktracks.room``)."""

    model_config = ConfigDict(frozen=True)


DECK_EVENT = "com.talktracks.deck"
CURRENT_SLIDE_EVENT = "com.talktracks.current-slide"
INK_EVENT = "com.talktracks.ink"
MARKS_EVENT = "com.talktracks.marks"
POINTER_EVENT = "com.talktracks.pointer"
COMMENTS_EVENT = "com.talktracks.comments"
ROOM_EVENT = "com.talktracks.room"


# --- the room catalog (design §5.10), published by the room service on ``talk/<room>/catalog`` ---------------


class TrackStatus(Wire):
    """One agent's state, from its archive reports and the spend ledger. Older than 15 s means stale."""

    status: Literal["idle", "live", "capped"]
    producing: bool = Field(description="The agent is doing live work for subscribers")
    fetches_served: int = Field(ge=0, description="FETCHes this agent answered as the origin (relay cache misses)")
    backfills: int = Field(ge=0, description="Slices produced for a FETCH")
    spend_usd: float = Field(ge=0)
    updated_ms: int = Field(ge=0, description="Unix ms of the agent's last report")


class Source(Wire):
    """A picture or sound the speaker is sending now, which the player can lay out (ui-design §3.2)."""

    kind: Literal["audio", "camera", "screen", "slides"]
    namespace: str = Field(description="talk/<room>/teacher for audio and camera, talk/<room>/slides for slides")
    tracks: list[str] = Field(
        min_length=1,
        description="Track names in that namespace: catalog.json for audio and camera (the hang catalog names the media"
        " tracks), deck, slide, ink, marks and pointer for slides",
    )
    label: str | None = None


class RoomTt(Wire):
    """Talk Tracks' extension of the catalog root."""

    E: int = Field(ge=0, description="The room epoch, Unix ms, a multiple of 4000: room time = wall time - E")
    shift: dict[str, int] = Field(
        description="Per teacher broadcast, keyed by its clock.wall as a decimal string: ms added to its room times,"
        " a multiple of 4000 (0 normally). Nobody stamps a broadcast that is not listed yet"
    )
    status: dict[str, TrackStatus] = Field(default_factory=dict, description="Per agent name")
    sources: list[Source] = Field(
        default_factory=list[Source], description="The speaker's sources, in the speaker's order"
    )

    @model_validator(mode="after")
    def _whole_slices(self) -> RoomTt:
        if self.E % SLICE_MS or any(v % SLICE_MS for v in self.shift.values()):
            raise ValueError("E and every shift are whole slices")
        return self


class TrackTt(Wire):
    dependsOn: list[str] = Field(default_factory=list, description="Full paths of the tracks this one is made from")
    latenessMs: int = Field(ge=0, default=0, description="L: how much later than its slice a record may arrive")
    cost: Literal["paid", "free"]


class CatalogTrack(BaseModel):
    """An MSF catalog track (MSF §5.2). Other MSF fields pass through."""

    model_config = ConfigDict(extra="allow", frozen=True)

    name: str
    namespace: str
    packaging: str = Field(description="eventtimeline for the agent tracks")
    mimeType: str | None = None
    eventType: str | None = None
    role: str | None = None
    lang: str | None = None
    label: str | None = None
    isLive: bool | None = None
    template: list[Any] | None = Field(default=None, description="[0, 4000, [0, 0], [1, 0], E, 4000] when sliced")
    tt: TrackTt | None = None


class RoomCatalog(BaseModel):
    """Object 0 of each group of ``talk/<room>/catalog``: the whole catalog (MSF §5)."""

    model_config = ConfigDict(extra="allow", frozen=True)

    version: Literal["draft-01"] = "draft-01"
    tracks: list[CatalogTrack]
    tt: RoomTt


def slice_template(epoch: int) -> list[Any]:
    """The MSF template of a sliced track (MSF §7.4): group k starts at room ms k * 4000."""
    return [0, SLICE_MS, [0, 0], [1, 0], epoch, SLICE_MS]


# --- deprecated: envelope v2, until the publisher, follow, demo and recordings move to the records above --------
# Not on the wire any more and not in contracts/.

SCHEMA_VERSION = 2
CARRY_LINES = CARRY_CUES


class CaptionsCarry(Wire):
    type: Literal["captions-carry"] = "captions-carry"
    lang: str
    lines: list[CaptionLine] = Field(max_length=CARRY_LINES, description="The last final lines before the slice")


class CaptionItem(Wire):
    type: Literal["caption"] = "caption"
    lang: str
    line: CaptionLine
    final: bool = Field(description="False for an interim version; a later item with the same id replaces it")


class TranslationCarry(Wire):
    type: Literal["translation-carry"] = "translation-carry"
    lang: str
    lines: list[TranslatedLine] = Field(max_length=CARRY_LINES, description="The last lines before the slice")


class TranslationItem(Wire):
    type: Literal["translation"] = "translation"
    lang: str
    line: TranslatedLine


class SlidesCarry(Wire):
    type: Literal["slides-carry"] = "slides-carry"
    lang: str
    slide: SlideNote | None = Field(description="The slide on screen when the slice starts, if any")


class SlideItem(Wire):
    type: Literal["slide"] = "slide"
    lang: str
    slide: SlideNote


class OutlineSnapshot(Wire):
    """One revision of the whole outline: chapters, glossary and recap are revised together, never sliced."""

    type: Literal["outline"] = "outline"
    lang: str
    chapters: list[Chapter]
    glossary: list[GlossaryTerm]
    recap: str = ""


Carry = CaptionsCarry | TranslationCarry | SlidesCarry
Item = CaptionItem | TranslationItem | SlideItem
Body = Annotated[Carry | Item | OutlineSnapshot, Field(discriminator="type")]
KIND_OF_BODY = {
    "captions-carry": "carry",
    "translation-carry": "carry",
    "slides-carry": "carry",
    "caption": "item",
    "translation": "item",
    "slide": "item",
    "outline": "snapshot",
}


class Usage(Wire):
    """Cumulative model usage of this agent process: the load panel shows cost per track, not per viewer."""

    requests: int = Field(ge=0, default=0)
    input_tokens: int = Field(ge=0, default=0)
    output_tokens: int = Field(ge=0, default=0)
    cost_usd: float = Field(ge=0, default=0.0)


class AgentInfo(Wire):
    name: str = Field(description="Stable agent name, for example captions or translate-tr")
    label: str = Field(description="What a viewer sees in the track list")
    model: str = Field(description="Which model does the work, or 'none'")


class Envelope(Wire):
    """One object. ``kind`` says where it sits: object 0 of a slice (``carry``), a later one (``item``), or the only
    object of an outline revision (``snapshot``)."""

    v: Literal[2] = SCHEMA_VERSION
    agent: AgentInfo
    slice: int = Field(
        ge=0, description="The group: media time [slice * 4 s, (slice + 1) * 4 s); for the outline, of the revision"
    )
    kind: Literal["carry", "item", "snapshot"]
    capped: bool = Field(
        default=False, description="On a carry-in: the room reached its spend cap, so no items follow in this slice"
    )
    at_ms: int = Field(ge=0, description="Wall-clock time of publication")
    usage: Usage
    body: Body

    @model_validator(mode="after")
    def _kind_matches_body(self) -> Envelope:
        if KIND_OF_BODY[self.body.type] != self.kind:
            raise ValueError(f"a {self.body.type} body is a {KIND_OF_BODY[self.body.type]}, not a {self.kind}")
        if self.capped and self.kind != "carry":
            raise ValueError("only a carry-in is marked capped")
        return self


ENVELOPE: TypeAdapter[Envelope] = TypeAdapter(Envelope)

# --- the speaker's slide frames, on their own broadcast as plain data objects ------------------------------


class SlideFrame(Wire):
    id: int = Field(ge=0)
    at_ms: int = Field(ge=0, description="Unix wall ms when the slide appeared (timeOrigin + performance.now())")
    mime: Literal["image/jpeg", "image/png"]
    data_b64: str


# --- names ---------------------------------------------------------------------------------------------------

ROOT = "talk"
CATALOG_TRACK = "catalog"  # in catalog_path(room)


def teacher_path(room: str) -> str:
    """The speaker's hang broadcast (@moq/publish): microphone and camera, described by its ``catalog.json``."""
    return f"{ROOT}/{room}/teacher"


HANG_CATALOG_TRACK = "catalog.json"  # names the media tracks of teacher_path(room)


def slides_path(room: str) -> str:
    """The speaker's slide broadcast: ``frames`` (for the describe agent), ``deck``, ``slide``, ``ink``, ``marks``,
    ``pointer``."""
    return f"{ROOT}/{room}/slides"


FRAMES_TRACK = "frames"  # SlideFrame objects, one per slide shown
DECK_TRACK = "deck"  # DeckObject, one group per deck
SLIDE_TRACK = "slide"  # CurrentSlideObject, sliced
INK_TRACK = "ink"  # InkObject, sliced; also in annotations_path(room)
MARKS_TRACK = "marks"  # MarksObject, sliced; also in annotations_path(room)
POINTER_TRACK = "pointer"  # PointerObject, sliced


def catalog_path(room: str) -> str:
    """The room service's broadcast: ``catalog`` (the room catalog) and ``room`` (the room's state)."""
    return f"{ROOT}/{room}/catalog"


ROOM_TRACK = "room"  # RoomStateObject, sliced, in catalog_path(room)


def comments_path(room: str) -> str:
    """Listener comments, published by the room service (listeners never publish to the relay)."""
    return f"{ROOT}/{room}/comments"


COMMENTS_TRACK = "comments"  # CommentsObject, sliced


def annotations_path(room: str) -> str:
    """Everyone else's annotations of the deck (``ink``, ``marks``), published by the room service (decision 0021)."""
    return f"{ROOT}/{room}/annotations"


def agents_prefix(room: str) -> str:
    return f"{ROOT}/{room}/agents"


ITEMS_TRACK = "items"  # every sliced agent track
OUTLINE_TRACK = "outline"  # the chapters agent's snapshot track


def agent_path(room: str, agent: str) -> str:
    """Stable: a restarted agent announces the same name and takes over."""
    return f"{agents_prefix(room)}/{agent}"


def slice_of(room_time_ms: int) -> int:
    return max(0, room_time_ms) // SLICE_MS


def parse_room(room: str) -> str:
    if not (3 <= len(room) <= 32 and all(c.islower() or c.isdigit() or c == "-" for c in room)):
        raise ValueError(f"room must be 3-32 chars of a-z, 0-9 and '-': {room!r}")
    return room
