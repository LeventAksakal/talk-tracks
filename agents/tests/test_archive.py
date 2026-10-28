# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportAttributeAccessIssue=false
"""The track archive: fMP4 segments that decode, runs, snapshot chunks, slides, restore and the bucket copy."""

from __future__ import annotations

import asyncio
import base64
import io
import json
from collections.abc import AsyncIterator
from pathlib import Path

import av
import numpy as np
import pytest

from talk_tracks.archive.bucket import AlreadyThere, Uploader
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
    CLOCK_WAIT_MS,
    Archive,
    RoomClock,
    RoomFilter,
    RoomIndex,
    RoomsIndex,
    RunIndex,
    track_configs,
)
from talk_tracks.audio import OpusEncoder, write_varint
from talk_tracks.contracts import SlideFrame
from talk_tracks.lecture import catalog, legacy_frame, packets, probe

from .clip import make_clip

WALL = 1_761_650_000_000


def opus_packets(n: int) -> list[bytes]:
    encoder = OpusEncoder()
    t = np.arange(OpusEncoder.FRAME * n) / 48_000
    pcm = (np.sin(2 * np.pi * 440 * t) * 3000).astype(np.int16)
    out: list[bytes] = []
    for i in range(n):
        out += encoder.encode(pcm[i * OpusEncoder.FRAME : (i + 1) * OpusEncoder.FRAME])
    return out


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


def test_each_broadcast_is_a_run_on_one_room_clock(tmp_path: Path) -> None:
    archive = Archive(tmp_path)
    room = archive.room("live")
    room.clock(RoomClock(epoch_ms=WALL, offset_ms=0, session=str(WALL)), WALL)
    feed_audio(archive, "live", 120_000_000, 50)
    room.teacher_gone()
    room.slides_gone()  # a reload: the console goes too
    feed_audio(archive, "live", 0, 50, wall=WALL + 130_000)  # media time restarts near 0: held for the new clock
    assert room.offset_ms is None
    room.clock(RoomClock(epoch_ms=WALL, offset_ms=125_000, session=str(WALL + 130_000)), WALL + 130_100)
    archive.close()
    rooms = RoomIndex.model_validate_json((tmp_path / "live" / "room.json").read_bytes())
    assert rooms.epoch_ms == WALL and [r.session for r in rooms.runs] == [str(WALL), str(WALL + 130_000)]
    assert rooms.runs[0].media_first_ms == 120_000 and rooms.runs[1].media_first_ms == 125_000
    second = RunIndex.model_validate_json((tmp_path / "live" / rooms.runs[1].run / "run.json").read_bytes())
    assert second.offset_ms == 125_000 and second.tracks[0].segments[0].start_ms == 125_000
    assert room.end_ms == 125_980
    assert RoomsIndex.model_validate_json((tmp_path / "rooms.json").read_bytes()).rooms[0].runs == 2


def test_a_teacher_rejoining_under_the_same_console_keeps_its_clock(tmp_path: Path) -> None:
    archive = Archive(tmp_path)
    room = archive.room("live")
    room.clock(RoomClock(epoch_ms=WALL, offset_ms=40_000, session="s1"), WALL)
    feed_audio(archive, "live", 1_000_000, 10)
    room.teacher_gone()  # the microphone restarted; the console (and its clock) stayed
    feed_audio(archive, "live", 9_000_000, 10, wall=WALL + 9_000)
    assert room.offset_ms == 40_000
    archive.close()
    rooms = RoomIndex.model_validate_json((tmp_path / "live" / "room.json").read_bytes())
    assert len(rooms.runs) == 1 and rooms.runs[0].media_first_ms == 41_000 and rooms.runs[0].media_last_ms == 49_180


def test_without_a_clock_track_room_time_is_media_time(tmp_path: Path) -> None:
    archive = Archive(tmp_path)
    room = archive.room("demo")
    room.media("audio", legacy_frame(7_000_000, opus_packets(1)[0]), WALL)
    assert room.offset_ms is None and room.run is None  # held for the clock
    room.tick(WALL + CLOCK_WAIT_MS)
    assert room.offset_ms == 0
    archive.close()
    run = RunIndex.model_validate_json((run_dir(tmp_path, "demo") / "run.json").read_bytes())
    assert run.media_first_ms == 7_000 and run.session is None


def test_a_restarted_archiver_continues_the_run(tmp_path: Path) -> None:
    archive = Archive(tmp_path)
    feed_audio(archive, "live", 0, 400)
    archive.close()
    archive = Archive(tmp_path)
    feed_audio(archive, "live", 8_000_000, 400, wall=WALL + 10_000)
    archive.close()
    rooms = RoomIndex.model_validate_json((tmp_path / "live" / "room.json").read_bytes())
    assert len(rooms.runs) == 1
    run = RunIndex.model_validate_json((run_dir(tmp_path, "live") / "run.json").read_bytes())
    segments = run.tracks[0].segments
    assert [s.n for s in segments] == [0, 1, 2, 3] and segments[2].init == "init-2.mp4"


# --- slides -------------------------------------------------------------------------------------------------------


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


# --- bucket copy and room filter --------------------------------------------------------------------------------


class FakeBucket:
    def __init__(self, existing: dict[str, int] | None = None, fail: int = 0) -> None:
        self.objects: dict[str, bytes] = {}
        self.puts: list[str] = []
        self.existing = existing or {}
        self.fail = fail

    async def put(self, name: str, data: bytes, content_type: str, *, create_only: bool = False) -> None:
        if self.fail:
            self.fail -= 1
            raise OSError("bucket away")
        if create_only and name in self.objects:
            raise AlreadyThere(name)
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
    png = base64.b64encode(b"\x89PNG fake").decode()
    for n in range(3):
        archive.room("live").slide(SlideFrame(id=n, at_ms=n, mime="image/png", data_b64=png), WALL + n)
    archive.tick(WALL + 10)
    await asyncio.sleep(3)  # one failure, retried after 1 s
    task.cancel()
    run = run_dir(tmp_path, "live").name
    assert f"live/{run}/teacher/audio/000000.m4s" in bucket.objects
    assert f"live/{run}/teacher/audio/init-0.mp4" in bucket.objects
    assert bucket.puts.count(f"live/{run}/slides/frames.jsonl") == 1  # three changes, one upload
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
            if request.url.params.get("ifGenerationMatch") == "0" and request.url.params["name"].endswith(
                "taken.slice"
            ):
                return httpx.Response(412, json={})
            return httpx.Response(200, json={})
        if "pageToken" not in request.url.params:
            return httpx.Response(200, json={"items": [{"name": "archive/a.m4s", "size": "3"}], "nextPageToken": "p2"})
        return httpx.Response(200, json={"items": [{"name": "archive/b/c.json", "size": "9"}]})

    bucket = GcsBucket("gs://my-bucket", transport=httpx.MockTransport(handle))
    await bucket.put("live/1/run.json", b"{}", "application/json")
    assert seen[1].url.params["name"] == "archive/live/1/run.json" and "/b/my-bucket/o" in seen[1].url.path
    assert "ifGenerationMatch" not in seen[1].url.params  # an index is replaced
    await bucket.put("live/agents/c/items/00000001.slice", b"x", "text/plain", create_only=True)
    assert seen[-1].url.params["ifGenerationMatch"] == "0"
    with pytest.raises(AlreadyThere):
        await bucket.put("live/agents/c/items/taken.slice", b"x", "text/plain", create_only=True)
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


# --- the slice store (decision 0012) ---------------------------------------------------------------------------------


def test_slices_round_trip_byte_identical(tmp_path: Path) -> None:
    from talk_tracks.archive.slices import END_OF_GROUP, SliceExists, SliceObject, TrackArchive, slice_of

    t = TrackArchive("room1", "captions", "items", root=tmp_path)
    k = slice_of(9_500)
    assert k == 2
    carry = b'{"kind":"carry","lines":["\xc3\xa7ok g\xc3\xbczel"]}'
    t.write(k, SliceObject(0, carry))
    t.write(k, SliceObject(1, b"\x00\xffbinary", publisher_priority=224, extensions={7: b"x"}))
    open_now = t.read_local(k)
    assert open_now is not None and not open_now.complete and len(open_now.objects) == 2
    with pytest.raises(ValueError):
        t.write(k, SliceObject(1, b"again"))
    done = t.end_group(k)
    assert done.complete and done.last_object_id == 2 and done.objects[-1].status == END_OF_GROUP
    assert done.objects[0].payload == carry and done.objects[1].payload == b"\x00\xffbinary"
    assert done.objects[1].publisher_priority == 224 and done.objects[1].extensions == {7: b"x"}
    assert (tmp_path / "room1/agents/captions/items/00000002.slice").exists()
    with pytest.raises(SliceExists):
        t.write(k, SliceObject(3, b"late"))
    assert t.groups() == [2] and t.latest_group() == 2


def test_slices_restart_and_backfill(tmp_path: Path) -> None:
    from talk_tracks.archive.slices import END_OF_TRACK, SliceExists, SliceObject, TrackArchive

    old = TrackArchive("room1", "captions", "items", root=tmp_path)
    old.write(5, SliceObject(0, b"carry"))
    old.close()  # killed mid-slice: it stays open
    new = TrackArchive("room1", "captions", "items", root=tmp_path)
    assert new.latest_group() == 5
    with pytest.raises(SliceExists):
        new.write(5, SliceObject(0, b"other"))
    new.write(6, SliceObject(0, b"next slice"))
    new.write(3, SliceObject(0, b"back-fill"))  # a past slice next to the live one
    assert new.end_group(3).objects[0].payload == b"back-fill"
    assert new.discard(5) and new.read_local(5) is None
    empty = new.end_group(7, end_of_track=True)  # capped or finished: only the end marker
    assert empty.end_of_track and empty.last_object_id == 0 and empty.objects[0].status == END_OF_TRACK


def test_slices_read_from_bucket(tmp_path: Path) -> None:
    from talk_tracks.archive.slices import SliceObject, TrackArchive

    src = TrackArchive("room1", "captions", "items", root=tmp_path / "vm1")
    src.write(1, SliceObject(0, b"one"))
    src.end_group(1)
    stored = {
        "room1/agents/captions/items/00000001.slice": (
            tmp_path / "vm1/room1/agents/captions/items/00000001.slice"
        ).read_bytes()
    }

    class Fake:
        async def get(self, name: str) -> bytes | None:
            return stored.get(name)

    t = TrackArchive("room1", "captions", "items", root=tmp_path / "vm2", bucket=Fake())
    got = asyncio.run(t.read(1))
    assert got is not None and got.complete and got.objects[0].payload == b"one"
    assert t.read_local(1) is not None  # kept on disk
    assert asyncio.run(t.read(2)) is None


def test_last_object_of_a_slice(tmp_path: Path) -> None:
    from talk_tracks.archive.slices import SliceObject, TrackArchive

    t = TrackArchive("room1", "outline", "outline", root=tmp_path)
    t.write(4, SliceObject(0, b"v1"))
    t.write(4, SliceObject(1, b"v2"))
    last = asyncio.run(t.last_object(4))
    assert last is not None and last.object_id == 1 and last.payload == b"v2"  # open: the latest so far
    t.end_group(4)
    last = asyncio.run(t.last_object(4))
    assert last is not None and last.payload == b"v2"  # the end marker is left out
    t.end_group(5)
    assert asyncio.run(t.last_object(5)) is None and asyncio.run(t.last_object(9)) is None


def test_slice_watcher_and_track_info(tmp_path: Path) -> None:
    from talk_tracks.archive.slices import SliceObject, SliceWatcher, TrackArchive, TrackInfo

    w = SliceWatcher(tmp_path)
    t = TrackArchive(
        "room1",
        "translate-tr",
        "items",
        root=tmp_path,
        info=TrackInfo("translation", lang="tr", depends=["captions/items"]),
    )
    t.write(0, SliceObject(0, b"a"))
    t.end_group(0)
    got = w.poll()
    assert ("room1/agents/translate-tr/items/00000000.slice", False) in got
    assert ("room1/agents/translate-tr/items/track.json", True) in got
    info = json.loads((tmp_path / "room1/agents/translate-tr/items/track.json").read_text())
    assert info["lang"] == "tr" and info["sliceMs"] == 4000 and info["status"] == "idle"
    assert w.poll() == []


def test_room_catalog_lists_tracks_without_subscribing(tmp_path: Path) -> None:
    from talk_tracks.archive.catalog import RoomCatalog
    from talk_tracks.archive.slices import TrackArchive, TrackInfo

    t = TrackArchive(
        "room1",
        "translate-tr",
        "items",
        root=tmp_path,
        info=TrackInfo("translation", lang="tr", depends=["captions/items"]),
    )
    cat = RoomCatalog("room1", tmp_path)
    cat.teacher = {"audio": TrackConfig(kind="audio", codec="opus")}
    cat.agents = {"translate-tr", "chapters"}  # chapters announced, but no track.json yet: not listed
    doc = json.loads(cat.changed() or b"")
    names = [(e["namespace"], e["name"]) for e in doc["tracks"]]
    assert names == [("talk/room1/teacher", "audio"), ("talk/room1/agents/translate-tr", "items")]
    tr = doc["tracks"][1]
    assert tr["lang"] == "tr" and tr["packaging"] == "slices" and tr["sliceMs"] == 4000 and tr["status"] == "idle"
    assert tr["depends"] == ["talk/room1/agents/captions/items"] and tr["cost"] == "paid"
    assert doc["archive"] == "/archive/room1/room.json"
    assert cat.changed() is None
    t.set_status("capped")
    assert json.loads(cat.changed() or b"")["tracks"][1]["status"] == "capped"


def test_room_catalog_carries_the_room_clock(tmp_path: Path) -> None:
    from talk_tracks.archive.catalog import RoomCatalog
    from talk_tracks.archive.slices import SliceObject, TrackArchive

    cat = RoomCatalog("room1", tmp_path)
    assert json.loads(cat.changed() or b"")["end_ms"] is None
    cat.epoch_ms, cat.media_end_ms = WALL, 100_000
    doc = json.loads(cat.changed() or b"")
    assert doc["epoch_ms"] == WALL and doc["end_ms"] == 100_000
    t = TrackArchive("room1", "captions", "items", root=tmp_path)
    t.write(50, SliceObject(0, b"carry"))  # an agent's slice past the media: the next broadcast starts after it
    assert json.loads(cat.changed() or b"")["end_ms"] == 51 * 4000


def test_a_slice_is_created_once_and_the_loser_serves_the_winners_copy(tmp_path: Path) -> None:
    from concurrent.futures import ThreadPoolExecutor

    from talk_tracks.archive.slices import SliceExists, SliceObject, TrackArchive

    def backfill(n: int) -> tuple[bytes, bool]:
        t = TrackArchive("room1", "translate-tr", "items", root=tmp_path)  # one per process, as agents would
        got, created = t.create(7, [SliceObject(0, f"carry {n}".encode()), SliceObject(1, f"item {n}".encode())])
        assert got.complete and got.last_object_id == 2
        return got.objects[0].payload, created

    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(backfill, range(8)))
    assert sum(created for _, created in results) == 1  # exactly one writer
    winner = next(payload for payload, created in results if created)
    assert all(payload == winner for payload, _ in results)  # everyone serves the winner's copy
    assert sorted(p.name for p in (tmp_path / "room1/agents/translate-tr/items").iterdir()) == ["00000007.slice"]

    live = TrackArchive("room1", "translate-tr", "items", root=tmp_path)
    live.write(8, SliceObject(0, b"live carry"))  # open here
    other = TrackArchive("room1", "translate-tr", "items", root=tmp_path)
    got, created = other.create(8, [SliceObject(0, b"back-fill")])
    assert not created and got.objects[0].payload == b"live carry" and not got.complete
    with pytest.raises(SliceExists) as held:
        other.write(8, SliceObject(0, b"again"))
    assert held.value.existing is not None and held.value.existing.objects[0].payload == b"live carry"

    other.create(9, [SliceObject(0, b"back-filled first")])
    with pytest.raises(SliceExists):
        live.write(9, SliceObject(0, b"live"))  # finished: not reopened
    live.write(10, SliceObject(0, b"live"))
    winner_file = tmp_path / "room1/agents/translate-tr/items/00000010.slice"
    winner_file.write_text('{"o":0,"t":"won"}\n{"o":1,"st":3}\n')  # another process finished slice 10 first
    with pytest.raises(SliceExists) as lost:
        live.end_group(10)
    assert lost.value.existing is not None and lost.value.existing.objects[0].payload == b"won"
    assert winner_file.read_text().startswith('{"o":0,"t":"won"}')  # never overwritten
    live.close()


async def test_finished_slices_go_to_the_bucket_create_only(tmp_path: Path) -> None:
    from talk_tracks.archive.slices import SliceObject, TrackArchive

    t = TrackArchive("room1", "captions", "items", root=tmp_path)
    t.create(3, [SliceObject(0, b"ours")])
    bucket = FakeBucket()
    bucket.objects["room1/agents/captions/items/00000003.slice"] = b"theirs"  # another VM's copy got there first
    uploader = Uploader(tmp_path, bucket)
    uploader.notify("room1/agents/captions/items/00000003.slice", False)
    await uploader.drain(2)
    assert bucket.objects["room1/agents/captions/items/00000003.slice"] == b"theirs" and uploader.kept == 1


def test_without_hard_links_the_finish_is_still_once(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import os

    from talk_tracks.archive.slices import SliceExists, SliceObject, TrackArchive

    def no_links(src: object, dst: object) -> None:
        raise PermissionError("hard links are not supported here")

    monkeypatch.setattr(os, "link", no_links)
    a = TrackArchive("room1", "captions", "items", root=tmp_path)
    b = TrackArchive("room1", "captions", "items", root=tmp_path)
    assert b.create(4, [SliceObject(0, b"first")])[1]
    assert not a.create(4, [SliceObject(0, b"second")])[1]
    a.write(5, SliceObject(0, b"live"))
    (tmp_path / "room1/agents/captions/items/00000005.slice").write_text('{"o":0,"t":"won"}\n{"o":1,"st":3}\n')
    with pytest.raises(SliceExists):
        a.end_group(5)
    assert b.read_local(4).objects[0].payload == b"first"  # pyright: ignore[reportOptionalMemberAccess]
    assert b.read_local(5).objects[0].payload == b"won"  # pyright: ignore[reportOptionalMemberAccess]
    a.close()
