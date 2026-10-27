from pathlib import Path

from talk_tracks.audio import write_varint
from talk_tracks.contracts import (
    AgentInfo,
    CaptionLine,
    CaptionsState,
    Chapter,
    Envelope,
    OutlineState,
    SlideNote,
    SlidesState,
    State,
    TranslatedLine,
    TranslationState,
    Usage,
)
from talk_tracks.recording import RecordingWriter, load_manifest, read_snapshots
from talk_tracks.replay import MediaClock, Timeline, id_stride, next_instance, shift_state

CAPTIONS = AgentInfo(name="captions", label="Captions (English)", model="fake")
TRANSLATE = AgentInfo(name="translate-tr", label="Turkish translation", model="fake")


def env(info: AgentInfo, seq: int, state: State, *, instance: str = "1000", cost: float = 0.0) -> Envelope:
    return Envelope(agent=info, instance=instance, seq=seq, at_ms=1, usage=Usage(cost_usd=cost), state=state)


def captions(*ids: int) -> CaptionsState:
    return CaptionsState(
        lang="en", lines=[CaptionLine(id=i, start_ms=i * 1000, end_ms=i * 1000 + 900, text=f"line {i}") for i in ids]
    )


def record(tmp_path: Path) -> Path:
    rec = RecordingWriter(tmp_path, "loop-gen", wall_ms=5, media="lecture.mp4")
    rec.add(env(CAPTIONS, 1, captions()), media_ms=0, wall_ms=10)
    rec.add(env(TRANSLATE, 1, TranslationState(lang="tr", lines=[])), media_ms=0, wall_ms=11)
    rec.add(env(CAPTIONS, 2, captions(0)), media_ms=1000, wall_ms=1010)
    rec.add(
        env(TRANSLATE, 2, TranslationState(lang="tr", lines=[TranslatedLine(id=0, text="satir 0")])),
        media_ms=1200,
        wall_ms=1210,
    )
    rec.add(env(CAPTIONS, 3, captions(0, 1), cost=0.5), media_ms=2000, wall_ms=2010)
    rec.add(env(CAPTIONS, 4, captions(0, 1, 2)), media_ms=9000, wall_ms=9010)  # after the lecture ended
    rec.close(wall_ms=9100)
    return tmp_path


def test_recording_round_trips_with_a_manifest(tmp_path: Path) -> None:
    directory = record(tmp_path)
    manifest = load_manifest(directory)
    assert manifest.room == "loop-gen" and manifest.media == "lecture.mp4" and manifest.ended_wall_ms == 9100
    by_name = {a.info.name: a for a in manifest.agents}
    assert by_name["captions"].snapshots == 4 and by_name["captions"].last_media_ms == 9000
    assert [s.seq for s in read_snapshots(directory, by_name["captions"])] == [1, 2, 3, 4]
    assert [s.usage.cost_usd for s in read_snapshots(directory, by_name["captions"])][-2] == 0.5


def test_media_time_never_goes_back_within_an_agent(tmp_path: Path) -> None:
    rec = RecordingWriter(tmp_path, "loop-gen", wall_ms=0)
    rec.add(env(CAPTIONS, 1, captions()), media_ms=5000, wall_ms=1)
    snapshot = rec.add(env(CAPTIONS, 2, captions(0)), media_ms=10, wall_ms=2)  # the speaker's clock restarted
    assert snapshot.media_ms == 5000


def test_media_clock_reads_the_legacy_timestamp_and_keeps_the_newest() -> None:
    clock = MediaClock()
    assert clock.ms == 0
    clock.observe(write_varint(2_000_000) + b"x")
    clock.observe(write_varint(1_980_000) + b"x")  # reordered group
    assert clock.ms == 2000
    assert clock.observe(b"") is None


def test_shift_moves_every_media_time_and_id() -> None:
    shifted = shift_state(captions(0, 1), media_ms=60_000, ids=100)
    assert isinstance(shifted, CaptionsState)
    assert [(line.id, line.start_ms, line.end_ms) for line in shifted.lines] == [
        (100, 60_000, 60_900),
        (101, 61_000, 61_900),
    ]
    slides = shift_state(SlidesState(lang="en", slides=[SlideNote(id=2, at_ms=5, description="d")]), media_ms=10, ids=3)
    assert isinstance(slides, SlidesState) and (slides.slides[0].id, slides.slides[0].at_ms) == (5, 15)
    outline = OutlineState(lang="en", chapters=[Chapter(id=0, start_ms=0, title="t", summary="s")], glossary=[])
    moved = shift_state(outline, media_ms=7, ids=1)
    assert isinstance(moved, OutlineState) and (moved.chapters[0].id, moved.chapters[0].start_ms) == (1, 7)
    tr = shift_state(TranslationState(lang="tr", lines=[TranslatedLine(id=1, text="x")]), media_ms=7, ids=4)
    assert isinstance(tr, TranslationState) and tr.lines[0].id == 5


def test_timeline_merges_agents_in_lecture_order_and_clamps_to_the_lecture(tmp_path: Path) -> None:
    directory = record(tmp_path)
    timeline = Timeline(directory, load_manifest(directory), duration_ms=5000)
    cues = list(timeline.cues(timeline.plan(0)))
    assert [(c.at_ms, c.agent.info.name, c.snapshot.seq) for c in cues] == [
        (0, "captions", 1),
        (0, "translate-tr", 1),
        (1000, "captions", 2),
        (1200, "translate-tr", 2),
        (2000, "captions", 3),
        (5000, "captions", 4),  # recorded after the end: shown as the loop ends
    ]


def test_each_loop_moves_media_time_and_ids_so_nothing_repeats(tmp_path: Path) -> None:
    directory = record(tmp_path)
    timeline = Timeline(directory, load_manifest(directory), duration_ms=5000)
    assert timeline.stride == 3  # ids 0..2
    plan = timeline.plan(2)
    assert plan.media_offset_ms == 10_000 and plan.id_offset == 6 and plan.media_us(1_000) == 10_001_000
    last = [c for c in timeline.cues(plan) if c.agent.info.name == "captions"][-1].snapshot.state
    assert isinstance(last, CaptionsState)
    assert [(line.id, line.start_ms) for line in last.lines] == [(6, 10_000), (7, 11_000), (8, 12_000)]
    tr = [c for c in timeline.cues(plan) if c.agent.info.name == "translate-tr"][-1].snapshot.state
    assert isinstance(tr, TranslationState) and tr.lines[0].id == 6  # still points at its caption line


def test_stride_of_an_empty_recording_is_one() -> None:
    assert id_stride([]) == 1


def test_next_instance_is_the_clock_but_always_newer() -> None:
    assert next_instance(None, 1_700_000_000_000) == "1700000000000"
    assert next_instance("1700000000000", 1_700_000_000_000) == "1700000000001"
    assert next_instance("1700000000000", 1_700_000_005_000) == "1700000005000"
