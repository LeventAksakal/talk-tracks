import asyncio
from pathlib import Path

import pytest

from talk_tracks import revise
from talk_tracks.contracts import AgentInfo, SlideNote, SlidesState, Usage
from talk_tracks.llm.fake import FakeLlm
from talk_tracks.recording import RecordedSnapshot, RecordingWriter
from talk_tracks.slideshow import Crop, Slide

SLIDES = AgentInfo(name="describe", label="Slides", model="fake")


def write(directory: Path, recorded: list[tuple[AgentInfo, list[RecordedSnapshot]]]) -> Path:
    rec = RecordingWriter(directory, "gen-test", wall_ms=0)
    for info, snapshots in recorded:
        for snap in snapshots:
            rec.add(info, snap.state, snap.usage, media_ms=snap.media_ms, wall_ms=0)
    rec.close(wall_ms=1)
    return directory


def snap(media_ms: int, state: SlidesState) -> RecordedSnapshot:
    return RecordedSnapshot(media_ms=media_ms, wall_ms=0, instance="1", seq=0, usage=Usage(), state=state)


def note(i: int, at_ms: int) -> SlideNote:
    return SlideNote(id=i, at_ms=at_ms, description=f"slide {i}")


def test_redescribe_describes_only_the_slides_without_a_note(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    states = [
        snap(3_000, SlidesState(lang="en", slides=[note(0, 0)])),
        snap(20_000, SlidesState(lang="en", slides=[note(0, 0), note(2, 15_000)])),
    ]
    directory = write(tmp_path, [(SLIDES, states)])
    found = [Slide(0, b"a"), Slide(8_000, b"b"), Slide(15_000, b"c"), Slide(30_000, b"d")]

    def find(media: Path, crop: Crop | None = None) -> list[Slide]:
        return found

    monkeypatch.setattr(revise, "find_slides", find)
    patch = asyncio.run(revise.redescribe(directory, directory / "lecture.mp4", Crop(), FakeLlm()))
    assert [(n.id, n.at_ms) for n in patch.notes] == [(1, 8_000), (3, 30_000)]
    merged = revise.with_patches(directory, revise.read_recording(directory))[0][1]
    assert [s.media_ms for s in merged] == [3_000, 12_000, 20_000, 34_000]
    ids: list[list[int]] = []
    for s in merged:
        assert isinstance(s.state, SlidesState)
        ids.append([n.id for n in s.state.slides])
    assert ids == [[0], [0, 1], [0, 1, 2], [0, 1, 2, 3]]
