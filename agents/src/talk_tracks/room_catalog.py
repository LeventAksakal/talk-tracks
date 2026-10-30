"""The room catalog on ``talk/<room>/catalog`` track ``catalog``: an MSF catalog (draft-01) of the room's event tracks
(the agents', the speaker's deck/slide/ink/pointer and the room service's room/comments, ui-design §3.4) and, in
``tt.sources``, the pictures and sound the speaker is sending.

Layout from wiki/design/moq-track-system.md §5.10, field names as locked in wiki/design/lane-briefs.md ("Catalog field
names"), validated by the contract's ``contracts.RoomCatalog`` before it goes out. Transport-free, so the room service
(live rooms) and the looper (demo rooms) build it the same way. Each change is a new group whose object 0 is the whole
catalog.

* Root: ``version``, ``tracks`` and the Talk Tracks extension ``tt``: the room epoch ``E`` (Unix ms), the skew shift
  per teacher broadcast (``shift``, keyed by the broadcast's hang ``clock.wall`` as a decimal string, in ms, a
  multiple of 4000) and each agent's state (``status``, by bare agent name, ``contracts.TrackStatus``), which MSF
  keeps out of the track entries because a declared track may not change. A cap shows as ``status: "capped"``.
* A track: MSF's ``name``, ``namespace``, ``packaging``, ``mimeType``, ``eventType``, ``role``, ``lang`` and ``label``
  (left out when unset), ``isLive`` and, for a sliced track, ``template`` (MSF §7.4: slice ``k`` starts at
  ``E + k * S``); our extension ``tt`` with ``dependsOn`` (full track paths, since MSF's ``depends`` stays within one
  namespace), ``latenessMs`` (``L``) and ``cost``.

``@moq/msf`` 0.3's ``CatalogSchema`` strips what it does not declare (every field above but ``name``, ``packaging``,
``isLive`` and ``role``), so a viewer reads the raw JSON.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Literal

from .contracts import (
    CATALOG_TRACK,
    COMMENTS_EVENT,
    COMMENTS_TRACK,
    CUE_EVENT,
    CURRENT_SLIDE_EVENT,
    DECK_EVENT,
    DECK_TRACK,
    HANG_CATALOG_TRACK,
    INK_EVENT,
    INK_TRACK,
    OUTLINE_EVENT,
    POINTER_EVENT,
    POINTER_TRACK,
    ROOM_EVENT,
    ROOM_TRACK,
    ROOT,
    SLIDE_TRACK,
    SLIDES_EVENT,
    RoomTt,
    Source,
    TrackStatus,
    TrackTt,
    comments_path,
    slice_template,
    slides_path,
    teacher_path,
)
from .contracts import CatalogTrack as MsfTrack
from .contracts import RoomCatalog as MsfRoomCatalog
from .contracts import catalog_path as catalog_path

__all__ = [
    "CATALOG_TRACK",
    "CatalogTrack",
    "RoomCatalog",
    "catalog_path",
    "depends_on",
    "room_service_tracks",
    "speaker_sources",
    "speaker_tracks",
]

AgentKind = Literal["captions", "translation", "slides", "outline"]
EventKind = Literal["deck", "slide", "ink", "pointer", "comments", "room"]
Kind = AgentKind | EventKind
Cost = Literal["paid", "free"]

EVENT_TYPES: dict[Kind, str] = {
    "captions": CUE_EVENT,
    "translation": CUE_EVENT,
    "slides": SLIDES_EVENT,
    "outline": OUTLINE_EVENT,
    "deck": DECK_EVENT,
    "slide": CURRENT_SLIDE_EVENT,
    "ink": INK_EVENT,
    "pointer": POINTER_EVENT,
    "comments": COMMENTS_EVENT,
    "room": ROOM_EVENT,
}
ROLES: dict[Kind, str] = {"captions": "caption", "translation": "subtitle"}
UNSLICED: frozenset[Kind] = frozenset({"outline", "deck"})  # one group per revision or per deck, no template


@dataclass(frozen=True)
class CatalogTrack:
    """One event track of the room (an agent's, the speaker's or the room service's), as its catalog entry
    describes it."""

    namespace: str  # talk/<room>/agents/<agent>, talk/<room>/slides, talk/<room>/comments or talk/<room>/catalog
    name: str  # items or outline for an agent; deck, slide, ink, pointer, comments or room
    kind: Kind
    lang: str
    label: str
    lateness_ms: int
    cost: Cost
    depends_on: tuple[str, ...] = ()  # full track paths, <namespace>/<name>


@dataclass(frozen=True)
class RoomCatalog:
    epoch_ms: int  # E: room time 0 in Unix ms, a multiple of S
    tracks: tuple[CatalogTrack, ...]
    shift: Mapping[int, int] = field(default_factory=dict[int, int])  # teacher clock.wall -> ms, a multiple of S
    # By bare agent name. A mapping is read as a TrackStatus; a ``capped`` key in it (the field before the names were
    # locked) is dropped, since the cap already shows as ``status: "capped"``.
    status: Mapping[str, TrackStatus | Mapping[str, object]] = field(
        default_factory=dict[str, TrackStatus | Mapping[str, object]]
    )
    sources: tuple[Source, ...] = ()  # what the speaker is sending now, in the speaker's order

    def entries(self) -> dict[str, TrackStatus]:
        return {name: _status(s) for name, s in self.status.items()}

    def updated(self, now_ms: int) -> RoomCatalog:
        """The same catalog with every status entry written now."""
        return replace(self, status={n: s.model_copy(update={"updated_ms": now_ms}) for n, s in self.entries().items()})

    def model(self) -> MsfRoomCatalog:
        """The catalog as the contract's model, which checks it (E and every shift whole slices, the field names)."""
        tt = RoomTt(
            E=self.epoch_ms,
            shift={str(wall): ms for wall, ms in self.shift.items()},
            status=self.entries(),
            sources=list(self.sources),
        )
        return MsfRoomCatalog(tracks=[_track(t, self.epoch_ms) for t in self.tracks], tt=tt)

    def to_json(self) -> dict[str, object]:
        return self.model().model_dump(mode="json", exclude_none=True)


def _status(s: TrackStatus | Mapping[str, object]) -> TrackStatus:
    if isinstance(s, TrackStatus):
        return s
    return TrackStatus.model_validate({k: v for k, v in s.items() if k != "capped"})


def _track(track: CatalogTrack, epoch_ms: int) -> MsfTrack:
    return MsfTrack(
        name=track.name,
        namespace=track.namespace,
        packaging="eventtimeline",
        mimeType="application/json",
        eventType=EVENT_TYPES[track.kind],
        role=ROLES.get(track.kind),
        lang=track.lang or None,
        label=track.label or None,
        isLive=True,
        template=None if track.kind in UNSLICED else slice_template(epoch_ms),
        tt=TrackTt(dependsOn=list(track.depends_on), latenessMs=track.lateness_ms, cost=track.cost),
    )


def speaker_tracks(room: str) -> tuple[CatalogTrack, ...]:
    """The speaker's event tracks on ``talk/<room>/slides`` (decision 0018): free, on time (L = 0)."""
    ns = slides_path(room)
    deck = f"{ns}/{DECK_TRACK}"
    slide = f"{ns}/{SLIDE_TRACK}"
    return (
        CatalogTrack(ns, DECK_TRACK, "deck", "", "Slide deck", 0, "free"),
        CatalogTrack(ns, SLIDE_TRACK, "slide", "", "Slide shown", 0, "free", (deck,)),
        CatalogTrack(ns, INK_TRACK, "ink", "", "Ink", 0, "free", (slide,)),
        CatalogTrack(ns, POINTER_TRACK, "pointer", "", "Laser pointer", 0, "free", (slide,)),
    )


def room_service_tracks(room: str) -> tuple[CatalogTrack, ...]:
    """The room service's event tracks: the room's state and the listeners' comments."""
    slide = f"{slides_path(room)}/{SLIDE_TRACK}"
    return (
        CatalogTrack(catalog_path(room), ROOM_TRACK, "room", "", "Room", 0, "free"),
        CatalogTrack(comments_path(room), COMMENTS_TRACK, "comments", "", "Comments", 0, "free", (slide,)),
    )


def speaker_sources(room: str, *, audio: bool = True, camera: bool = False, slides: bool = False) -> tuple[Source, ...]:
    """The sources the speaker is sending, for ``RoomCatalog.sources``: audio and camera on the hang broadcast,
    slides as the deck, slide, ink and pointer tracks."""
    teacher = teacher_path(room)
    return (
        *([Source(kind="audio", namespace=teacher, tracks=[HANG_CATALOG_TRACK])] if audio else []),
        *([Source(kind="camera", namespace=teacher, tracks=[HANG_CATALOG_TRACK])] if camera else []),
        *(
            [
                Source(
                    kind="slides",
                    namespace=slides_path(room),
                    tracks=[DECK_TRACK, SLIDE_TRACK, INK_TRACK, POINTER_TRACK],
                )
            ]
            if slides
            else []
        ),
    )


def depends_on(room: str, kind: Kind, captions: Sequence[str]) -> tuple[str, ...]:
    """What a track of ``kind`` is made from: captions (the room's captions tracks), or the speaker's slides."""
    if kind == "slides":
        return (f"{ROOT}/{room}/slides/frames",)
    if kind in ("translation", "outline"):
        return tuple(captions)
    return ()
