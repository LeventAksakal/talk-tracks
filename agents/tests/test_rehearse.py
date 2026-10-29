from __future__ import annotations

import base64
import io
import json
import struct
from pathlib import Path
from typing import Any

import av
import numpy as np
import pytest

from talk_tracks.archive.mp4 import OPUS_SILENCE, Sample, TrackConfig, init_segment, media_segment
from talk_tracks.archive.store import Archive
from talk_tracks.audio import OpusEncoder, write_varint
from talk_tracks.contracts import MOQ_EPOCH_UNIX_MS, SlideFrame
from talk_tracks.rehearse import (
    JUDGE_GROUP,
    JUDGE_ROOM,
    LIVE_ROOM,
    ComposeDriver,
    RehearsalReport,
    Tokens,
    build_compose_config,
    check_monotonic_handover,
    format_markdown_summary,
    joining_fetch_count,
    make_test_png,
    mp4_top_boxes,
    pack_talk_tracks_tar,
    summarize_ledger,
    validate_hls_archive,
)


def test_make_test_png_decodes_cleanly() -> None:
    png = make_test_png(48, 32, (12, 130, 240))
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    av_any: Any = av
    with av_any.open(io.BytesIO(png)) as container:
        frames: list[Any] = list(container.decode(video=0))
    assert len(frames) == 1
    assert (frames[0].width, frames[0].height) == (48, 32)
    with pytest.raises(ValueError):
        make_test_png(0, 10)


def test_mp4_top_boxes_parses_cmaf_segments_and_rejects_truncation() -> None:
    cfg = TrackConfig("audio", "opus", sample_rate=48_000, channels=1)
    init_bytes = init_segment(cfg)
    assert mp4_top_boxes(init_bytes) == ["ftyp", "moov"]

    seg_bytes = media_segment(1, [Sample(0, 20_000, OPUS_SILENCE[1], True)])
    boxes = mp4_top_boxes(seg_bytes)
    assert "moof" in boxes and "mdat" in boxes

    # 64-bit extended box (size == 1) followed by EOF-sized box (size == 0).
    ext_box = struct.pack(">I4sQ", 1, b"uuid", 20) + b"abcd"
    eof_box = struct.pack(">I4s", 0, b"mdat") + b"xyz"
    assert mp4_top_boxes(ext_box + eof_box) == ["uuid", "mdat"]

    with pytest.raises(ValueError):
        mp4_top_boxes(init_bytes[:6])
    with pytest.raises(ValueError):
        mp4_top_boxes(struct.pack(">I4s", 100, b"ftyp") + b"short")


def test_validate_hls_archive_checks_v2_indexes_playlists_and_boxes(tmp_path: Path) -> None:
    arch = Archive(tmp_path)
    room = arch.room("rehearse")
    wall_ms = 1_761_650_000_000
    wall_us_since_moq = (wall_ms - MOQ_EPOCH_UNIX_MS) * 1000
    hang = {
        "clock": {"wall": wall_us_since_moq, "timescale": 1_000_000},
        "audio": {"renditions": {"audio": {"codec": "opus", "container": {"kind": "legacy"}}}},
    }
    assert room.catalog(json.dumps(hang).encode(), wall_ms)

    encoder = OpusEncoder()
    silence_frame = np.zeros(OpusEncoder.FRAME, dtype=np.int16)
    # Feed > 5 s of 20 ms Opus packets so the first 4 s segment closes onto disk.
    for i in range(260):
        pts_us = i * 20_000
        for pkt in encoder.encode(silence_frame):
            room.media("audio", write_varint(pts_us) + pkt, wall_ms + i * 20)

    png_b64 = base64.b64encode(make_test_png(32, 18)).decode()
    assert room.slide(SlideFrame(id=0, at_ms=wall_ms + 1000, mime="image/png", data_b64=png_b64), wall_ms + 1000)
    arch.save()

    checked = validate_hls_archive(tmp_path, "rehearse")
    assert checked.epoch_ms == wall_ms // 4000 * 4000
    assert checked.runs == 1
    assert checked.audio_segments >= 1
    assert checked.program_date_times >= 1
    assert checked.init_boxes == ["ftyp", "moov"]
    assert "moof" in checked.first_segment_boxes and "mdat" in checked.first_segment_boxes
    assert checked.slide_frames == 1


def test_check_monotonic_handover_validates_slices_and_cue_ids() -> None:
    ok = check_monotonic_handover([2, 3, 4], [5, 6], [8100, 11600, 15100], [20200, 23700])
    assert ok.monotonic_slices and ok.monotonic_cues
    assert (ok.last_slice_before, ok.first_slice_after) == (4, 5)
    assert (ok.last_cue_before, ok.first_cue_after) == (15100, 20200)

    overlap_slice = check_monotonic_handover([2, 4], [4, 5], [100], [200])
    assert not overlap_slice.monotonic_slices

    regressed_cue = check_monotonic_handover([2], [3], [500, 900], [900, 1200])
    assert not regressed_cue.monotonic_cues


def test_summarize_ledger_totals_room_group_and_backfill() -> None:
    lines = [
        {"room": "judge-cap1", "group": "judges-rehearse", "usd": 0.4, "what": "fake translate"},
        {"room": "judge-cap1", "group": "judges-rehearse", "usd": 0.4, "what": "fake translate"},
        {"room": "judge-cap1", "group": "judges-rehearse", "usd": 0.2, "backfill": True, "what": "reserved"},
        {"room": "judge-cap1", "group": "judges-rehearse", "usd": -0.2, "backfill": True, "what": "released"},
        {"room": "other", "group": "judges-rehearse", "usd": 0.4, "what": "other room"},
    ]
    summary = summarize_ledger(lines, "judge-cap1", "judges-rehearse")
    assert summary.room_usd == 0.8
    assert summary.backfill_usd == 0.0
    assert summary.group_usd == 1.2
    assert summary.entries == 4


def test_build_compose_config_is_isolated_portless_and_fake_only() -> None:
    tokens = Tokens(archive="tok-arch", agent="tok-agent", speaker="tok-spk", judge="tok-jdg", expired="tok-exp")
    cfg = build_compose_config(tokens)
    services = cfg["services"]
    for name, svc in services.items():
        assert "ports" not in svc, f"{name} must not bind host ports"
        for vol in svc.get("volumes", []):
            assert vol.startswith(("tt_data:", "auth_sock:")), f"{name} must not bind host paths: {vol}"
        env = svc.get("environment", {})
        assert "META_API_KEY" not in env and "MODEL_API_KEY" not in env

    for agent_svc in ("captions", "translate-tr", "judge-captions", "judge-translate-tr"):
        assert "--fake" in services[agent_svc]["command"]
        assert services[agent_svc]["init"] is True
        assert services[agent_svc]["stop_grace_period"] == "15s"

    assert services["judge-translate-tr"]["environment"]["TT_FAKE_USD_PER_CALL"] == "0.40"
    assert services["judge-translate-tr"]["environment"]["TT_ROOM"] == JUDGE_ROOM
    assert services["captions"]["environment"]["TT_ROOM"] == LIVE_ROOM
    assert set(cfg["volumes"]) == {"tt_data", "auth_sock"}

    tar_bytes = pack_talk_tracks_tar(Path(__file__).resolve().parents[1] / "src")
    assert b"talk_tracks/rehearse.py" in tar_bytes


def test_rfc3339_ns_and_markdown_summary_formatting() -> None:
    ns = ComposeDriver.parse_rfc3339_ns("2026-10-29T15:55:01.123456789Z")
    ns_plus_25ms = ComposeDriver.parse_rfc3339_ns("2026-10-29T15:55:01.148456789+00:00")
    assert ns_plus_25ms - ns == 25_000_000

    logs = (
        "2026-10-29 15:55:02 INFO talk_tracks.moq: joined talk/rehearse/agents/captions/items "
        "with 4 objects of the current group\n"
    )
    assert joining_fetch_count(logs, "rehearse") == 4

    report = RehearsalReport(
        measured_at_utc="2026-10-29T16:00:00Z",
        moment1={
            "idle_status": "idle",
            "idle_producing": False,
            "idle_slices": 0,
            "idle_hold_ms": 4500.0,
            "wake_first_carry_ms": 1080.0,
            "wake_first_interim_cue_ms": 1100.0,
            "wake_first_final_cue_ms": 4080.0,
            "wake_catalog_live_ms": 1650.0,
            "join_catalog_listed_ms": 1420.0,
            "join_from_container_started_ms": 980.0,
            "join_wake_carry_ms": 1090.0,
            "joining_fetch_objects": 4,
            "joined_slice": 3,
            "join_wake_cue_ms": 1120.0,
        },
        moment2_sigterm={
            "docker_stop_ms": 420.0,
            "closed_slice": 5,
            "session_withdrawn_ms": 260.0,
            "resubscribed_ms": 950.0,
            "first_object_ms": 2050.0,
            "last_slice_before": 5,
            "first_slice_after": 6,
            "first_cue_ms": 2090.0,
            "last_cue_before": 18000,
            "first_cue_after": 22100,
        },
        moment2_sigkill={
            "quic_idle_timeout_ms": 2850.0,
            "session_withdrawn_ms": 3100.0,
            "part_slice": 8,
            "first_object_ms": 4280.0,
            "last_slice_before": 8,
            "first_slice_after": 9,
            "first_cue_ms": 4310.0,
            "translate_resumed_ms": 6200.0,
            "translate_restarts": 0,
        },
        moment3={
            "fetched_slice": 2,
            "backfill_fetch_ms": 42.5,
            "backfills_before": 0,
            "backfills_after_first": 1,
            "cache_hit_fetch_ms": 8.4,
            "backfills_after_second": 1,
            "archive": {
                "epoch_ms": 1761650000000,
                "audio_segments": 7,
                "program_date_times": 7,
                "init_boxes": ["ftyp", "moov"],
                "first_segment_boxes": ["moof", "mdat"],
                "slide_frames": 2,
            },
        },
        moment4={
            "wrong_room_refused_ms": 35.0,
            "expired_token_refused_ms": 28.0,
            "pre_spend_backfill_refused_ms": 18.0,
            "live_cues_before_cap": 2,
            "catalog_spend_usd": 0.8,
            "post_cap_backfill_refused_ms": 12.0,
            "catalog_status": "capped",
            "ledger": {"group": JUDGE_GROUP},
        },
    )
    md = format_markdown_summary(report)
    assert "QUIC idle freed dead track in 2850 ms" in md
    assert "`status=capped`" in md
