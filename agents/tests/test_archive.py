# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportAttributeAccessIssue=false
"""The track archive: fMP4 segments that decode, runs, snapshot chunks, slides, restore and the bucket copy."""

from __future__ import annotations

import base64
import io
import json
import os
import time
from collections.abc import AsyncIterator
from pathlib import Path

import av
import numpy as np
import pytest

from talk_tracks import statefile
from talk_tracks.archive import restore
from talk_tracks.archive.bucket import Uploader
from talk_tracks.archive.mp4 import (
    OPUS_SILENCE,
    Sample,
    TrackConfig,
    avc_is_keyframe,
    init_segment,
    media_segment,
    opus_duration_us,
)
from talk_tracks.archive.store import (
    CHUNK_MS,
    Archive,
    Latest,
    RoomFilter,
    RoomIndex,
    RoomsIndex,
    RunIndex,
    track_configs,
)
from talk_tracks.audio import OpusEncoder, write_varint
from talk_tracks.contracts import (
    AgentInfo,
    CaptionLine,
    CaptionsState,
    Envelope,
    SlideFrame,
    Usage,
)
from talk_tracks.lecture import catalog, legacy_frame, packets, probe

from .clip import make_clip

WALL = 1_761_650_000_000
INFO = AgentInfo(name="captions", label="Captions (English)", model="fake")


def opus_packets(n: int) -> list[bytes]:
    encoder = OpusEncoder()
    t = np.arange(OpusEncoder.FRAME * n) / 48_000
    pcm = (np.sin(2 * np.pi * 440 * t) * 3000).astype(np.int16)
    out: list[bytes] = []
    for i in range(n):
        out += encoder.encode(pcm[i * OpusEncoder.FRAME : (i + 1) * OpusEncoder.FRAME])
    return out


def envelope(seq: int, lines: int, *, instance: str = "100") -> Envelope:
    state = CaptionsState(
        lang="en",
        lines=[CaptionLine(id=i, start_ms=i * 1000, end_ms=i * 1000 + 900, text=f"line {i}") for i in range(lines)],
    )
    return Envelope(agent=INFO, instance=instance, seq=seq, at_ms=WALL, usage=Usage(), state=state)


def decode(init: bytes, segments: list[bytes]) -> list[av.Packet]:  # pyright: ignore[reportMissingTypeArgument, reportUnknownParameterType]
    with av.open(io.BytesIO(init + b"".join(segments)), format="mp4") as container:
        return [p for p in container.demux() if p.size]


def run_dir(root: Path, room: str) -> Path:
    index = RoomIndex.model_validate_json((root / room / "room.json").read_bytes())
    return root / room / index.runs[-1].run


# --- fMP4 -------------------------------------------------------------------------------------------------------


def test_opus_segments_decode_at_their_media_time() -> None:
    config = TrackConfig(kind="audio", codec="opus")
    data = opus_packets(10)
    start = 7_000_000
    samples = [Sample(start + i * 20_000, 20_000, p, True) for i, p in enumerate(data)]
    out = decode(init_segment(config), [media_segment(1, samples[:5]), media_segment(2, samples[5:])])
    assert [p.pts for p in out] == [s.time_us for s in samples]  # timescale is µs, no offset
    assert out[0].stream.codec_context.name == "opus"
    with av.open(io.BytesIO(init_segment(config) + media_segment(1, samples)), format="mp4") as c:
        frames = list(c.decode(audio=0))
    assert sum(f.samples for f in frames) > 0


def test_silence_packet_is_a_20_ms_frame() -> None:
    assert opus_duration_us(OPUS_SILENCE[1]) == 20_000
    assert opus_duration_us(opus_packets(1)[0]) == 20_000


def test_h264_segments_keep_keyframes(tmp_path: Path) -> None:
    clip = make_clip(tmp_path / "clip.mp4", seconds=2.0)
    info = probe(clip)
    assert info.video is not None
    config = track_configs(catalog(info))["video"]
    video = [p for p in packets(clip) if p.kind == "video"]
    assert avc_is_keyframe(video[0].data, config.description) and not avc_is_keyframe(video[1].data, config.description)
    samples = [Sample(p.file_us, 100_000, p.data, avc_is_keyframe(p.data, config.description)) for p in video]
    out = decode(init_segment(config), [media_segment(1, samples)])
    assert [p.pts for p in out] == [s.time_us for s in samples]
    assert [bool(p.is_keyframe) for p in out] == [s.sync for s in samples]


def test_catalog_tracks_are_read_and_others_skipped() -> None:
    configs = track_configs(
        {
            "audio": {
                "renditions": {"audio": {"codec": "opus", "container": {"kind": "legacy"}, "numberOfChannels": 2}}
            },
            "video": {"renditions": {"cmaf": {"codec": "avc1.64001f", "container": {"kind": "cmaf"}}}},
        }
    )
    assert list(configs) == ["audio"] and configs["audio"].channels == 2


# --- media in the store -----------------------------------------------------------------------------------------


def feed_audio(archive: Archive, room: str, start_us: int, count: int, *, wall: int = WALL, skip: range = range(0)):
    for i, packet in enumerate(opus_packets(count)):
        if i in skip:
            continue
        archive.room(room).media("audio", legacy_frame(start_us + i * 20_000, packet), wall + i * 20)


def test_audio_is_cut_into_six_second_segments_back_to_back(tmp_path: Path) -> None:
    files: list[tuple[str, bool]] = []
    archive = Archive(tmp_path, on_file=lambda p, m: files.append((p, m)))
    feed_audio(archive, "live", 1_000_000, 700)  # 14 s
    archive.close()
    run = RunIndex.model_validate_json((run_dir(tmp_path, "live") / "run.json").read_bytes())
    (track,) = run.tracks
    assert track.track == "audio" and track.mime == 'audio/mp4; codecs="opus"'
    assert [s.start_ms for s in track.segments] == [1000, 7000, 13000]
    assert all(a.end_ms == b.start_ms for a, b in zip(track.segments, track.segments[1:], strict=False))
    assert track.segments[-1].end_ms == 15000
    assert run.media_first_ms == 1000
    folder = run_dir(tmp_path, "live") / "teacher" / "audio"
    out = decode(
        (folder / "init-0.mp4").read_bytes(), [(folder / f"{s.n:06d}.m4s").read_bytes() for s in track.segments]
    )
    assert len(out) == 700 and out[0].pts == 1_000_000
    assert (f"live/{run.run}/teacher/audio/000000.m4s", False) in files


def test_gaps_in_the_audio_are_silence_and_a_long_one_starts_a_segment(tmp_path: Path) -> None:
    archive = Archive(tmp_path)
    feed_audio(archive, "live", 0, 100, skip=range(20, 40))  # 400 ms suppressed
    feed_audio(archive, "live", 30_000_000, 50)  # 28 s later
    archive.close()
    run = RunIndex.model_validate_json((run_dir(tmp_path, "live") / "run.json").read_bytes())
    segments = run.tracks[0].segments
    assert [(s.start_ms, s.end_ms, s.samples) for s in segments] == [(0, 2000, 100), (30000, 31000, 50)]


def test_late_audio_is_reordered_and_repeats_are_dropped(tmp_path: Path) -> None:
    archive = Archive(tmp_path)
    data = opus_packets(10)
    order = [0, 2, 1, 3, 3, 4, 6, 5, 7, 8, 9]
    for i in order:
        archive.room("live").media("audio", legacy_frame(i * 20_000, data[i]), WALL)
    archive.close()
    folder = run_dir(tmp_path, "live") / "teacher" / "audio"
    out = decode((folder / "init-0.mp4").read_bytes(), [(folder / "000000.m4s").read_bytes()])
    assert [p.pts for p in out] == [i * 20_000 for i in range(10)]


def test_video_segments_open_with_a_keyframe(tmp_path: Path) -> None:
    clip = make_clip(tmp_path / "clip.mp4", seconds=8.0, fps=10)
    archive = Archive(tmp_path / "archive")
    room = archive.room("demo")
    room.catalog(json.dumps(catalog(probe(clip))).encode(), WALL)
    for p in packets(clip):
        room.media(p.kind, legacy_frame(p.file_us, p.data), WALL)
    archive.close()
    run = RunIndex.model_validate_json((run_dir(tmp_path / "archive", "demo") / "run.json").read_bytes())
    video = next(t for t in run.tracks if t.track == "video")
    assert video.codec.startswith("avc1") and video.width == 64
    assert [s.start_ms for s in video.segments] == [0, 6000]
    folder = run_dir(tmp_path / "archive", "demo") / "teacher" / "video"
    for s in video.segments:
        (first, *_) = decode((folder / s.init).read_bytes(), [(folder / f"{s.n:06d}.m4s").read_bytes()])
        assert first.is_keyframe
    assert (run_dir(tmp_path / "archive", "demo") / "teacher" / "catalog.json").exists()


def test_a_clock_restart_starts_a_new_run(tmp_path: Path) -> None:
    archive = Archive(tmp_path)
    feed_audio(archive, "live", 120_000_000, 50)
    archive.room("live").snapshot(envelope(1, 1), WALL + 2000)
    feed_audio(archive, "live", 0, 50, wall=WALL + 5000)  # the speaker's publisher restarted at 0
    archive.room("live").snapshot(envelope(2, 2), WALL + 6000)
    archive.close()
    rooms = RoomIndex.model_validate_json((tmp_path / "live" / "room.json").read_bytes())
    assert len(rooms.runs) == 2 and rooms.runs[0].media_first_ms == 120_000 and rooms.runs[1].media_first_ms == 0
    first = RunIndex.model_validate_json((tmp_path / "live" / rooms.runs[0].run / "run.json").read_bytes())
    second = RunIndex.model_validate_json((tmp_path / "live" / rooms.runs[1].run / "run.json").read_bytes())
    assert first.agents[0].chunks[0].first_media_ms == 120_980
    assert second.agents[0].chunks[0].first_media_ms == 980
    assert RoomsIndex.model_validate_json((tmp_path / "rooms.json").read_bytes()).rooms[0].runs == 2


def test_a_restarted_archiver_continues_the_run(tmp_path: Path) -> None:
    archive = Archive(tmp_path)
    feed_audio(archive, "live", 0, 400)
    archive.room("live").snapshot(envelope(1, 1), WALL + 1000)
    archive.close()
    archive = Archive(tmp_path)
    feed_audio(archive, "live", 8_000_000, 400, wall=WALL + 10_000)
    archive.room("live").snapshot(envelope(1, 2, instance="200"), WALL + 12_000)
    archive.close()
    rooms = RoomIndex.model_validate_json((tmp_path / "live" / "room.json").read_bytes())
    assert len(rooms.runs) == 1
    run = RunIndex.model_validate_json((run_dir(tmp_path, "live") / "run.json").read_bytes())
    segments = run.tracks[0].segments
    assert [s.n for s in segments] == [0, 1, 2, 3] and segments[2].init == "init-2.mp4"
    assert [c.n for c in run.agents[0].chunks] == [0, 1] and not run.agents[0].chunks[0].open


# --- snapshots ----------------------------------------------------------------------------------------------------


def test_snapshots_are_chunked_by_wall_time_and_latest_is_kept(tmp_path: Path) -> None:
    files: list[tuple[str, bool]] = []
    archive = Archive(tmp_path, on_file=lambda p, m: files.append((p, m)))
    feed_audio(archive, "live", 5_000_000, 10)
    for seq in range(1, 6):
        archive.room("live").snapshot(envelope(seq, seq), WALL + seq * 3000)
    archive.tick(WALL + 5 * 3000 + CHUNK_MS)  # the second chunk is due as well
    run = RunIndex.model_validate_json((run_dir(tmp_path, "live") / "run.json").read_bytes())
    chunks = run.agents[0].chunks
    assert [(c.n, c.snapshots, c.open) for c in chunks] == [(0, 4, False), (1, 1, False)]
    assert all(c.first_media_ms == 5_180 for c in chunks)
    lines = (run_dir(tmp_path, "live") / "agents" / "captions" / "000000.jsonl").read_text().splitlines()
    assert [json.loads(line)["seq"] for line in lines] == [1, 2, 3, 4]
    latest = Latest.model_validate_json((tmp_path / "live" / "latest" / "captions.json").read_bytes())
    assert latest.snapshot.seq == 5 and latest.run == run.run
    assert (f"live/{run.run}/agents/captions/000000.jsonl", False) in files
    assert ("live/latest/captions.json", True) in files


def test_slides_are_kept_once_per_change(tmp_path: Path) -> None:
    archive = Archive(tmp_path)
    png = base64.b64encode(b"\x89PNG fake").decode()
    room = archive.room("live")
    assert room.slide(SlideFrame(id=0, at_ms=0, mime="image/png", data_b64=png), WALL)
    assert not room.slide(SlideFrame(id=0, at_ms=0, mime="image/png", data_b64=png), WALL + 2000)
    assert room.slide(SlideFrame(id=1, at_ms=20_000, mime="image/png", data_b64=png), WALL + 20_000)
    archive.close()
    folder = run_dir(tmp_path, "live") / "slides"
    lines = [json.loads(line) for line in (folder / "frames.jsonl").read_text().splitlines()]
    assert [line["id"] for line in lines] == [0, 1] and lines[0]["file"] == lines[1]["file"]
    assert (folder / lines[0]["file"]).read_bytes() == b"\x89PNG fake"


# --- restore ------------------------------------------------------------------------------------------------------


def test_captions_restore_from_the_archive_when_the_state_file_is_gone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("TT_ARCHIVE_DIR", raising=False)
    archive = Archive(tmp_path / "archive")
    archive.room("live-1").snapshot(envelope(7, 12), time.time_ns() // 1_000_000)
    archive.close()
    state_file = tmp_path / "state" / "captions-live-1-en.json"
    state = statefile.load_captions(state_file)
    assert state is not None and state.lines[-1].id == 11
    assert statefile.load_captions(tmp_path / "state" / "captions-live-1-tr.json") is None  # another language


def test_the_newer_of_state_file_and_archive_wins(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TT_ARCHIVE_DIR", str(tmp_path / "elsewhere"))
    archive = Archive(tmp_path / "elsewhere")
    archive.room("live").snapshot(envelope(3, 5), time.time_ns() // 1_000_000)
    archive.close()
    state_file = tmp_path / "state" / "captions-live-en.json"
    statefile.save(state_file, envelope(9, 8).state)  # pyright: ignore[reportArgumentType]
    assert (state := statefile.load_captions(state_file)) is not None and state.lines[-1].id == 7
    statefile.save(state_file, envelope(1, 2).state)  # pyright: ignore[reportArgumentType]
    assert (state := statefile.load_captions(state_file)) is not None and state.lines[-1].id == 4
    os.utime(state_file, (0, 0))  # stale: the archive wins anyway
    assert (state := statefile.load_captions(state_file)) is not None and state.lines[-1].id == 4


def test_an_old_archived_state_is_not_restored(tmp_path: Path) -> None:
    archive = Archive(tmp_path)
    archive.room("live").snapshot(envelope(3, 5), WALL)
    archive.close()
    assert restore.latest_state(tmp_path, "live", "captions", now_ms=WALL + 60_000) is not None
    assert restore.latest_state(tmp_path, "live", "captions", now_ms=WALL + 31 * 60_000) is None
    assert restore.latest_state(tmp_path, "live", "chapters", now_ms=WALL) is None


# --- bucket copy and room filter --------------------------------------------------------------------------------


class FakeBucket:
    def __init__(self, existing: dict[str, int] | None = None, fail: int = 0) -> None:
        self.objects: dict[str, bytes] = {}
        self.puts: list[str] = []
        self.existing = existing or {}
        self.fail = fail

    async def put(self, name: str, data: bytes, content_type: str) -> None:
        if self.fail:
            self.fail -= 1
            raise OSError("bucket away")
        self.puts.append(name)
        self.objects[name] = data

    async def sizes(self, prefix: str = "") -> AsyncIterator[tuple[str, int]]:
        for name, size in self.existing.items():
            yield name, size


async def test_finished_files_go_to_the_bucket_and_indexes_are_coalesced(tmp_path: Path) -> None:
    import asyncio

    bucket = FakeBucket(fail=1)
    uploader = Uploader(tmp_path, bucket, mutable_every_s=0.2)
    archive = Archive(tmp_path, on_file=uploader.notify)
    task = asyncio.create_task(uploader.run())
    feed_audio(archive, "live", 0, 400)
    for seq in range(1, 4):
        archive.room("live").snapshot(envelope(seq, seq), WALL + seq)
    archive.tick(WALL + 10)
    await asyncio.sleep(3)  # one failure, retried after 1 s
    task.cancel()
    run = run_dir(tmp_path, "live").name
    assert f"live/{run}/teacher/audio/000000.m4s" in bucket.objects
    assert f"live/{run}/teacher/audio/init-0.mp4" in bucket.objects
    assert bucket.puts.count("live/latest/captions.json") == 1  # three changes, one upload
    assert "rooms.json" in bucket.objects, bucket.puts
    await uploader.drain(2)
    assert bucket.objects[f"live/{run}/run.json"] == (tmp_path / "live" / run / "run.json").read_bytes()


async def test_start_up_sync_uploads_what_the_bucket_lacks(tmp_path: Path) -> None:
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "x.m4s").write_bytes(b"12345")
    (tmp_path / "a" / "y.m4s").write_bytes(b"123")
    (tmp_path / "a" / "z.json.tmp").write_bytes(b"{")
    bucket = FakeBucket(existing={"a/x.m4s": 5})
    uploader = Uploader(tmp_path, bucket)
    await uploader.sync()
    await uploader.drain(2)
    assert bucket.puts == ["a/y.m4s"]


async def test_gcs_bucket_uses_the_metadata_token_and_the_archive_folder() -> None:
    import httpx

    from talk_tracks.archive.bucket import GcsBucket

    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/token"):
            assert request.headers["Metadata-Flavor"] == "Google"
            return httpx.Response(200, json={"access_token": "t0k", "expires_in": 3600})
        assert request.headers["Authorization"] == "Bearer t0k"
        if request.url.path.startswith("/upload/"):
            return httpx.Response(200, json={})
        if "pageToken" not in request.url.params:
            return httpx.Response(200, json={"items": [{"name": "archive/a.m4s", "size": "3"}], "nextPageToken": "p2"})
        return httpx.Response(200, json={"items": [{"name": "archive/b/c.json", "size": "9"}]})

    bucket = GcsBucket("gs://my-bucket", transport=httpx.MockTransport(handle))
    await bucket.put("live/1/run.json", b"{}", "application/json")
    assert seen[1].url.params["name"] == "archive/live/1/run.json" and "/b/my-bucket/o" in seen[1].url.path
    assert [x async for x in bucket.sizes()] == [("a.m4s", 3), ("b/c.json", 9)]
    assert sum(r.url.path.endswith("/token") for r in seen) == 1
    await bucket.aclose()
    assert GcsBucket("other/history").folder == "history/"


def test_no_bucket_means_no_copy(tmp_path: Path) -> None:
    uploader = Uploader(tmp_path, None)
    uploader.notify("a/x.m4s", False)
    assert uploader.pending == 0


def test_room_filter() -> None:
    wanted = RoomFilter("*", "demo,loop-*")
    assert wanted("live") and not wanted("demo") and not wanted("loop-a")
    assert RoomFilter("judge-*")("judge-1") and not RoomFilter("judge-*")("live")


def test_legacy_frame_helper_matches_the_audio_reader() -> None:
    assert legacy_frame(5, b"x") == write_varint(5) + b"x"
