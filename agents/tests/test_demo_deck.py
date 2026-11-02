# pyright: reportMissingImports=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportPrivateUsage=false
"""A looped room's deck stays one group on the wire, whatever its size (wiki/howto/demo-rooms.md, "Slides in the
player").

The looper writes the deck once at start, while nobody subscribes, through aiomoqt's push writer. A writer queue
smaller than the deck dropped its first objects and started new groups for the rest, so the track's Largest Location
ran ahead of the one deck group: the relay's joining FETCH for a viewer asked for a group that does not exist, the
deck never came on the live subscription, and the player's FETCH of group 0 is cut by moq-relay 0.17.8 for a group
that large (34 slides on /watch/dataviz). Needs aiomoqt's real writer, which has no Windows wheels: run it in the
agents image (wiki/howto/run-locally.md).
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import numpy as np
import pytest

pytest.importorskip("aiomoqt.agent.writer")

from aiomoqt.agent.spec import PublishSpec, TrackRef
from aiomoqt.agent.writer import Writer, WriteStats

from talk_tracks.archive.slices import SliceObject, TrackArchive
from talk_tracks.demo import SpeakerSlides, _serve_archived
from talk_tracks.demo_slides import DECK_GROUP, LectureSlides
from talk_tracks.moq import TrackWriter
from talk_tracks.slideshow import Slide, jpeg


class StubTrack:
    """What ComputedTrack touches of aiomoqt's published track; nobody subscribes."""

    def __init__(self) -> None:
        self._history: Any = None
        self._largest: tuple[int, int] | None = None

    def _fetch_range(self, *_args: Any) -> Any:
        raise AssertionError("no FETCH here")

    async def _on_subscribe(self, *_args: Any) -> None:
        raise AssertionError("no SUBSCRIBE here")

    def _note_largest(self, group: int, obj: int) -> None:
        if self._largest is None or (group, obj) > self._largest:
            self._largest = (group, obj)


class StubRelay:
    """Publishes through aiomoqt's real Writer (its queue and drop policy), on stub tracks."""

    def __init__(self) -> None:
        self.writers: dict[tuple[str, str], Writer] = {}

    async def publish(self, namespace: str, track: str, *, queue: int = 4) -> TrackWriter:
        spec = PublishSpec(track=TrackRef(namespace=namespace, name=track), buffer=queue, on_full="drop_oldest")
        writer = Writer(spec, StubTrack(), asyncio.Queue(maxsize=spec.buffer), WriteStats())  # type: ignore[arg-type]
        self.writers[(namespace, track)] = writer
        return TrackWriter(writer)


def picture(shade: int) -> bytes:
    return jpeg(np.full((90, 160, 3), shade, dtype=np.uint8))


def test_a_deck_written_before_anyone_subscribes_is_one_whole_group() -> None:
    slides = [Slide(i * 3_000, picture(20 + 7 * i)) for i in range(34)]  # dataviz's deck size
    source = LectureSlides.of(slides, 120_000)
    relay = StubRelay()
    asyncio.run(SpeakerSlides(relay, "dataviz", source, lambda: 0).start())  # type: ignore[arg-type]

    for ns in ("talk/dataviz/slides", "talk/dataviz/archive/slides"):
        writer = relay.writers[(ns, "deck")]
        queued = [writer._queue.get_nowait()[:2] for _ in range(writer._queue.qsize())]
        assert writer.group == DECK_GROUP
        assert queued == [(DECK_GROUP, i) for i in range(len(source.deck))]


def test_a_recording_rooms_last_slice_written_before_anyone_subscribes_is_one_whole_group(tmp_path: Path) -> None:
    """serve-recording writes each archived track's last slice live at start, so Largest covers the room; a slice
    longer than the default queue (a caption tail with its interims) stays one group, at its own number."""
    archive = TrackArchive("virus-recording", "captions", "items", root=tmp_path)
    archive.create(0, [SliceObject(0, b"carry")])
    archive.create(7, [SliceObject(i, f"item {i}".encode()) for i in range(10)], end_of_track=True)
    relay = StubRelay()
    newest = asyncio.run(_serve_archived(relay, "talk/virus-recording/agents/captions", archive))  # type: ignore[arg-type]

    writer = relay.writers[("talk/virus-recording/agents/captions", "items")]
    queued = [writer._queue.get_nowait()[:2] for _ in range(writer._queue.qsize())]
    assert newest == 7 and writer.group == 7
    assert queued == [(7, i) for i in range(10)]  # the End of Track marker is not an object on the wire
    assert writer._track._largest == (7, 9)
