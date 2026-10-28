"""Test doubles for sliced tracks: a live output that records what it was given, and tracks on a still clock."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from talk_tracks.archive.slices import TrackArchive
from talk_tracks.contracts import ENVELOPE, AgentInfo, CaptionsCarry, Carry, Envelope, Usage
from talk_tracks.live_slices import MediaClock, SlicedTrack, SnapshotTrack
from talk_tracks.llm.fake import FakeLlm


class ListOut:
    """``live_slices.LiveOut`` into lists: (group, object, payload), and the groups closed in order."""

    def __init__(self, subscribed: bool = True) -> None:
        self.objects: list[tuple[int, int, bytes]] = []
        self.ended: list[int] = []
        self.track_ended = False
        self.on = subscribed

    def subscribed(self) -> bool:
        return self.on

    async def put(self, group: int, object_id: int, payload: bytes) -> None:
        self.objects.append((group, object_id, payload))

    async def end_group(self, group: int) -> None:
        self.ended.append(group)

    async def end_track(self) -> None:
        self.track_ended = True

    def envelopes(self, group: int | None = None) -> list[Envelope]:
        return [ENVELOPE.validate_json(p) for g, _, p in self.objects if group is None or g == group]

    def groups(self) -> list[int]:
        return sorted({g for g, _, _ in self.objects})


def still_clock() -> MediaClock:
    """Media time is exactly what the inputs last said: no wall clock running on between them."""
    return MediaClock(hold_s=None, clock=lambda: 0.0)


def archive(tmp_path: Path, agent: str = "captions", track: str = "items") -> TrackArchive:
    return TrackArchive("room-1", agent, track, root=tmp_path / "archive")


def sliced(
    tmp_path: Path,
    name: str = "captions",
    out: ListOut | None = None,
    llm: FakeLlm | None = None,
    carry: Any = None,
) -> tuple[SlicedTrack, ListOut]:
    out = out or ListOut()
    empty: Carry = CaptionsCarry(lang="en", lines=[])
    track = SlicedTrack(
        AgentInfo(name=name, label=name, model="fake"),
        out,
        archive(tmp_path, name),
        (lambda: llm.usage) if llm else Usage,
        carry or (lambda: empty),
        clock=still_clock(),
        wall_ms=lambda: 1,
    )
    return track, out


def snapshot_track(tmp_path: Path, out: ListOut | None = None) -> tuple[SnapshotTrack, ListOut]:
    out = out or ListOut()
    track = SnapshotTrack(
        AgentInfo(name="chapters", label="chapters", model="fake"),
        out,
        archive(tmp_path, "chapters", "outline"),
        Usage,
        clock=still_clock(),
        wall_ms=lambda: 1,
    )
    return track, out
