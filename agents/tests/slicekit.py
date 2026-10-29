"""Test doubles for sliced tracks: a live output that records what it was given, and tracks on a still clock."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from pathlib import Path

from talk_tracks.archive.slices import Slice, TrackArchive
from talk_tracks.contracts import AgentInfo, CarryNote, Cue
from talk_tracks.live_slices import SlicedTrack, SnapshotTrack, Watermark, payloads
from talk_tracks.records import Data, cues_of


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

    def payloads(self, group: int | None = None) -> list[bytes]:
        return [p for g, _, p in self.objects if group is None or g == group]

    def groups(self) -> list[int]:
        return sorted({g for g, _, _ in self.objects})


def still_clock(edge: Callable[[], int | None] = lambda: None) -> Watermark:
    """A watermark that never goes stale: room time is exactly what the inputs last said."""
    return Watermark(hold_s=float("inf"), edge=edge, clock=lambda: 0.0)


def archive(tmp_path: Path, agent: str = "captions", track: str = "items") -> TrackArchive:
    return TrackArchive("room-1", agent, track, root=tmp_path / "archive")


def sliced(
    tmp_path: Path,
    name: str = "captions",
    out: ListOut | None = None,
    carry: Callable[[], Sequence[Data]] = list,
    *,
    marks_from: bool = False,
) -> tuple[SlicedTrack, ListOut]:
    out = out or ListOut()
    track = SlicedTrack(
        AgentInfo(name=name, label=name, model="fake"),
        out,
        archive(tmp_path, name),
        carry,
        clock=still_clock(),
        marks_from=marks_from,
    )
    return track, out


def snapshot_track(tmp_path: Path, out: ListOut | None = None) -> tuple[SnapshotTrack, ListOut]:
    out = out or ListOut()
    track = SnapshotTrack(
        AgentInfo(name="chapters", label="chapters", model="fake"),
        out,
        archive(tmp_path, "chapters", "outline"),
        clock=still_clock(),
    )
    return track, out


def objects(found: Slice | list[bytes]) -> list[tuple[CarryNote | None, list[Cue]]]:
    """Each object of a cue slice: its note and cues."""
    return [cues_of(p) for p in (found if isinstance(found, list) else payloads(found))]
