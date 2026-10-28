import itertools
from pathlib import Path

import pytest

from talk_tracks.audio import split_legacy
from talk_tracks.lecture import AUDIO_TRACK, VIDEO_TRACK, avc_codec, catalog, clock, legacy_frame, packets, probe

from .clip import make_clip


@pytest.fixture(scope="module")
def clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_clip(tmp_path_factory.mktemp("clip") / "lecture.mp4")


def test_probe_reads_codec_size_and_duration(clip: Path) -> None:
    info = probe(clip)
    assert info.video is not None and info.audio is not None
    assert info.video.codec.startswith("avc1.") and (info.video.width, info.video.height) == (64, 48)
    assert info.audio.sample_rate == 48_000 and info.audio.channels == 1
    assert 1900 <= info.duration_ms <= 2100


def test_packets_start_with_a_keyframe_and_keep_one_a_second(clip: Path) -> None:
    video = [p for p in packets(clip) if p.kind == "video"]
    audio = [p for p in packets(clip) if p.kind == "audio"]
    assert video[0].keyframe and video[0].file_us == 0
    assert [p.file_us for p in video if p.keyframe] == [0, 1_000_000]
    assert all(b.file_us >= a.file_us for a, b in itertools.pairwise(video))  # no B-frames
    assert len(audio) >= 95  # 20 ms packets


def test_catalog_names_the_tracks_the_player_and_agents_read(clip: Path) -> None:
    info = probe(clip)
    root = catalog(info, {"talk_tracks": {"loop": 3}})
    video = root["video"]
    audio = root["audio"]
    assert isinstance(video, dict) and isinstance(audio, dict)
    assert set(video["renditions"]) == {VIDEO_TRACK}  # pyright: ignore[reportUnknownArgumentType]
    assert audio["renditions"][AUDIO_TRACK]["container"] == {"kind": "legacy"}  # pyright: ignore[reportUnknownMemberType]
    assert root["talk_tracks"] == {"loop": 3}
    assert "clock" not in root
    assert catalog(info, wall_ms=1_790_812_800_000)["clock"] == clock(1_790_812_800_000)


def test_legacy_frame_round_trips_through_the_agents_reader() -> None:
    assert split_legacy(legacy_frame(123_456_789, b"opus")) == (123_456_789, b"opus")


def test_codec_string_comes_from_the_avcc_record() -> None:
    assert avc_codec(bytes([1, 0x64, 0x00, 0x1F, 0xFF])) == "avc1.64001f"
    with pytest.raises(ValueError):
        avc_codec(b"\x00\x00\x00\x01")  # Annex B: not prepared


def test_the_hang_clock_counts_microseconds_from_2020() -> None:
    assert clock(1_790_812_800_000) == {"wall": 212_976_000_000_000, "timescale": 1_000_000}
    assert clock(1_577_836_800_000)["wall"] == 0
    with pytest.raises(ValueError):
        clock(1_577_836_799_999)
