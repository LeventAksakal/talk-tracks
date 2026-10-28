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
    MOQ_EPOCH_MS,
    Archive,
    Clock,
    RoomFilter,
    RoomIndex,
    RoomsIndex,
    RunIndex,
    broadcast_clock,
    shift_for,
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


# --- media in the store: the room clock -------------------------------------------------------------------------


def clock_of(origin_ms: int) -> dict[str, int]:
    """The hang root ``clock`` of a page loaded at ``origin_ms`` (Unix): µs since the moq epoch."""
    return {"wall": (origin_ms - MOQ_EPOCH_MS) * 1000, "timescale": 1_000_000}


def teacher(archive: Archive, room: str, origin_ms: int = WALL, *, clock: bool = True) -> bool:
    """A teacher broadcast's catalog: mono Opus, with the broadcast's clock."""
    cat: dict[str, object] = {
        "audio": {"renditions": {"audio": {"codec": "opus", "container": {"kind": "legacy"}}}},
    }
    if clock:
        cat["clock"] = clock_of(origin_ms)
    return archive.room(room).catalog(json.dumps(cat).encode(), origin_ms)


def feed_audio(archive: Archive, room: str, start_us: int, count: int, *, wall: int = WALL, skip: range = range(0)):
    for i, packet in enumerate(opus_packets(count)):
        if i in skip:
            continue
        archive.room(room).media("audio", legacy_frame(start_us + i * 20_000, packet), wall + i * 20)


def room_index(root: Path, room: str) -> RoomIndex:
    return RoomIndex.model_validate_json((root / room / "room.json").read_bytes())


def test_the_clock_comes_from_the_hang_catalog_root() -> None:
    assert broadcast_clock({"clock": clock_of(WALL)}) == Clock(str((WALL - MOQ_EPOCH_MS) * 1000), WALL * 1000)
    in_ms = broadcast_clock({"clock": {"wall": WALL - MOQ_EPOCH_MS, "timescale": 1000}})
    assert in_ms is not None and in_ms.origin_ms == WALL and in_ms.key == str(WALL - MOQ_EPOCH_MS)
    assert broadcast_clock({}) is None and broadcast_clock({"clock": {"wall": "x"}}) is None


def test_a_shift_is_whole_slices_past_every_used_slice() -> None:
    assert shift_for(1_000, None) == 0  # the room's first broadcast
    assert shift_for(60_000, 59_000) == 0  # a reload: later on the wall clock, in a fresh slice
    assert shift_for(57_000, 56_500) == 4_000  # a slice partly used is used
    assert shift_for(500, 1_000) == 4_000  # a slow device clock
    assert shift_for(1_000, 204_000) == 204_000  # an agent's slice 50 is the end: the media starts in slice 51


def test_audio_is_cut_on_the_four_second_grid_in_room_time(tmp_path: Path) -> None:
    files: list[tuple[str, bool]] = []
    archive = Archive(tmp_path, on_file=lambda p, m: files.append((p, m)))
    assert teacher(archive, "live")
    feed_audio(archive, "live", 1_000_000, 700)  # 14 s, from 1 s after the page loaded
    archive.close()
    rooms = room_index(tmp_path, "live")
    assert rooms.epoch_ms == WALL and rooms.shift == {str((WALL - MOQ_EPOCH_MS) * 1000): 0}
    run = RunIndex.model_validate_json((run_dir(tmp_path, "live") / "run.json").read_bytes())
    assert run.run == str(WALL) and run.shift_ms == 0 and run.media_first_ms == 1000
    (track,) = run.tracks
    assert track.track == "audio" and track.mime == 'audio/mp4; codecs="opus"'
    assert [s.start_ms for s in track.segments] == [1000, 4000, 8000, 12000]
    assert all(a.end_ms == b.start_ms for a, b in zip(track.segments, track.segments[1:], strict=False))
    assert track.segments[-1].end_ms == 15000
    folder = run_dir(tmp_path, "live") / "teacher" / "audio"
    out = decode(
        (folder / "init-0.mp4").read_bytes(), [(folder / f"{s.n:06d}.m4s").read_bytes() for s in track.segments]
    )
    assert len(out) == 700 and out[0].pts == 1_000_000  # tfdt in room time
    assert (f"live/{run.run}/teacher/audio/000000.m4s", False) in files
    assert ("live/audio.m3u8", True) in files and ("live/index.m3u8", True) in files


def test_gaps_in_the_audio_are_silence_and_a_long_one_starts_a_segment(tmp_path: Path) -> None:
    archive = Archive(tmp_path)
    teacher(archive, "live")
    feed_audio(archive, "live", 0, 100, skip=range(20, 40))  # 400 ms suppressed
    feed_audio(archive, "live", 30_000_000, 50)  # 28 s later
    archive.close()
    run = RunIndex.model_validate_json((run_dir(tmp_path, "live") / "run.json").read_bytes())
    segments = run.tracks[0].segments
    assert [(s.start_ms, s.end_ms, s.samples) for s in segments] == [(0, 2000, 100), (30000, 31000, 50)]
    playlist = (tmp_path / "live" / "audio.m3u8").read_text()
    assert playlist.count("#EXT-X-GAP") == 7  # 2 s to 30 s, in 4 s steps
    assert "#EXT-X-DISCONTINUITY" not in playlist and playlist.endswith("#EXT-X-ENDLIST\n")


def test_late_audio_is_reordered_and_repeats_are_dropped(tmp_path: Path) -> None:
    archive = Archive(tmp_path)
    teacher(archive, "live")
    data = opus_packets(10)
    order = [0, 2, 1, 3, 3, 4, 6, 5, 7, 8, 9]
    for i in order:
        archive.room("live").media("audio", legacy_frame(i * 20_000, data[i]), WALL)
    archive.close()
    folder = run_dir(tmp_path, "live") / "teacher" / "audio"
    out = decode((folder / "init-0.mp4").read_bytes(), [(folder / "000000.m4s").read_bytes()])
    assert [p.pts for p in out] == [i * 20_000 for i in range(10)]


def test_video_segments_open_with_a_keyframe_and_the_playlists_pair_them(tmp_path: Path) -> None:
    clip = make_clip(tmp_path / "clip.mp4", seconds=8.0, fps=10)
    archive = Archive(tmp_path / "archive")
    room = archive.room("demo")
    assert room.catalog(json.dumps(catalog(probe(clip), {"clock": clock_of(WALL)})).encode(), WALL)
    room.live = True
    for p in packets(clip):
        room.media(p.kind, legacy_frame(p.file_us, p.data), WALL)
    room.tick(WALL + 10_000)  # the tracks went quiet: their segments close
    archive.save()
    run = RunIndex.model_validate_json((run_dir(tmp_path / "archive", "demo") / "run.json").read_bytes())
    video = next(t for t in run.tracks if t.track == "video")
    assert video.codec.startswith("avc1") and video.width == 64
    assert [s.start_ms for s in video.segments] == [0, 4000]
    folder = run_dir(tmp_path / "archive", "demo") / "teacher" / "video"
    for s in video.segments:
        (first, *_) = decode((folder / s.init).read_bytes(), [(folder / f"{s.n:06d}.m4s").read_bytes()])
        assert first.is_keyframe
    assert (run_dir(tmp_path / "archive", "demo") / "teacher" / "catalog.json").exists()
    index = (tmp_path / "archive" / "demo" / "index.m3u8").read_text()
    assert '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio"' in index and 'URI="audio.m3u8"' in index
    assert f'CODECS="{video.codec},opus",RESOLUTION=64x48,AUDIO="audio"\nvideo.m3u8' in index
    playlist = (tmp_path / "archive" / "demo" / "video.m3u8").read_text()
    assert f'#EXT-X-MAP:URI="{run.run}/teacher/video/init-0.mp4"' in playlist
    assert "#EXT-X-PROGRAM-DATE-TIME:2025-10-28T11:13:24.000Z" in playlist  # E + 4 s
    assert "#EXT-X-ENDLIST" not in playlist  # live: still being appended to


def test_each_broadcast_is_a_run_with_its_shift(tmp_path: Path) -> None:
    archive = Archive(tmp_path)
    room = archive.room("live")
    teacher(archive, "live", WALL)
    feed_audio(archive, "live", 0, 50)  # room time 0 to 1 s
    room.teacher_gone()
    teacher(archive, "live", WALL + 500)  # another device, its clock 30 s slow: its media maps onto used slices
    feed_audio(archive, "live", 0, 50, wall=WALL + 30_500)
    room.teacher_gone()
    teacher(archive, "live", WALL + 60_000)  # a reload, later on the wall clock
    feed_audio(archive, "live", 100_000, 50, wall=WALL + 60_100)
    archive.close()
    rooms = room_index(tmp_path, "live")
    keys = [str((w - MOQ_EPOCH_MS) * 1000) for w in (WALL, WALL + 500, WALL + 60_000)]
    assert rooms.shift == dict(zip(keys, [0, 4_000, 0], strict=True))
    assert [r.broadcast for r in rooms.runs] == keys
    assert [r.media_first_ms for r in rooms.runs] == [0, 4_500, 60_100]
    second = RunIndex.model_validate_json((tmp_path / "live" / rooms.runs[1].run / "run.json").read_bytes())
    assert second.shift_ms == 4_000 and second.tracks[0].segments[0].start_ms == 4_500
    assert room.archived_end_ms() == 61_081
    assert RoomsIndex.model_validate_json((tmp_path / "rooms.json").read_bytes()).rooms[0].runs == 3
    playlist = (tmp_path / "live" / "audio.m3u8").read_text()
    assert playlist.count("#EXT-X-DISCONTINUITY") == 2 and playlist.count("#EXT-X-MAP") == 3
    assert "#EXT-X-PROGRAM-DATE-TIME:2025-10-28T11:13:24.500Z" in playlist  # E + 4.5 s: the shift applied
    assert playlist.index("#EXT-X-GAP") < playlist.index("#EXT-X-DISCONTINUITY")  # the hole, then the new broadcast


def test_agent_slices_count_as_used_room_time(tmp_path: Path) -> None:
    from talk_tracks.archive.slices import SliceObject, TrackArchive

    archive = Archive(tmp_path)
    room = archive.room("live")
    room.epoch_ms = WALL  # an earlier broadcast set E; an agent's open slice is slice 50
    TrackArchive("live", "captions", "items", root=tmp_path).write(50, SliceObject(0, b"carry"))
    teacher(archive, "live", WALL)
    feed_audio(archive, "live", 1_000_000, 5)
    archive.close()
    assert room_index(tmp_path, "live").runs[0].media_first_ms == 205_000


def test_a_teacher_reconnecting_keeps_its_broadcast(tmp_path: Path) -> None:
    archive = Archive(tmp_path)
    room = archive.room("live")
    teacher(archive, "live")
    feed_audio(archive, "live", 1_000_000, 10)
    room.teacher_gone()  # the network dropped; the page (and its clock) stayed
    teacher(archive, "live")
    feed_audio(archive, "live", 9_000_000, 10, wall=WALL + 9_000)
    archive.close()
    rooms = room_index(tmp_path, "live")
    assert len(rooms.runs) == 1 and rooms.runs[0].media_first_ms == 1_000 and rooms.runs[0].media_last_ms == 9_180


def test_a_broadcast_without_a_clock_is_refused(tmp_path: Path) -> None:
    archive = Archive(tmp_path)
    assert not teacher(archive, "live", clock=False)
    feed_audio(archive, "live", 7_000_000, 5)
    archive.close()
    assert archive.room("live").run is None and not (tmp_path / "live" / "room.json").exists()


def test_a_restarted_archiver_continues_the_run(tmp_path: Path) -> None:
    archive = Archive(tmp_path)
    teacher(archive, "live")
    feed_audio(archive, "live", 0, 400)
    archive.close()
    archive = Archive(tmp_path)
    teacher(archive, "live")
    feed_audio(archive, "live", 8_000_000, 400, wall=WALL + 10_000)
    archive.close()
    rooms = room_index(tmp_path, "live")
    assert len(rooms.runs) == 1
    run = RunIndex.model_validate_json((run_dir(tmp_path, "live") / "run.json").read_bytes())
    segments = run.tracks[0].segments
    assert [s.start_ms for s in segments] == [0, 4000, 8000, 12000]
    assert segments[2].init == "init-2.mp4"
    playlist = (tmp_path / "live" / "audio.m3u8").read_text()
    assert playlist.count("#EXT-X-MAP") == 2 and "#EXT-X-DISCONTINUITY" not in playlist


def test_long_holes_are_a_jump_in_program_date_time(tmp_path: Path) -> None:
    archive = Archive(tmp_path)
    room = archive.room("live")
    teacher(archive, "live", WALL)
    feed_audio(archive, "live", 0, 50)
    room.teacher_gone()
    teacher(archive, "live", WALL + 86_400_000)  # the next day
    feed_audio(archive, "live", 0, 50, wall=WALL + 86_400_000)
    archive.close()
    playlist = (tmp_path / "live" / "audio.m3u8").read_text()
    assert "#EXT-X-GAP" not in playlist and "#EXT-X-PROGRAM-DATE-TIME:2025-10-29T11:13:20.000Z" in playlist


# --- slides -------------------------------------------------------------------------------------------------------


def test_slides_are_kept_once_per_change_in_room_time(tmp_path: Path) -> None:
    archive = Archive(tmp_path)
    png = base64.b64encode(b"\x89PNG fake").decode()
    room = archive.room("live")
    teacher(archive, "live")
    assert not room.slide(SlideFrame(id=0, at_ms=0, mime="image/png", data_b64=png), WALL)  # waits for the media
    feed_audio(archive, "live", 2_000_000, 5)
    assert not room.slide(SlideFrame(id=0, at_ms=0, mime="image/png", data_b64=png), WALL + 2000)
    feed_audio(archive, "live", 20_000_000, 5, wall=WALL + 20_000)
    assert room.slide(SlideFrame(id=1, at_ms=20_000, mime="image/png", data_b64=png), WALL + 20_000)
    archive.close()
    folder = run_dir(tmp_path, "live") / "slides"
    lines = [json.loads(line) for line in (folder / "frames.jsonl").read_text().splitlines()]
    assert [(line["id"], line["room_ms"]) for line in lines] == [(0, 2000), (1, 20080)]
    assert lines[0]["file"] == lines[1]["file"]
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
    teacher(archive, "live")
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
    assert "live/audio.m3u8" in bucket.objects and "live/index.m3u8" in bucket.objects
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
    assert info["lang"] == "tr" and info["kind"] == "translation" and info["status"] == "idle"
    assert w.poll() == []


def test_room_catalog_is_msf_and_lists_tracks_without_subscribing(tmp_path: Path) -> None:
    from talk_tracks.archive.catalog import CatalogFeed
    from talk_tracks.archive.slices import TrackArchive, TrackInfo

    TrackArchive("room1", "captions", "items", root=tmp_path, info=TrackInfo("captions", lang="en", lateness_ms=8000))
    tr = TrackArchive(
        "room1",
        "translate-tr",
        "items",
        root=tmp_path,
        info=TrackInfo("translation", label="Türkçe", lang="tr", depends=["captions/items"], lateness_ms=12000),
    )
    TrackArchive("room1", "chapters", "outline", root=tmp_path, info=TrackInfo("outline", depends=["captions/items"]))
    TrackArchive(
        "room1", "describe", "items", root=tmp_path, info=TrackInfo("slides", depends=["talk/room1/slides/frames"])
    )
    cat = CatalogFeed("room1", tmp_path)
    cat.agents = {"captions", "translate-tr", "chapters", "describe", "echo"}  # echo has no track.json: not listed
    assert cat.changed() is None  # no epoch yet: nothing to publish
    cat.epoch_ms, cat.shift = WALL, {"183813200000000": 0, "183813203600000": 4000}
    doc = json.loads(cat.changed() or b"")
    assert doc["version"] == "draft-01"
    assert doc["tt"]["epoch"] == WALL and doc["tt"]["shift"] == {"183813200000000": 0, "183813203600000": 4000}
    names = [(e["namespace"], e["name"]) for e in doc["tracks"]]
    assert names == [
        ("talk/room1/agents/captions", "items"),
        ("talk/room1/agents/chapters", "outline"),
        ("talk/room1/agents/describe", "items"),
        ("talk/room1/agents/translate-tr", "items"),
    ]
    captions, outline, describe, translation = doc["tracks"]
    assert captions == {
        "name": "items",
        "namespace": "talk/room1/agents/captions",
        "packaging": "eventtimeline",
        "mimeType": "application/json",
        "eventType": "urn:msf:captions:webvtt",
        "role": "caption",
        "lang": "en",
        "label": "",
        "isLive": True,
        "template": [0, 4000, [0, 0], [1, 0], WALL, 4000],
        "tt": {"dependsOn": [], "latenessMs": 8000, "cost": "paid"},
    }
    assert translation["role"] == "subtitle" and translation["label"] == "Türkçe"
    assert translation["tt"]["dependsOn"] == ["talk/room1/agents/captions/items"]
    assert describe["eventType"] == "com.talktracks.slides"
    assert describe["tt"]["dependsOn"] == ["talk/room1/slides/frames"]
    assert outline["eventType"] == "com.talktracks.outline" and "template" not in outline and "role" not in outline
    status = doc["tt"]["status"]
    assert set(status) == {"captions", "chapters", "describe", "translate-tr"}
    assert status["translate-tr"] | {"updated_ms": 0} == {
        "status": "idle",
        "producing": False,
        "capped": False,
        "fetches_served": 0,
        "backfills": 0,
        "spend_usd": 0.0,
        "updated_ms": 0,
    }
    assert cat.changed() is None
    tr.report("live", producing=True, fetches_served=3, backfills=1, spend_usd=0.0125)
    status = json.loads(cat.changed() or b"")["tt"]["status"]["translate-tr"]
    written = json.loads((tmp_path / "room1/agents/translate-tr/items/track.json").read_text())["updated_ms"]
    assert status == {
        "status": "live",
        "producing": True,
        "capped": False,
        "fetches_served": 3,
        "backfills": 1,
        "spend_usd": 0.0125,
        "updated_ms": written,
    }
    stale = cat.document(written + 15_000)
    assert stale is not None
    assert stale["tt"]["status"]["translate-tr"]["status"] == "idle"  # no heartbeat for 15 s: its agent stopped
    assert not stale["tt"]["status"]["translate-tr"]["producing"]


def test_room_catalog_marks_paid_agents_capped_from_the_ledger(tmp_path: Path) -> None:
    from talk_tracks.archive.catalog import Budget, CatalogFeed
    from talk_tracks.archive.slices import TrackArchive, TrackInfo

    TrackArchive("room1", "captions", "items", root=tmp_path, info=TrackInfo("captions")).report("live", producing=True)
    TrackArchive("room1", "echo", "items", root=tmp_path, info=TrackInfo("captions", cost="free"))
    ledger = tmp_path / "ledger.jsonl"
    ledger.write_text('{"t": 1, "usd": 1.5, "what": "asr", "room": "room1"}\n{"t": 2, "usd": 9, "room": "other"}\n')
    budget = Budget(ledger, tmp_path / "caps", ceiling_usd=100, room_cap_usd=2)
    cat = CatalogFeed("room1", tmp_path, capped=budget.capped)
    cat.agents, cat.epoch_ms = {"captions", "echo"}, WALL
    assert json.loads(cat.changed() or b"")["tt"]["status"]["captions"]["status"] == "live"
    with ledger.open("a") as f:
        f.write('{"t": 3, "usd": 0.5, "what": "llm", "room": "room1"}\n{"t": 4, "usd"')  # the last line half-written
    status = json.loads(cat.changed() or b"")["tt"]["status"]
    assert status["captions"]["status"] == "capped" and status["captions"]["capped"]
    assert not status["captions"]["producing"]
    assert status["echo"]["status"] == "idle" and not status["echo"]["capped"]  # free tracks are never capped


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
