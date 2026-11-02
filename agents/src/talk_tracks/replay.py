"""Replaying a recording as a demo lecture's live session: the speaker's media clock and the schedule. Transport-free.

A live session (``session``, decision 0032) plays the lecture once on a room clock of its own: media time t is
session time t, at wall time ``E + t``, where ``E`` is the session's start. Its schedule is the lecture's media
packets and the recording's agent objects (``Cue``) merged on that one clock (``session_events``). The next session
has a new ``E``, so every group number, id and media time starts again from 0 on freshly announced broadcasts.
"""

from __future__ import annotations

import heapq
from collections.abc import Iterable, Iterator
from dataclasses import dataclass

from .audio import MAX_FILL_US, read_varint
from .lecture import MediaPacket


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
class Cue:
    """Publish object ``index`` of ``group`` on ``agent``'s track when the session reaches ``at_ms``. Object 0 opens
    the group."""

    at_ms: int
    agent: str
    group: int
    index: int


Event = MediaPacket | Cue


def event_us(event: Event) -> int:
    """Session time of an event in µs."""
    return event.file_us if isinstance(event, MediaPacket) else event.at_ms * 1000


def session_events(media: Iterable[MediaPacket], cues: Iterable[Cue]) -> Iterator[Event]:
    """A session's media packets and cues on one clock. A cue goes before media of the same instant, so a track's
    state is out before the frame it belongs to."""
    tagged_cues = ((cue.at_ms * 1000, 0, n, cue) for n, cue in enumerate(cues))
    tagged_media = ((packet.file_us, 1, n, packet) for n, packet in enumerate(media))
    for *_, event in heapq.merge(tagged_cues, tagged_media, key=lambda item: item[:3]):
        yield event
