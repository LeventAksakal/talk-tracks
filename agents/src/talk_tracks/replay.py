"""Replaying a recording as a looping live room: the room clock, the loops on it, and the schedule. Transport-free.

The room clock is wall-clock time since ``EPOCH_MS``: media time m happens at wall time ``EPOCH_MS + m``. Loop k
covers media time [k·period, (k+1)·period), where the period is the lecture rounded up to whole 4 s slices, so a
loop always starts a slice. Within loop k, file time t of the lecture plays at media time ``k·period + t``.

Anchoring loops to the wall clock gives a looper that restarts (a deploy, a crash) the same room it left: it joins the
loop in progress at the same position, and every group number, id and media time it publishes is the one its
predecessor published or would have. Nothing repeats in the room's life (decision 0012: group numbers come from the
media clock), and the teacher broadcast's media time only ever rises, so neither the browser player nor an agent's
audio reader sees the clock jump back. Each loop moves ids by k·stride (``slicing.Template``), so a viewer that keeps
scrollback keyed by line id never mixes two loops' lines.
"""

from __future__ import annotations

import heapq
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime

from .audio import MAX_FILL_US, read_varint
from .lecture import MediaPacket

EPOCH_MS = int(datetime(2026, 10, 1, tzinfo=UTC).timestamp() * 1000)  # media time 0 of every looped room


class MediaClock:
    """The speaker's media time, read from the teacher audio track (legacy container: a varint of microseconds first).

    Keeps the newest time seen (groups may arrive a little out of order); a time far behind it means the speaker's
    publisher restarted its clock, and the clock follows. ``ms`` is 0 until the first object.
    """

    def __init__(self) -> None:
        self.us: int | None = None

    def observe(self, payload: bytes) -> int | None:
        if not payload:
            return None
        us, _ = read_varint(payload)
        if self.us is None or us > self.us or us < self.us - MAX_FILL_US:
            self.us = us
        return us

    @property
    def ms(self) -> int:
        return 0 if self.us is None else self.us // 1000


@dataclass(frozen=True)
class LoopPlan:
    """Where loop ``index`` sits on the room's media clock and in id space."""

    index: int
    period_ms: int
    stride: int

    @property
    def media_offset_ms(self) -> int:
        return self.index * self.period_ms

    @property
    def id_offset(self) -> int:
        return self.index * self.stride

    def media_us(self, file_us: int) -> int:
        """Media time (µs) of a lecture frame at ``file_us``."""
        return self.media_offset_ms * 1000 + file_us


def position(media_ms: int, period_ms: int) -> tuple[int, int]:
    """(loop, file time in ms) at room media time ``media_ms``."""
    return divmod(max(0, media_ms), period_ms)


@dataclass(frozen=True)
class Cue:
    """Publish object ``index`` of ``group`` on ``agent``'s track when the lecture reaches ``at_ms`` (file time).
    Object 0 opens the group."""

    at_ms: int
    agent: str
    group: int
    index: int


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
