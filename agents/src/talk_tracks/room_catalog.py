"""The room catalog on ``talk/<room>/catalog`` track ``catalog``: an MSF catalog (draft-01) of the room's AI tracks.

Layout from wiki/design/moq-track-system.md §5.10. Transport-free, so the room service (live rooms) and the looper
(demo rooms) build it the same way. Each change is a new group whose object 0 is the whole catalog.

* Root: ``version``, ``tracks`` and the Talk Tracks extension ``tt``: the room epoch ``E`` (``epoch``, Unix ms), the
  skew shift per teacher broadcast (``shift``, keyed by the broadcast's hang ``clock.wall``, in ms, a whole number of
  slices) and the status of each agent (``status``, ``AgentStatus``), which MSF keeps out of the track entries
  because a declared track may not change.
* A track: MSF's ``name``, ``namespace``, ``packaging``, ``mimeType``, ``eventType``, ``role``, ``lang``, ``label``,
  ``isLive`` and, for a sliced track, ``template`` (MSF §7.4: slice ``k`` starts at ``E + k * S``); our extension
  ``tt`` with ``dependsOn`` (full track paths, since MSF's ``depends`` stays within one namespace), ``latenessMs``
  (``L``) and ``cost``.

``@moq/msf`` 0.3's ``CatalogSchema`` strips what it does not declare (every field above but ``name``, ``packaging``,
``isLive`` and ``role``), so a viewer reads the raw JSON. Field names as locked in wiki/design/lane-briefs.md,
"Catalog field names".
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field, replace
from typing import Literal

from .contracts import ROOT

MSF_VERSION = "draft-01"
CATALOG_TRACK = "catalog"
SLICE_MS = 4000  # S, as in ``slicing``

Kind = Literal["captions", "translation", "slides", "outline"]
Cost = Literal["paid", "free"]
Status = Literal["idle", "live", "capped"]

EVENT_TYPES: dict[Kind, str] = {
    "captions": "urn:msf:captions:webvtt",
    "translation": "urn:msf:captions:webvtt",
    "slides": "com.talktracks.slides",
    "outline": "com.talktracks.outline",
}
ROLES: dict[Kind, str] = {"captions": "caption", "translation": "subtitle"}


def catalog_path(room: str) -> str:
    return f"{ROOT}/{room}/catalog"


@dataclass(frozen=True)
class CatalogTrack:
    """One AI track of the room, as its catalog entry describes it."""

    namespace: str  # talk/<room>/agents/<agent>
    name: str  # items, or outline
    kind: Kind
    lang: str
    label: str
    lateness_ms: int
    cost: Cost
    depends_on: tuple[str, ...] = ()  # full track paths, <namespace>/<name>


@dataclass(frozen=True)
class AgentStatus:
    """``tt.status.<agent>``. An entry older than 15 s counts as idle; the ledger's cap overrides ``status``."""

    status: Status
    producing: bool
    capped: bool
    fetches_served: int  # FETCHes it answered as origin
    backfills: int  # slices it back-filled
    spend_usd: float  # what it has spent in this room
    updated_ms: int  # Unix ms this entry was last written


@dataclass(frozen=True)
class RoomCatalog:
    epoch_ms: int  # E: room time 0 in Unix ms, a multiple of S
    tracks: tuple[CatalogTrack, ...]
    shift: Mapping[int, int] = field(default_factory=dict[int, int])  # teacher clock.wall -> shift in ms
    status: Mapping[str, AgentStatus] = field(default_factory=dict[str, AgentStatus])

    def updated(self, now_ms: int) -> RoomCatalog:
        """The same catalog with every status entry written now."""
        return replace(self, status={name: replace(s, updated_ms=now_ms) for name, s in self.status.items()})

    def to_json(self) -> dict[str, object]:
        if self.epoch_ms % SLICE_MS or any(ms % SLICE_MS for ms in self.shift.values()):
            raise ValueError("the room epoch and every shift must be whole slices")
        return {
            "version": MSF_VERSION,
            "tt": {
                "epoch": self.epoch_ms,
                "shift": {str(wall): ms for wall, ms in self.shift.items()},
                "status": {name: asdict(s) for name, s in self.status.items()},
            },
            "tracks": [_track(t, self.epoch_ms) for t in self.tracks],
        }


def _track(track: CatalogTrack, epoch_ms: int) -> dict[str, object]:
    entry: dict[str, object] = {
        "name": track.name,
        "namespace": track.namespace,
        "packaging": "eventtimeline",
        "mimeType": "application/json",
        "eventType": EVENT_TYPES[track.kind],
    }
    if track.kind in ROLES:
        entry["role"] = ROLES[track.kind]
    entry |= {"lang": track.lang, "label": track.label, "isLive": True}
    if track.kind != "outline":
        entry["template"] = [0, SLICE_MS, [0, 0], [1, 0], epoch_ms, SLICE_MS]
    entry["tt"] = {"dependsOn": list(track.depends_on), "latenessMs": track.lateness_ms, "cost": track.cost}
    return entry


def depends_on(room: str, kind: Kind, captions: Sequence[str]) -> tuple[str, ...]:
    """What a track of ``kind`` is made from: captions (the room's captions tracks), or the speaker's slides."""
    if kind == "slides":
        return (f"{ROOT}/{room}/slides/frames",)
    if kind in ("translation", "outline"):
        return tuple(captions)
    return ()
