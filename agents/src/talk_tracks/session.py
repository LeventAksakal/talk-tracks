"""A demo lecture's live sessions and its recording room (decision 0032). Transport-free.

Each demo lecture is two rooms:

* **The live session**, ``talk/<id>``: the lecture plays once from 00:00 on a room clock of its own (``E`` is the
  session's start, so the player's clock reads 00:00), then the session ends with the room's real end state (the
  ``room`` track says ``ended``) and every broadcast of it is withdrawn. After a gap (``TT_DEMO_SESSION_GAP_S``,
  default 30 s) a new session starts from 00:00 under a new ``E``: nothing wraps inside one timeline.
* **The recording**, ``<id>-recording``: the whole lecture as an archived, ended room (``recording_room``), seekable,
  its AI tracks labelled as recorded.

Where a live session's AI tracks come from is one switch, ``TT_DEMO_LIVE_AGENTS`` (``live_agents``):

* **on:** only from the live agents, which serve the session like any room a speaker opens, on its real audio, each
  room capped by the spend ledger. The session player then never reads the recording's agent snapshots: it plays the
  lecture and its slides, as a speaker would, and nothing else;
* **off (the default):** the recording's tracks, each item at the time its agent published it when it was recorded
  (``honest_recording``): a translation when the whole line's translation came back, a slide note when its model
  answered. Nothing goes out with or ahead of the speech it belongs to.
"""

from __future__ import annotations

import logging
import os
import statistics
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from .contracts import SLICE_MS, AgentInfo, RoomStateObject, RoomStateRecord, SlidesState
from .recording import RecordedSnapshot
from .resegment import resegment
from .revise import read_recording, translations_by_agent, with_patches

log = logging.getLogger("talk_tracks.session")

LIVE_AGENTS_ENV = "TT_DEMO_LIVE_AGENTS"
GAP_ENV = "TT_DEMO_SESSION_GAP_S"
GAP_S = 30.0  # between a session's end and the next one's start
TAIL_MAX_MS = 30_000  # recorded items after the lecture's end still go out, up to this long after it
NOTE_DELAY_FALLBACK_MS = 10_000  # a patched slide note's delay when the recording has no live note to measure
RECORDING_SUFFIX = "-recording"  # the recording room's labels end in ``slicing.RECORDED``

Recorded = list[tuple[AgentInfo, list[RecordedSnapshot]]]


def live_agents() -> bool:
    """The switch: a live session's AI tracks come only from live agents."""
    return os.environ.get(LIVE_AGENTS_ENV, "").strip().lower() in ("1", "true", "yes", "on")


def gap_s() -> float:
    raw = os.environ.get(GAP_ENV, "").strip()
    return float(raw) if raw else GAP_S


def recording_room(lecture: str) -> str:
    """The recording room of a demo lecture's live room: ``<id>-recording``."""
    return f"{lecture}{RECORDING_SUFFIX}"


# --- timing -------------------------------------------------------------------------------------------------------


def next_epoch(now_ms: int) -> int:
    """A session's ``E``: the next slice boundary on the wall clock (the catalog's E is a whole number of slices)."""
    return -(-now_ms // SLICE_MS) * SLICE_MS


@dataclass(frozen=True)
class SessionPlan:
    """One live session on its own room clock: session time t is wall time ``epoch_ms + t``, media time t."""

    number: int  # sessions this player has started, from 0 (the teacher catalog says it)
    epoch_ms: int
    lecture_ms: int
    end_ms: int  # when the session ends: the lecture, plus the recorded tracks' tail

    def __post_init__(self) -> None:
        if self.epoch_ms % SLICE_MS:
            raise ValueError("a session starts on a slice boundary")
        if self.end_ms < self.lecture_ms:
            raise ValueError("a session lasts the lecture at least")

    def at(self, wall_ms: int) -> int:
        """Session time at wall time ``wall_ms``."""
        return wall_ms - self.epoch_ms

    def teacher_section(self) -> dict[str, object]:
        """The teacher's hang catalog section: which session, and how long the lecture and the session are."""
        return {"session": self.number, "duration_ms": self.lecture_ms, "session_ms": self.end_ms}


def tail_ms(recorded: Sequence[tuple[AgentInfo, Sequence[RecordedSnapshot]]], origin_ms: int, lecture_ms: int) -> int:
    """How long after the lecture's end the recording's last item went out (its agents' last words), at most
    ``TAIL_MAX_MS``: the session lasts that much longer, so no item is moved earlier to fit."""
    last = max((s.media_ms - origin_ms for _, snaps in recorded for s in snaps), default=0)
    return max(0, min(TAIL_MAX_MS, last - lecture_ms))


# --- the recording's tracks at their recorded delay ---------------------------------------------------------------


def describe_delay_ms(recorded: Sequence[tuple[AgentInfo, Sequence[RecordedSnapshot]]]) -> int:
    """The describe agent's real delay in the recording: the median time from a slide's appearance to the first
    snapshot that carried its note. A note patched in later (``redescribe``) goes out that long after its slide."""
    delays: list[int] = []
    for _, snapshots in recorded:
        if not snapshots or not isinstance(snapshots[0].state, SlidesState):
            continue
        seen: set[int] = set()
        for snap in snapshots:
            assert isinstance(snap.state, SlidesState)
            for note in snap.state.slides:
                if note.id not in seen:
                    seen.add(note.id)
                    delays.append(max(0, snap.media_ms - note.at_ms))
    return int(statistics.median(delays)) if delays else NOTE_DELAY_FALLBACK_MS


def honest_recording(recording: Path) -> Recorded:
    """A recording's tracks as a live session or the recording room shows them: caption lines cut into subtitle
    cues at sentences and clauses (``resegment``), each translation split over its cues at the time the translation
    agent published it, and any patched slide note at the describe agent's measured delay."""
    recorded = read_recording(recording)
    delay = describe_delay_ms(recorded)
    patched = with_patches(recording, recorded, delay_ms=delay)
    return resegment(patched, translations_by_agent(recording, patched))


# --- the room track of a session ------------------------------------------------------------------------------------


@dataclass
class RoomStates:
    """A session's ``room`` track (``talk/<room>/catalog`` track ``room``, ``RoomStateObject``): sliced on session
    time like the room service's, object 0 of each slice the carry-in (the last record before it), then the records
    in it. ``on_air`` at 00:00, ``ended`` when the session ends: the real end state, which the live agents and the
    player read."""

    records: list[RoomStateRecord]

    def add(self, record: RoomStateRecord) -> None:
        if self.records and record.m < self.records[-1].m:
            raise ValueError("room states are in time order")
        self.records.append(record)

    def group(self, k: int, now_ms: int) -> list[bytes]:
        """The objects of slice ``k`` out by session time ``now_ms``."""
        start = k * SLICE_MS
        before = [r for r in self.records if r.m < start]
        inside = [r for r in self.records if start <= r.m < start + SLICE_MS and r.m <= now_ms]
        carry = RoomStateObject(before[-1:]).model_dump_json().encode()
        return [carry, *(RoomStateObject([r]).model_dump_json().encode() for r in inside)]
