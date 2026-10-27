"""Replaying a recording as a looping live room: the schedule, and what changes at each loop restart. Transport-free.

The looper plays the lecture and the recorded agent tracks on one clock, the lecture's own time (file time, ms).
Loop ``k`` plays file time ``t`` at media time ``k * duration + t``: the teacher broadcast's media time keeps rising
across restarts, so neither the browser player nor the agents' audio reader ever sees the clock jump back.

At each restart every agent track starts over as a *new instance*, exactly as if the agent had been restarted:

* the instance name is the wall-clock ms at the restart (always larger than the last one), so a viewer that follows
  the newest instance switches by itself and the previous loop's instance is withdrawn;
* the sequence number starts again at 1 (it belongs to the instance);
* every media time inside a state is moved by ``k * duration``, so a caption's ``start_ms`` still matches the
  broadcast's media time;
* every id (caption line, translated line, slide, chapter) is moved by ``k * stride``, where ``stride`` is one more
  than the largest id in the recording, so ids never repeat in a room's life: a viewer that keeps scrollback keyed
  by line id never mixes two loops' lines.
"""

from __future__ import annotations

import heapq
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

from .audio import read_varint
from .contracts import (
    CaptionsState,
    OutlineState,
    SlidesState,
    State,
    TranslationState,
)
from .lecture import MediaPacket
from .recording import RecordedAgent, RecordedSnapshot, Recording, read_snapshots


class MediaClock:
    """The speaker's media time, read from the teacher audio track (legacy container: a varint of microseconds first).

    Keeps the newest time seen; ``ms`` is 0 until the first object.
    """

    def __init__(self) -> None:
        self.us: int | None = None

    def observe(self, payload: bytes) -> int | None:
        if not payload:
            return None
        us, _ = read_varint(payload)
        if self.us is None or us > self.us:
            self.us = us
        return us

    @property
    def ms(self) -> int:
        return 0 if self.us is None else self.us // 1000


def max_id(state: State) -> int:
    if isinstance(state, CaptionsState | TranslationState):
        ids = [line.id for line in state.lines]
    elif isinstance(state, SlidesState):
        ids = [slide.id for slide in state.slides]
    else:
        ids = [chapter.id for chapter in state.chapters]
    return max(ids, default=-1)


def id_stride(snapshots: Iterable[RecordedSnapshot]) -> int:
    """One more than the largest id anywhere in the recording (at least 1)."""
    return max((max_id(s.state) for s in snapshots), default=-1) + 1 or 1


def shift_state(state: State, *, media_ms: int, ids: int) -> State:
    """The same state with every media time moved by ``media_ms`` and every id by ``ids``."""
    if media_ms == 0 and ids == 0:
        return state
    if isinstance(state, CaptionsState):
        lines = [
            line.model_copy(
                update={"id": line.id + ids, "start_ms": line.start_ms + media_ms, "end_ms": line.end_ms + media_ms}
            )
            for line in state.lines
        ]
        return state.model_copy(update={"lines": lines})
    if isinstance(state, TranslationState):
        return state.model_copy(
            update={"lines": [line.model_copy(update={"id": line.id + ids}) for line in state.lines]}
        )
    if isinstance(state, SlidesState):
        slides = [s.model_copy(update={"id": s.id + ids, "at_ms": s.at_ms + media_ms}) for s in state.slides]
        return state.model_copy(update={"slides": slides})
    assert isinstance(state, OutlineState)
    chapters = [c.model_copy(update={"id": c.id + ids, "start_ms": c.start_ms + media_ms}) for c in state.chapters]
    return state.model_copy(update={"chapters": chapters})


@dataclass(frozen=True)
class Cue:
    """Publish ``snapshot`` (already shifted for its loop) on ``agent``'s track when the lecture reaches ``at_ms``."""

    at_ms: int
    agent: RecordedAgent
    snapshot: RecordedSnapshot


@dataclass(frozen=True)
class LoopPlan:
    """Where loop ``index`` sits on the room's media clock and in id space."""

    index: int
    duration_ms: int
    stride: int

    @property
    def media_offset_ms(self) -> int:
        return self.index * self.duration_ms

    @property
    def id_offset(self) -> int:
        return self.index * self.stride

    def media_us(self, file_us: int) -> int:
        """Media time (µs) of a lecture frame at ``file_us``."""
        return self.media_offset_ms * 1000 + file_us


class Timeline:
    """A recording's cues, loop after loop, in lecture-time order across agents.

    Snapshots stamped before the lecture start play at 0 and those stamped after its end play at the end, so every
    loop shows each track's whole story. ``origin_ms`` is the recording media time of lecture time 0.
    """

    def __init__(self, directory: Path, manifest: Recording, duration_ms: int, *, origin_ms: int = 0) -> None:
        if duration_ms <= 0:
            raise ValueError("the lecture must have a positive duration")
        self.directory = directory
        self.manifest = manifest
        self.duration_ms = duration_ms
        self.origin_ms = origin_ms
        self.stride = id_stride(s for agent in manifest.agents for s in read_snapshots(directory, agent))

    def plan(self, index: int) -> LoopPlan:
        return LoopPlan(index, self.duration_ms, self.stride)

    def at_ms(self, snapshot: RecordedSnapshot) -> int:
        return min(max(snapshot.media_ms - self.origin_ms, 0), self.duration_ms)

    def cues(self, plan: LoopPlan) -> Iterator[Cue]:
        """This loop's cues in lecture-time order (stable per agent), read lazily from the recording."""

        def agent_cues(order: int, agent: RecordedAgent) -> Iterator[tuple[int, int, int, Cue]]:
            for n, snapshot in enumerate(read_snapshots(self.directory, agent)):
                at = self.at_ms(snapshot)
                state = shift_state(snapshot.state, media_ms=plan.media_offset_ms - self.origin_ms, ids=plan.id_offset)
                yield at, order, n, Cue(at, agent, snapshot.model_copy(update={"state": state}))

        streams = [agent_cues(order, agent) for order, agent in enumerate(self.manifest.agents)]
        for _, _, _, cue in heapq.merge(*streams, key=lambda item: item[:3]):
            yield cue


def next_instance(previous: str | None, now_ms: int) -> str:
    """A fresh instance name: the wall clock in ms, but always above the previous one (two restarts in one ms)."""
    floor = int(previous) + 1 if previous is not None and previous.isdigit() else 0
    return str(max(now_ms, floor))


Event = MediaPacket | Cue


def event_us(event: Event) -> int:
    """Lecture time of an event in µs."""
    return event.file_us if isinstance(event, MediaPacket) else event.at_ms * 1000


def loop_events(media: Iterable[MediaPacket], cues: Iterable[Cue]) -> Iterator[Event]:
    """One loop's media packets and cues on one lecture clock. A cue goes before media of the same instant, so a
    track's state is out before the frame it belongs to."""
    tagged_cues = ((cue.at_ms * 1000, 0, n, cue) for n, cue in enumerate(cues))
    tagged_media = ((packet.file_us, 1, n, packet) for n, packet in enumerate(media))
    for *_, event in heapq.merge(tagged_cues, tagged_media, key=lambda item: item[:3]):
        yield event
