"""Wire contracts: what every agent publishes and what every viewer validates (decision 0012).

An agent publishes ``talk/<room>/agents/<agent>`` under a stable name. Its ``items`` track is cut into **slices** on
the speaker's media clock: group k covers media time [k·4 s, (k+1)·4 s). Object 0 of a group is the *carry-in*, a
small state that makes the group useful on its own (the last caption lines, the slide on screen); objects 1 and up
are *items*, one per object, in publication order; End of Group closes the slice, and End of Track ends the talk.
A slice nobody asked for is never produced, and a FETCH of it is answered by producing it then (back-fill).
The chapters agent's ``outline`` track is a snapshot track instead: each revision is a group of one object.
Each object is one ``Envelope``. The Location (group, object) is its sequence number.

The full states (``CaptionsState`` and the rest) are what the cores keep and what recordings store; they are not on
the wire. The JSON Schemas generated from these models are committed in ``contracts/`` and checked by both test
suites.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

SCHEMA_VERSION = 2
SLICE_MS = 4000  # group k of a sliced track covers media time [k * SLICE_MS, (k + 1) * SLICE_MS)
CARRY_LINES = 2  # caption or translated lines a carry-in repeats from before its slice


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


# --- what goes on the wire: carry-ins, items and the outline snapshot ---------------------------------------


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


# --- the envelope ------------------------------------------------------------------------------------------


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

# The teacher's slide frames travel on their own broadcast as plain data objects.


class SlideFrame(Wire):
    id: int = Field(ge=0)
    at_ms: int = Field(ge=0, description="Media time when the slide appeared")
    mime: Literal["image/jpeg", "image/png"]
    data_b64: str


class RoomClock(Wire):
    """The speaker console's room clock (design §4.5), track ``clock`` in ``talk/<room>/slides``: room time is the
    speaker's media timestamp plus ``offset_ms``. A group on change and every 4 s; published before the audio."""

    epoch_ms: int = Field(ge=0, description="Wall time of the room's first broadcast")
    offset_ms: int = Field(description="Added to this broadcast's media timestamps to give room time")
    session: str = Field(min_length=1, description="This broadcast: its start, wall ms")


# --- names ---------------------------------------------------------------------------------------------------

ROOT = "talk"


def teacher_path(room: str) -> str:
    return f"{ROOT}/{room}/teacher"


def slides_path(room: str) -> str:
    return f"{ROOT}/{room}/slides"


def agents_prefix(room: str) -> str:
    return f"{ROOT}/{room}/agents"


CLOCK_TRACK = "clock"  # in slides_path(room): the room clock (RoomClock)
ITEMS_TRACK = "items"  # every sliced agent track
OUTLINE_TRACK = "outline"  # the chapters agent's snapshot track


def agent_path(room: str, agent: str) -> str:
    """Stable: a restarted agent announces the same name and takes over."""
    return f"{agents_prefix(room)}/{agent}"


def slice_of(media_ms: int) -> int:
    return max(0, media_ms) // SLICE_MS


def parse_room(room: str) -> str:
    if not (3 <= len(room) <= 32 and all(c.islower() or c.isdigit() or c == "-" for c in room)):
        raise ValueError(f"room must be 3-32 chars of a-z, 0-9 and '-': {room!r}")
    return room
