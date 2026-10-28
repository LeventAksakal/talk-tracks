from pathlib import Path

from talk_tracks.audio import write_varint
from talk_tracks.contracts import (
    AgentInfo,
    CaptionLine,
    CaptionsState,
    State,
    TranslatedLine,
    TranslationState,
    Usage,
)
from talk_tracks.recording import RecordingWriter, load_manifest, read_snapshots
from talk_tracks.replay import EPOCH_MS, LoopPlan, MediaClock, position

CAPTIONS = AgentInfo(name="captions", label="Captions (English)", model="fake")
TRANSLATE = AgentInfo(name="translate-tr", label="Turkish translation", model="fake")


def add(rec: RecordingWriter, info: AgentInfo, state: State, *, media_ms: int, wall_ms: int, cost: float = 0.0):
    return rec.add(info, state, Usage(cost_usd=cost), media_ms=media_ms, wall_ms=wall_ms)


def captions(*ids: int) -> CaptionsState:
    return CaptionsState(
        lang="en", lines=[CaptionLine(id=i, start_ms=i * 1000, end_ms=i * 1000 + 900, text=f"line {i}") for i in ids]
    )


def record(tmp_path: Path) -> Path:
    rec = RecordingWriter(tmp_path, "loop-gen", wall_ms=5, media="lecture.mp4")
    add(rec, CAPTIONS, captions(), media_ms=0, wall_ms=10)
    add(rec, TRANSLATE, TranslationState(lang="tr", lines=[]), media_ms=0, wall_ms=11)
    add(rec, CAPTIONS, captions(0), media_ms=1000, wall_ms=1010)
    add(
        rec,
        TRANSLATE,
        TranslationState(lang="tr", lines=[TranslatedLine(id=0, text="satir 0")]),
        media_ms=1200,
        wall_ms=1210,
    )
    add(rec, CAPTIONS, captions(0, 1), media_ms=2000, wall_ms=2010, cost=0.5)
    add(rec, CAPTIONS, captions(0, 1, 2), media_ms=9000, wall_ms=9010)  # after the lecture ended
    rec.close(wall_ms=9100)
    return tmp_path


def test_recording_round_trips_with_a_manifest(tmp_path: Path) -> None:
    directory = record(tmp_path)
    manifest = load_manifest(directory)
    assert manifest.room == "loop-gen" and manifest.media == "lecture.mp4" and manifest.ended_wall_ms == 9100
    by_name = {a.info.name: a for a in manifest.agents}
    assert by_name["captions"].snapshots == 4 and by_name["captions"].last_media_ms == 9000
    assert [s.seq for s in read_snapshots(directory, by_name["captions"])] == [1, 2, 3, 4]  # numbered per agent
    assert manifest.room_origin_ms is None  # the speaker's media clock
    assert [s.usage.cost_usd for s in read_snapshots(directory, by_name["captions"])][-2] == 0.5


def test_media_time_never_goes_back_within_an_agent(tmp_path: Path) -> None:
    rec = RecordingWriter(tmp_path, "loop-gen", wall_ms=0)
    add(rec, CAPTIONS, captions(), media_ms=5000, wall_ms=1)
    snapshot = add(rec, CAPTIONS, captions(0), media_ms=10, wall_ms=2)  # the speaker's clock restarted
    assert snapshot.media_ms == 5000


def test_a_recording_on_the_room_clock_keeps_its_first_origin(tmp_path: Path) -> None:
    rec = RecordingWriter(tmp_path, "loop-gen", wall_ms=0)
    rec.room_origin(8000)
    rec.room_origin(12_000)  # later catalogs change nothing: the recording keeps one clock
    add(rec, CAPTIONS, captions(), media_ms=8000, wall_ms=1)
    rec.close(wall_ms=2)
    assert load_manifest(tmp_path).room_origin_ms == 8000


def test_media_clock_reads_the_legacy_timestamp_and_keeps_the_newest() -> None:
    clock = MediaClock()
    assert clock.ms == 0
    clock.observe(write_varint(2_000_000) + b"x")
    clock.observe(write_varint(1_980_000) + b"x")  # reordered group
    assert clock.ms == 2000
    assert clock.observe(b"") is None
    clock.observe(write_varint(400_000_000) + b"x")
    clock.observe(write_varint(20_000) + b"x")  # the looper or the speaker's browser restarted
    assert clock.ms == 20


def test_loops_sit_on_the_room_clock() -> None:
    assert EPOCH_MS == 1_790_812_800_000  # 2026-10-01 00:00 UTC
    plan = LoopPlan(index=3, period_ms=8000, stride=5)
    assert (plan.media_offset_ms, plan.id_offset, plan.media_us(1_000)) == (24_000, 15, 24_001_000)
    assert position(25_500, 8000) == (3, 1500)
    assert position(-5, 8000) == (0, 0)
