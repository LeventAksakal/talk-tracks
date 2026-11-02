"""A demo lecture's live sessions and its recording room (decision 0032, wiki/howto/demo-rooms.md): each session on a
clock of its own that ends for real, the recorded tracks at their agents' real delays, the live-agents switch, and
the recording room built once into the archive."""

import json
import shutil
from pathlib import Path
from typing import Any

import pytest

from talk_tracks import cli
from talk_tracks.archive.bucket import Uploader
from talk_tracks.archive.slices import END_OF_TRACK, SliceObject, TrackArchive
from talk_tracks.contracts import (
    ROOM_TRACK,
    AgentInfo,
    RoomState,
    RoomStateObject,
    RoomStateRecord,
    SlideNote,
    SlidesState,
    Usage,
    catalog_path,
)
from talk_tracks.recording import RecordedSnapshot, RecordingWriter
from talk_tracks.recording_room import record_archive
from talk_tracks.session import (
    GAP_S,
    NOTE_DELAY_FALLBACK_MS,
    RoomStates,
    SessionPlan,
    describe_delay_ms,
    gap_s,
    honest_recording,
    live_agents,
    next_epoch,
    recording_room,
    tail_ms,
)

from .clip import make_clip
from .test_slicing import recording as four_agents

SLIDES = AgentInfo(name="describe", label="Slides", model="fake")
WALL = 1_790_812_801_234  # when the recording was made


def snap(media_ms: int, state: SlidesState) -> RecordedSnapshot:
    return RecordedSnapshot(media_ms=media_ms, wall_ms=0, instance="1", seq=0, usage=Usage(), state=state)


def write(directory: Path, recorded: list[tuple[AgentInfo, list[RecordedSnapshot]]], *, media: str = "") -> Path:
    rec = RecordingWriter(directory, "gen-test", wall_ms=WALL, media=media or None)
    for info, snapshots in recorded:
        for s in snapshots:
            rec.add(info, s.state, s.usage, media_ms=s.media_ms, wall_ms=WALL + s.media_ms)
    rec.close(wall_ms=WALL + 60_000)
    return directory


# --- a session's clock --------------------------------------------------------------------------------------------


def test_a_session_starts_on_a_slice_boundary_and_lasts_the_lecture_at_least() -> None:
    assert next_epoch(8000) == 8000 and next_epoch(8001) == 12_000
    plan = SessionPlan(2, 1_790_812_800_000, 9_000, 12_500)
    assert plan.at(1_790_812_803_000) == 3000  # the player's clock reads 00:03
    assert plan.teacher_section() == {"session": 2, "duration_ms": 9_000, "session_ms": 12_500}
    with pytest.raises(ValueError):
        SessionPlan(0, 1_790_812_801_000, 9_000, 9_000)
    with pytest.raises(ValueError):
        SessionPlan(0, 1_790_812_800_000, 9_000, 8_000)


def test_a_session_lasts_until_its_recorded_tail_is_out_and_no_longer_than_thirty_seconds() -> None:
    recorded = [(SLIDES, [snap(5_000, SlidesState(lang="en", slides=[]))])]
    assert tail_ms(recorded, 0, 9_000) == 0
    assert tail_ms([(SLIDES, [snap(14_000, SlidesState(lang="en", slides=[]))])], 2_000, 9_000) == 3_000
    assert tail_ms([(SLIDES, [snap(99_000, SlidesState(lang="en", slides=[]))])], 0, 9_000) == 30_000


def test_the_room_track_says_on_air_then_ended_and_each_slice_opens_with_its_carry_in() -> None:
    states = RoomStates([RoomStateRecord(m=0, data=RoomState(state="on_air"))])
    states.add(RoomStateRecord(m=9_500, data=RoomState(state="ended")))
    with pytest.raises(ValueError):
        states.add(RoomStateRecord(m=100, data=RoomState(state="on_air")))

    def said(objects: list[bytes]) -> list[list[str]]:
        return [[r.data.state for r in RoomStateObject.model_validate_json(o).root] for o in objects]

    assert said(states.group(0, 0)) == [[], ["on_air"]]
    assert said(states.group(1, 5_000)) == [["on_air"]]  # the carry-in alone
    assert said(states.group(2, 9_000)) == [["on_air"]]  # the end is not out yet
    assert said(states.group(2, 9_500)) == [["on_air"], ["ended"]]  # object 1: what rooms.room_ended reads


# --- the recorded tracks, at their agents' delays ---------------------------------------------------------------


def test_a_patched_slide_note_goes_out_at_the_describe_agents_measured_delay(tmp_path: Path) -> None:
    live = [
        snap(3_000, SlidesState(lang="en", slides=[SlideNote(id=0, at_ms=1_000, description="a")])),
        snap(
            9_000,
            SlidesState(
                lang="en",
                slides=[SlideNote(id=0, at_ms=1_000, description="a"), SlideNote(id=1, at_ms=4_000, description="b")],
            ),
        ),
    ]
    assert describe_delay_ms([(SLIDES, live)]) == 3_500  # the median of 2 s and 5 s
    assert describe_delay_ms([]) == NOTE_DELAY_FALLBACK_MS
    folder = write(tmp_path / "rec", [(SLIDES, live)])
    honest = honest_recording(folder)
    [(_, snapshots)] = honest
    assert [s.media_ms for s in snapshots] == [3_000, 9_000]  # nothing moved earlier than it was published


# --- the switch -------------------------------------------------------------------------------------------------


def test_the_live_agents_switch_is_off_unless_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TT_DEMO_LIVE_AGENTS", raising=False)
    monkeypatch.setenv("TT_DEMO_ROOMS", "virus,rsa")
    assert not live_agents()
    assert cli.room_exclusions("virus,rsa,secret") == ["virus", "rsa", "secret"]
    monkeypatch.setenv("TT_DEMO_LIVE_AGENTS", "1")
    assert live_agents()
    assert cli.room_exclusions("virus,rsa,secret") == ["secret"]  # the live agents serve the demo rooms
    assert cli.demo_room("virus") and not cli.demo_room("secret")  # served session by session either way
    monkeypatch.setenv("TT_DEMO_LIVE_AGENTS", "off")
    assert not live_agents()
    monkeypatch.delenv("TT_DEMO_SESSION_GAP_S", raising=False)
    assert gap_s() == GAP_S
    monkeypatch.setenv("TT_DEMO_SESSION_GAP_S", "5")
    assert gap_s() == 5.0


def test_a_new_session_clears_the_last_ones_slices_once(tmp_path: Path) -> None:
    track = TrackArchive("virus", "captions", "items", root=tmp_path)
    track.create(0, [SliceObject(0, b"carry")])
    track.create(7, [SliceObject(0, b"carry")])
    assert track.start_session(1_790_812_800_000)  # the first session this agent sees: whatever was there goes
    assert track.latest_group() is None
    track.create(0, [SliceObject(0, b"new")])
    assert not track.start_session(1_790_812_800_000)  # restarted in the same session: its slices stay
    assert track.latest_group() == 0
    assert track.start_session(1_790_812_900_000)
    assert track.groups() == []


def test_a_skipped_rooms_files_never_reach_the_bucket(tmp_path: Path) -> None:
    from talk_tracks.archive.store import RoomFilter

    uploader = Uploader(tmp_path, object(), rooms=RoomFilter("*", "virus,*-recording"))  # type: ignore[arg-type]
    for path in ("virus/agents/captions/items/00000000.slice", "rsa-recording/room.json", "rooms.json", "x/room.json"):
        uploader.notify(path, mutable=False)
    assert uploader.pending == 2  # rooms.json and the room not skipped


# --- the recording room ---------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def lecture(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_clip(tmp_path_factory.mktemp("clip") / "lecture.mp4")


def test_the_recording_room_is_an_ended_archived_room_with_recorded_tracks(tmp_path: Path, lecture: Path) -> None:
    folder = write(tmp_path / "demo" / "virus", four_agents(), media="lecture.mp4")
    shutil.copyfile(lecture, folder / "lecture.mp4")
    root = tmp_path / "archive"
    assert recording_room("virus") == "virus-recording"

    built = record_archive(folder, "virus-recording", root)

    epoch = WALL // 4000 * 4000
    assert built.epoch_ms == epoch and built.end_ms == 30_000  # the lecture (2 s) and its agents' last words
    index = json.loads((root / "virus-recording" / "room.json").read_text(encoding="utf-8"))
    assert index["epoch_ms"] == epoch and len(index["runs"]) == 1 and index["runs"][0]["shift_ms"] == 0
    rooms = json.loads((root / "rooms.json").read_text(encoding="utf-8"))
    assert [r["room"] for r in rooms["rooms"]] == ["virus-recording"]
    assert (root / "virus-recording" / "index.m3u8").exists()
    playlists = [p.read_text(encoding="utf-8") for p in (root / "virus-recording").glob("*.m3u8")]
    assert any("#EXT-X-ENDLIST" in text for text in playlists)  # an ended room, seekable
    infos: dict[str, Any] = {}
    for info in (root / "virus-recording" / "agents").glob("*/*/track.json"):
        infos[info.parent.parent.name] = json.loads(info.read_text(encoding="utf-8"))
    assert set(infos) == {"captions", "translate-tr", "describe", "chapters"}
    assert all(i["label"].endswith(" (recorded)") and i["cost"] == "free" for i in infos.values())
    assert all(i["status"] == "idle" and not i["producing"] for i in infos.values())
    assert built.tracks["captions/items"] == 8  # 30 s in 4 s slices
    captions = TrackArchive("virus-recording", "captions", "items", root=root)
    last = captions.read_local(7)
    assert last is not None and last.objects[-1].status == END_OF_TRACK
    states = TrackArchive.of(catalog_path("virus-recording"), ROOM_TRACK, root=root)
    end = states.read_local(states.latest_group() or 0)
    assert end is not None and end.end_of_track
    said = [r.data.state for o in end.objects[1:-1] for r in RoomStateObject.model_validate_json(o.payload).root]
    assert said == ["ended"]
    assert not list((root / "virus-recording").rglob("*.jpg"))  # no slide on disk (ticket 0001)

    with pytest.raises(FileExistsError):  # built once
        record_archive(folder, "virus-recording", root)
