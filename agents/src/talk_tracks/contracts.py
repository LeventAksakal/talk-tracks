"""Wire contracts: what every agent publishes and what every viewer validates.

Every object on an agent track is one JSON document in its own group (one object per group). It is a *snapshot*:
self-contained, so a viewer that joins late, or switches to a replacement agent, needs no history.
The JSON Schemas generated from these models are committed in ``contracts/`` and checked by both test suites.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

SCHEMA_VERSION = 1


class Wire(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# --- states, one per kind of agent -------------------------------------------------------------------------


class CaptionLine(Wire):
    id: int = Field(ge=0, description="Increases by one per line; stable across restarts")
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


# --- the envelope ------------------------------------------------------------------------------------------


class Usage(Wire):
    """Cumulative model usage of this agent instance: the load panel shows cost per track, not per viewer."""

    requests: int = Field(ge=0, default=0)
    input_tokens: int = Field(ge=0, default=0)
    output_tokens: int = Field(ge=0, default=0)
    cost_usd: float = Field(ge=0, default=0.0)


class AgentInfo(Wire):
    name: str = Field(description="Stable agent name, for example captions or translate-tr")
    label: str = Field(description="What a viewer sees in the track list")
    model: str = Field(description="Which model does the work, or 'none'")


class Envelope(Wire):
    v: Literal[1] = SCHEMA_VERSION
    agent: AgentInfo
    instance: str = Field(description="Start time of this agent process in ms; a replacement gets a new one")
    seq: int = Field(ge=0, description="Increases by one per state change; a heartbeat repeats the same seq")
    at_ms: int = Field(ge=0, description="Wall-clock time of publication")
    usage: Usage
    state: State


ENVELOPE: TypeAdapter[Envelope] = TypeAdapter(Envelope)

# The teacher's slide frames travel on their own broadcast as plain data objects.


class SlideFrame(Wire):
    id: int = Field(ge=0)
    at_ms: int = Field(ge=0, description="Media time when the slide appeared")
    mime: Literal["image/jpeg", "image/png"]
    data_b64: str


# --- names ---------------------------------------------------------------------------------------------------

ROOT = "talk"


def teacher_path(room: str) -> str:
    return f"{ROOT}/{room}/teacher"


def slides_path(room: str) -> str:
    return f"{ROOT}/{room}/slides"


def agents_prefix(room: str) -> str:
    return f"{ROOT}/{room}/agents"


def agent_path(room: str, agent: str, instance: str) -> str:
    return f"{agents_prefix(room)}/{agent}/{instance}"


def parse_room(room: str) -> str:
    if not (3 <= len(room) <= 32 and all(c.islower() or c.isdigit() or c == "-" for c in room)):
        raise ValueError(f"room must be 3-32 chars of a-z, 0-9 and '-': {room!r}")
    return room
