"""Following a room's agent tracks back into full states: what ``record`` stores and ``watch`` prints. Transport-free.

An agent publishes under a stable name, ``talk/<room>/agents/<agent>`` (decision 0012), and the room catalog lists
its tracks with their ``eventType`` (``room_catalog``). Each object is an MSF event timeline (``contracts``):
``TrackFollower`` keeps every record it has read and rebuilds the agent's full state after each object, the shape the
cores keep and recordings store, with every time in room ms.

* Captions: each cue id's highest ``rev`` wins; final cues are the lines (id: the cue id as a number), and the newest
  cue still not final is the interim text.
* Translation: every cue, by id, as a translated line with its caption cue's times.
* Slides: every slide by id. Outline: each group is the whole outline, so the newest object is the state.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, Literal

from .contracts import (
    CUE_EVENT,
    OUTLINE_EVENT,
    SLIDES_EVENT,
    CaptionLine,
    CaptionsState,
    Chapter,
    ChapterData,
    Cue,
    CueObject,
    CueRecord,
    GlossaryTerm,
    OutlineObject,
    OutlineState,
    RecapData,
    RoomCatalog,
    SlideNote,
    SlideObject,
    SlideRecord,
    SlidesState,
    State,
    TermData,
    TranslatedLine,
    TranslationState,
)

Kind = Literal["captions", "translation", "slides", "outline"]
KEEP = 60  # lines and slides a rebuilt state holds, as the cores keep them


@dataclass(frozen=True)
class FollowedTrack:
    """An agent track the room catalog lists."""

    agent: str
    namespace: str
    name: str
    kind: Kind
    lang: str
    label: str


def kind_of(event_type: str | None, role: str | None) -> Kind | None:
    if event_type == CUE_EVENT:
        return "translation" if role == "subtitle" else "captions"
    return {SLIDES_EVENT: "slides", OUTLINE_EVENT: "outline"}.get(event_type or "")  # type: ignore[return-value]


def catalog_tracks(catalog: RoomCatalog) -> Iterator[FollowedTrack]:
    """The agent tracks of a room catalog, each with what a follower needs to read it."""
    for track in catalog.tracks:
        kind = kind_of(track.eventType, track.role)
        if kind is None or "/agents/" not in track.namespace:
            continue
        agent = track.namespace.rsplit("/", 1)[-1]
        yield FollowedTrack(agent, track.namespace, track.name, kind, track.lang or "", track.label or agent)


def line_id(cue_id: str, known: dict[str, int]) -> int:
    """A cue id as a recorded line id: the number itself, or the next free number for any other string."""
    if cue_id.isdigit():
        return int(cue_id)
    if cue_id not in known:
        known[cue_id] = max(known.values(), default=-1) + 1
    return known[cue_id]


class TrackFollower:
    """One agent track's objects, in arrival order, back into the agent's full state."""

    def __init__(self, kind: Kind, lang: str) -> None:
        self.kind, self.lang = kind, lang
        self._cues: dict[str, Cue] = {}
        self._slides: dict[int, SlideNote] = {}
        self._outline: OutlineState | None = None
        self._ids: dict[str, int] = {}
        self._last: State | None = None

    def accept(self, payload: bytes) -> State | None:
        """The state after one more object; None when the object changed nothing (a repeated carry-in)."""
        if self.kind in ("captions", "translation"):
            for record in CueObject.model_validate_json(payload).root:
                if isinstance(record, CueRecord):
                    held = self._cues.get(record.data.id)
                    if held is None or record.data.rev >= held.rev:
                        self._cues[record.data.id] = record.data
        elif self.kind == "slides":
            for record in SlideObject.model_validate_json(payload).root:
                if isinstance(record, SlideRecord):
                    s = record.data
                    self._slides[s.id] = SlideNote(id=s.id, at_ms=s.at, description=s.text)
        else:
            self._outline = _outline(OutlineObject.model_validate_json(payload), self.lang)
        state = self.state()
        if state == self._last:
            return None
        self._last = state
        return state

    def state(self) -> State:
        if self.kind == "captions":
            finals = sorted((c for c in self._cues.values() if c.final), key=lambda c: (c.start, c.id))[-KEEP:]
            lines = [
                CaptionLine(id=line_id(c.id, self._ids), start_ms=c.start, end_ms=c.end, text=c.text) for c in finals
            ]
            open_ = [c for c in self._cues.values() if not c.final]
            interim = max(open_, key=lambda c: (c.start, c.rev)).text if open_ else ""
            return CaptionsState(lang=self.lang, lines=lines, interim=interim)
        if self.kind == "translation":
            cues = sorted(self._cues.values(), key=lambda c: (c.start, c.id))[-KEEP:]
            lines = [
                TranslatedLine(id=line_id(c.id, self._ids), start_ms=c.start, end_ms=c.end, text=c.text) for c in cues
            ]
            return TranslationState(lang=self.lang, lines=lines)
        if self.kind == "slides":
            return SlidesState(lang=self.lang, slides=[self._slides[i] for i in sorted(self._slides)[-KEEP:]])
        return self._outline or OutlineState(lang=self.lang, chapters=[], glossary=[])


def _outline(obj: OutlineObject, lang: str) -> OutlineState:
    chapters: list[Chapter] = []
    glossary: list[GlossaryTerm] = []
    recap = ""
    for record in obj.root:
        data: Any = record.data
        if isinstance(data, ChapterData):
            chapters.append(Chapter(id=data.id, start_ms=data.start, title=data.title, summary=data.summary))
        elif isinstance(data, TermData):
            glossary.append(GlossaryTerm(term=data.term, definition=data.definition))
        elif isinstance(data, RecapData):
            recap = data.text
    return OutlineState(lang=lang, chapters=chapters, glossary=glossary, recap=recap)
