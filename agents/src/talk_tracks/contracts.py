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


# --- the room catalog (design §5.10), published by the room service on ``talk/<room>/catalog`` ---------------


class TrackStatus(Wire):
    """One agent's state, from its archive reports and the spend ledger. Older than 15 s means stale."""

    status: Literal["idle", "live", "capped"]
    producing: bool = Field(description="The agent is doing live work for subscribers")
    fetches_served: int = Field(ge=0, description="FETCHes this agent answered as the origin (relay cache misses)")
    backfills: int = Field(ge=0, description="Slices produced for a FETCH")
    spend_usd: float = Field(ge=0)
    updated_ms: int = Field(ge=0, description="Unix ms of the agent's last report")


class RoomTt(Wire):
    """Talk Tracks' extension of the catalog root."""

    E: int = Field(ge=0, description="The room epoch, Unix ms, a multiple of 4000: room time = wall time - E")
    shift: dict[str, int] = Field(
        description="Per teacher broadcast, keyed by its clock.wall as a decimal string: ms added to its room times,"
        " a multiple of 4000 (0 normally). Nobody stamps a broadcast that is not listed yet"
    )
    status: dict[str, TrackStatus] = Field(default_factory=dict, description="Per agent name")

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
    return f"{ROOT}/{room}/teacher"


def slides_path(room: str) -> str:
    return f"{ROOT}/{room}/slides"


def catalog_path(room: str) -> str:
    return f"{ROOT}/{room}/catalog"


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
