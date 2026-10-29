"""Automated Docker rehearsal for all four live architecture moments and the v2 HLS archive (decision 0015).

Runs an isolated Docker Compose stack (``-p tt-moments``, zero host ports, ephemeral ``tt_data`` volume, ``--fake``
agents only — zero Meta API calls) against ``moq-relay`` 0.17.8, ``moq auth serve`` 0.14.8, ``talk_tracks.archive``
and the lazy sliced agents:

1. **Lazy idle -> wake & mid-talk agent join:** 0 viewers keeps ``captions`` ``idle`` / ``producing: false`` with zero
   slices written; a viewer subscription wakes ``captions`` (~1 s demand debounce); starting ``translate-tr`` mid-talk
   lists it in ``talk/<room>/catalog`` and translates the open captions slice from its start via a Joining FETCH.
2. **Kill-and-restart handover (SIGTERM vs SIGKILL):** ``docker stop`` closes the open slice cleanly and withdraws the
   session at once; ``docker kill -s KILL`` mid-slice leaves ``.part`` intact, frees the track via the advertised 3 s
   QUIC idle timeout (~1-3.5 s, not 12.4 s), seeds from ``TrackArchive`` at the next slice with rising cue ids, and
   keeps ``translate-tr`` running without a restart.
3. **Selective history & HLS archive v2:** fetching an unproduced pre-join slice ``k`` of ``translate-tr`` back-fills
   it once from ``captions`` slice ``k`` and increments ``catalog.tt.status["translate-tr"].backfills``; fetching ``k``
   again hits the relay cache in <30 ms without incrementing ``backfills``; ``/data/archive/<room>/`` holds valid v2
   ``room.json``, ``index.m3u8``, ``audio.m3u8`` (with ``EXT-X-PROGRAM-DATE-TIME``), ``init-0.mp4`` and ``.m4s`` boxes.
4. **Spend cap & judge token cutoff:** signed judge tokens enforce room scope and expiry; with
   ``TT_FAKE_USD_PER_CALL=0.40`` and ``room_usd: 1.00``, the 25 % back-fill cap ($0.25) refuses unproduced FETCHes
   before any live spend, live calls stop hard at $0.80 (2 calls), subsequent slices carry ``tt.capped: true``, post-cap
   back-fill returns ``REQUEST_ERROR``, and ``talk/<room>/catalog`` reports ``status: "capped"`` and ``spend_usd: 0.8``.

Run from ``agents/``::

    uv run python -m talk_tracks.rehearse
"""

from __future__ import annotations

import argparse
import asyncio
import binascii
import contextlib
import importlib
import io
import itertools
import json
import logging
import os
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import zlib
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from .archive.slices import FINISHED, PART
from .archive.store import RoomIndex, RoomsIndex, RunIndex
from .contracts import (
    CATALOG_TRACK,
    ITEMS_TRACK,
    Cue,
    RoomCatalog,
    TrackStatus,
    agent_path,
    catalog_path,
    teacher_path,
)
from .records import cue_number, cues_of

log = logging.getLogger("talk_tracks.rehearse")

DEFAULT_PROJECT = "tt-moments"
LIVE_ROOM = "rehearse"
JUDGE_ROOM = "judge-cap1"
EXPIRED_ROOM = "judge-exp"
JUDGE_GROUP = "judges-rehearse"
JUDGE_ROOM_USD = 1.00
JUDGE_TOTAL_USD = 2.00
FAKE_USD_PER_CALL = 0.40
RELAY_IMAGE = "talk-tracks-relay:0.17.8"
AUTH_IMAGE = "talk-tracks-auth:0.14.8"
AGENTS_IMAGE = "talk-tracks-agents:dev"


# --- pure helpers & validators (unit-tested without Docker or aiomoqt) -------------------------------------------


def make_test_png(width: int = 64, height: int = 36, rgb: tuple[int, int, int] = (24, 64, 120)) -> bytes:
    """A valid RGB PNG image built with stdlib ``zlib`` for the ``slides`` stand-in."""
    if width <= 0 or height <= 0:
        raise ValueError("width and height must be positive")
    r, g, b = (max(0, min(255, c)) for c in rgb)
    row = b"\x00" + bytes((r, g, b)) * width
    raw = row * height

    def chunk(tag: bytes, body: bytes) -> bytes:
        crc = binascii.crc32(tag + body) & 0xFFFFFFFF
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")


def mp4_top_boxes(data: bytes) -> list[str]:
    """Top-level ISO BMFF four-character box types in ``data``; raises ``ValueError`` on truncated framing."""
    boxes: list[str] = []
    pos = 0
    total = len(data)
    while pos < total:
        if pos + 8 > total:
            raise ValueError(f"truncated MP4 box header at byte {pos}")
        size, raw_kind = struct.unpack(">I4s", data[pos : pos + 8])
        header = 8
        if size == 1:
            if pos + 16 > total:
                raise ValueError(f"truncated 64-bit MP4 box size at byte {pos}")
            (size,) = struct.unpack(">Q", data[pos + 8 : pos + 16])
            header = 16
        elif size == 0:
            size = total - pos
        if size < header or pos + size > total:
            raise ValueError(f"invalid MP4 box size {size} at byte {pos} (len {total})")
        boxes.append(raw_kind.decode("latin1"))
        pos += size
    return boxes


@dataclass(frozen=True)
class ArchiveCheck:
    room: str
    epoch_ms: int
    runs: int
    audio_segments: int
    program_date_times: int
    init_boxes: list[str]
    first_segment_boxes: list[str]
    slide_frames: int


def validate_hls_archive(root: Path, room: str) -> ArchiveCheck:
    """Validate v2 archive indexes, HLS multivariant/audio playlists, ``EXT-X-PROGRAM-DATE-TIME`` and fMP4 boxes."""
    rooms_doc = RoomsIndex.model_validate_json((root / "rooms.json").read_bytes())
    if rooms_doc.v != 2 or not any(entry.room == room for entry in rooms_doc.rooms):
        raise AssertionError(f"rooms.json does not list {room!r} under v=2")

    room_dir = root / room
    room_doc = RoomIndex.model_validate_json((room_dir / "room.json").read_bytes())
    if room_doc.v != 2 or room_doc.epoch_ms is None or room_doc.epoch_ms % 4000 != 0:
        raise AssertionError(f"invalid room.json epoch or version: {room_doc}")
    if not room_doc.runs:
        raise AssertionError(f"room.json for {room!r} has no runs")

    master = (room_dir / "index.m3u8").read_text(encoding="utf-8")
    if "#EXTM3U" not in master or "audio.m3u8" not in master or 'CODECS="opus"' not in master:
        raise AssertionError(f"unexpected index.m3u8:\n{master}")

    audio_m3u8 = (room_dir / "audio.m3u8").read_text(encoding="utf-8")
    lines = [line.strip() for line in audio_m3u8.splitlines() if line.strip()]
    if "#EXTM3U" not in lines or "#EXT-X-PLAYLIST-TYPE:EVENT" not in lines:
        raise AssertionError(f"unexpected audio.m3u8 header:\n{audio_m3u8}")

    map_uris = [
        line.split('URI="', 1)[1].rstrip('"')
        for line in lines
        if line.startswith('#EXT-X-MAP:URI="') and line.endswith('"')
    ]
    pdt_lines = [line for line in lines if line.startswith("#EXT-X-PROGRAM-DATE-TIME:")]
    seg_uris = [line for line in lines if not line.startswith("#") and line.endswith(".m4s")]
    if not map_uris or not pdt_lines or not seg_uris:
        raise AssertionError(f"audio.m3u8 missing MAP, PROGRAM-DATE-TIME or .m4s segments:\n{audio_m3u8}")

    init_bytes = (room_dir / map_uris[0]).read_bytes()
    init_boxes = mp4_top_boxes(init_bytes)
    if init_boxes[:2] != ["ftyp", "moov"]:
        raise AssertionError(f"init segment {map_uris[0]} boxes {init_boxes}, expected ['ftyp', 'moov']")

    first_seg_boxes: list[str] = []
    for uri in seg_uris:
        seg_bytes = (room_dir / uri).read_bytes()
        boxes = mp4_top_boxes(seg_bytes)
        if "moof" not in boxes or "mdat" not in boxes:
            raise AssertionError(f"media segment {uri} boxes {boxes}, expected 'moof' and 'mdat'")
        if not first_seg_boxes:
            first_seg_boxes = boxes

    run_doc = RunIndex.model_validate_json((room_dir / room_doc.runs[-1].run / "run.json").read_bytes())
    slide_frames = run_doc.slides.frames if run_doc.slides is not None else 0
    return ArchiveCheck(
        room=room,
        epoch_ms=room_doc.epoch_ms,
        runs=len(room_doc.runs),
        audio_segments=len(seg_uris),
        program_date_times=len(pdt_lines),
        init_boxes=init_boxes,
        first_segment_boxes=first_seg_boxes,
        slide_frames=slide_frames,
    )


@dataclass(frozen=True)
class HandoverCheck:
    last_slice_before: int
    first_slice_after: int
    last_cue_before: int
    first_cue_after: int
    monotonic_slices: bool
    monotonic_cues: bool


def check_monotonic_handover(
    before_slices: Sequence[int],
    after_slices: Sequence[int],
    before_cue_ids: Sequence[int],
    after_cue_ids: Sequence[int],
) -> HandoverCheck:
    """Verify slice numbers and decimal cue ids rise strictly across a publisher handover."""
    if not before_slices or not after_slices:
        raise ValueError("need slices before and after handover")
    if not before_cue_ids or not after_cue_ids:
        raise ValueError("need cue ids before and after handover")
    last_slice = max(before_slices)
    first_slice = min(after_slices)
    slices_ok = (
        first_slice > last_slice
        and list(before_slices) == sorted(set(before_slices))
        and list(after_slices) == sorted(set(after_slices))
    )
    last_cue = max(before_cue_ids)
    first_cue = min(after_cue_ids)
    cues_ok = (
        first_cue > last_cue
        and all(a < b for a, b in itertools.pairwise(before_cue_ids))
        and all(a < b for a, b in itertools.pairwise(after_cue_ids))
    )
    return HandoverCheck(
        last_slice_before=last_slice,
        first_slice_after=first_slice,
        last_cue_before=last_cue,
        first_cue_after=first_cue,
        monotonic_slices=slices_ok,
        monotonic_cues=cues_ok,
    )


@dataclass(frozen=True)
class LedgerSummary:
    room_usd: float
    group_usd: float
    backfill_usd: float
    entries: int


def summarize_ledger(lines: Sequence[dict[str, Any]], room: str, group: str | None = None) -> LedgerSummary:
    """Sum settled spend in ``lines`` for ``room`` and optional judge ``group``."""
    room_rows = [row for row in lines if row.get("room") == room]
    room_usd = round(sum(float(row.get("usd", 0.0)) for row in room_rows), 6)
    backfill_usd = round(sum(float(row.get("usd", 0.0)) for row in room_rows if row.get("backfill")), 6)
    group_rows = [row for row in lines if group is not None and row.get("group") == group]
    group_usd = round(sum(float(row.get("usd", 0.0)) for row in group_rows), 6)
    return LedgerSummary(room_usd=room_usd, group_usd=group_usd, backfill_usd=backfill_usd, entries=len(room_rows))


@dataclass(frozen=True)
class Tokens:
    archive: str
    agent: str
    speaker: str
    judge: str
    expired: str


def pack_talk_tracks_tar(agents_src: Path) -> bytes:
    """Pack ``agents/src/talk_tracks`` into a tar stream so containers import off native Linux ext4 (no 9P mount)."""
    pkg_dir = agents_src / "talk_tracks"
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        for path in sorted(pkg_dir.rglob("*.py")):
            rel = path.relative_to(agents_src).as_posix()
            data = path.read_bytes()
            info = tarfile.TarInfo(name=rel)
            info.size = len(data)
            info.mode = 0o644
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def build_compose_config(
    tokens: Tokens,
    *,
    live_room: str = LIVE_ROOM,
    judge_room: str = JUDGE_ROOM,
    fake_usd_per_call: float = FAKE_USD_PER_CALL,
) -> dict[str, Any]:
    """Compose configuration for ``-p tt-moments``: zero host ports, zero host mounts, ``--fake`` only."""
    common_volumes = ["tt_data:/data"]

    def agent_service(
        command: list[str],
        room: str,
        token: str,
        *,
        restart: str = "unless-stopped",
        extra_env: dict[str, str] | None = None,
        entrypoint: list[str] | None = None,
    ) -> dict[str, Any]:
        env: dict[str, str] = {
            "PYTHONPATH": "/data/py",
            "TT_RELAY": "moqt://relay:4443",
            "TT_ROOM": room,
            "TT_TOKEN": token,
            "TT_ARCHIVE_DIR": "/data/archive",
            "TT_STATE_DIR": "/data/state",
            "TT_CAPS_DIR": "/data/caps",
            "TT_FAKE_LEDGER": "/data/fake-ledger.jsonl",
            "TT_LEDGER": "/data/ledger.jsonl",
            "TT_ROOM_CAP_USD": "2",
            "TT_SPEND_CEILING_USD": "100",
        }
        if extra_env:
            env.update(extra_env)
        svc: dict[str, Any] = {
            "image": AGENTS_IMAGE,
            "init": True,
            "restart": restart,
            "stop_grace_period": "15s",
            "depends_on": ["relay"],
            "volumes": common_volumes,
            "environment": env,
            "command": command,
        }
        if entrypoint is not None:
            svc["entrypoint"] = entrypoint
        return svc

    return {
        "services": {
            "auth": {
                "image": AUTH_IMAGE,
                "network_mode": "none",
                "restart": "unless-stopped",
                "entrypoint": ["sh", "-c"],
                "command": [
                    "rm -f /run/auth/auth.sock; exec moq auth serve --listen unix:/run/auth/auth.sock "
                    "--key /data/keys/public.jwk --public-subscribe 'talk/**'"
                ],
                "volumes": ["tt_data:/data:ro", "auth_sock:/run/auth"],
            },
            "relay": {
                "image": RELAY_IMAGE,
                "restart": "unless-stopped",
                "depends_on": ["auth"],
                "volumes": ["auth_sock:/run/auth"],
                "command": [
                    "--listen",
                    "[::]:4443",
                    "--listen-tls-generate",
                    "relay,localhost",
                    "--auth-url",
                    "unix:///run/auth/auth.sock",
                    "--web-http-listen",
                    "[::]:4443",
                    "--log-level",
                    "info",
                ],
            },
            "archive": agent_service(
                ["--insecure"],
                live_room,
                tokens.archive,
                entrypoint=["python", "-m", "talk_tracks.archive"],
                extra_env={"TT_ARCHIVE_SKIP": "demo", "TT_LEDGER": "/data/fake-ledger.jsonl"},
            ),
            "teacher": agent_service(["teacher", "--insecure"], live_room, tokens.speaker, restart="no"),
            "slides": agent_service(
                ["slides", "--insecure", "--image", "/data/slides/slide1.png", "--image", "/data/slides/slide2.png"],
                live_room,
                tokens.speaker,
                restart="no",
            ),
            "captions": agent_service(["captions", "--fake", "--insecure"], live_room, tokens.agent),
            "translate-tr": agent_service(
                ["translate", "--lang", "tr", "--fake", "--insecure"], live_room, tokens.agent
            ),
            "judge-teacher": agent_service(["teacher", "--insecure"], judge_room, tokens.judge, restart="no"),
            "judge-captions": agent_service(["captions", "--fake", "--insecure"], judge_room, tokens.agent),
            "judge-translate-tr": agent_service(
                ["translate", "--lang", "tr", "--fake", "--insecure"],
                judge_room,
                tokens.agent,
                extra_env={"TT_FAKE_USD_PER_CALL": f"{fake_usd_per_call:.2f}"},
            ),
            "probe": agent_service(
                ["-m", "talk_tracks.rehearse", "--worker", "--relay", "moqt://relay:4443", "--data-dir", "/data"],
                live_room,
                "",
                restart="no",
                entrypoint=["python"],
            ),
        },
        "volumes": {
            "tt_data": {},
            "auth_sock": {},
        },
    }


@dataclass(frozen=True)
class RehearsalReport:
    measured_at_utc: str
    moment1: dict[str, Any]
    moment2_sigterm: dict[str, Any]
    moment2_sigkill: dict[str, Any]
    moment3: dict[str, Any]
    moment4: dict[str, Any]


def format_markdown_summary(report: RehearsalReport) -> str:
    """Concise Markdown table of every measured architecture moment."""
    m1 = report.moment1
    m2_term = report.moment2_sigterm
    m2_kill = report.moment2_sigkill
    m3 = report.moment3
    m4 = report.moment4
    rows = [
        (
            "1a. Lazy idle (0 viewers)",
            f"`status={m1['idle_status']}`, `producing={m1['idle_producing']}`, "
            f"`slices={m1['idle_slices']}` over {m1['idle_hold_ms']:.0f} ms on air",
        ),
        (
            "1b. Captions wake on 1st viewer",
            f"carry-in {m1['wake_first_carry_ms']:.0f} ms, 1st interim cue {m1['wake_first_interim_cue_ms']:.0f} ms, "
            f"1st final cue {m1['wake_first_final_cue_ms']:.0f} ms, catalog `live` {m1['wake_catalog_live_ms']:.0f} ms",
        ),
        (
            "1c. Mid-talk `translate-tr` join",
            f"catalog listed {m1['join_catalog_listed_ms']:.0f} ms from `up -d` "
            f"({m1['join_from_container_started_ms']:.0f} ms from container start); "
            f"wake->carry-in {m1['join_wake_carry_ms']:.0f} ms (Joining FETCH `{m1['joining_fetch_objects']}` objs of "
            f"slice {m1['joined_slice']}), wake->1st `[tr]` cue {m1['join_wake_cue_ms']:.0f} ms",
        ),
        (
            "2a. Planned handover (`SIGTERM`)",
            f"`docker stop` {m2_term['docker_stop_ms']:.0f} ms (`{m2_term['closed_slice']:08d}.slice` closed cleanly), "
            f"session withdrawn {m2_term['session_withdrawn_ms']:.0f} ms; from `start`: resubscribed "
            f"{m2_term['resubscribed_ms']:.0f} ms, carry-in {m2_term['first_object_ms']:.0f} ms "
            f"(slice {m2_term['last_slice_before']}->{m2_term['first_slice_after']}), 1st cue "
            f"{m2_term['first_cue_ms']:.0f} ms (cue {m2_term['last_cue_before']}->{m2_term['first_cue_after']})",
        ),
        (
            "2b. Crash handover (`SIGKILL`)",
            f"QUIC idle freed dead track in {m2_kill['quic_idle_timeout_ms']:.0f} ms "
            f"(withdrawn {m2_kill['session_withdrawn_ms']:.0f} ms from `kill`, "
            f"`{m2_kill['part_slice']:08d}.part` kept), "
            f"seeded carry-in {m2_kill['first_object_ms']:.0f} ms "
            f"(slice {m2_kill['last_slice_before']}->{m2_kill['first_slice_after']}), "
            f"1st cue {m2_kill['first_cue_ms']:.0f} ms, `translate-tr` resumed "
            f"{m2_kill['translate_resumed_ms']:.0f} ms (restarts={m2_kill['translate_restarts']})",
        ),
        (
            "3a. Selective history (`FETCH`)",
            f"unproduced slice {m3['fetched_slice']} back-filled in {m3['backfill_fetch_ms']:.1f} ms "
            f"(`backfills` {m3['backfills_before']}->{m3['backfills_after_first']}); "
            f"2nd FETCH relay cache hit in {m3['cache_hit_fetch_ms']:.1f} ms (<30 ms, "
            f"`backfills` stayed {m3['backfills_after_second']})",
        ),
        (
            "3b. Archive v2 & HLS output",
            f"`room.json` v=2 (`E={m3['archive']['epoch_ms']}`), {m3['archive']['audio_segments']} `.m4s` segments, "
            f"{m3['archive']['program_date_times']} `EXT-X-PROGRAM-DATE-TIME` tags, "
            f"`init`={m3['archive']['init_boxes']}, `seg`={m3['archive']['first_segment_boxes']}, "
            f"slides={m3['archive']['slide_frames']}",
        ),
        (
            "4. Spend cap & judge token cutoff",
            f"wrong-room & expired tokens refused ({m4['wrong_room_refused_ms']:.0f} ms / "
            f"{m4['expired_token_refused_ms']:.0f} ms); 25% back-fill cap ($0.25 < $0.40) refused in "
            f"{m4['pre_spend_backfill_refused_ms']:.1f} ms (`spend_usd=0.0`); live stopped after "
            f"{m4['live_cues_before_cap']} cues (`spend_usd={m4['catalog_spend_usd']:.2f}`), carry-in `capped=True`, "
            f"post-cap FETCH refused ({m4['post_cap_backfill_refused_ms']:.1f} ms), "
            f"catalog `status={m4['catalog_status']}`",
        ),
    ]
    header = f"### Measured rehearsal ({report.measured_at_utc})\n\n| Moment | Measured result |\n|---|---|\n"
    return header + "\n".join(f"| {name} | {detail} |" for name, detail in rows) + "\n"


# --- in-container MoQ worker (runs inside talk-tracks-agents:dev on the tt-moments network) ----------------------


@dataclass
class _ObjEvent:
    mono_s: float
    wall_ns: int
    sub_num: int
    group: int
    object_id: int
    payload: bytes


@dataclass
class _CatalogSnap:
    mono_s: float
    wall_ns: int
    catalog: RoomCatalog


class _CatalogWatcher:
    """Follows ``talk/<room>/catalog`` on its own reader without touching any agent track."""

    def __init__(self, relay: Any, room: str) -> None:
        self.relay = relay
        self.room = room
        self.snaps: list[_CatalogSnap] = []
        self._changed = asyncio.Condition()
        self._task = asyncio.create_task(self._run(), name=f"catalog-{room}")

    async def _run(self) -> None:
        async for payload in self.relay.objects(catalog_path(self.room), CATALOG_TRACK):
            try:
                cat = RoomCatalog.model_validate_json(payload)
            except Exception:
                continue
            snap = _CatalogSnap(mono_s=time.perf_counter(), wall_ns=time.time_ns(), catalog=cat)
            async with self._changed:
                self.snaps.append(snap)
                self._changed.notify_all()

    def latest(self) -> _CatalogSnap | None:
        return self.snaps[-1] if self.snaps else None

    async def wait_for(
        self, predicate: Callable[[_CatalogSnap], bool], *, timeout_s: float = 60.0, after_index: int = 0
    ) -> _CatalogSnap:
        async def matching() -> _CatalogSnap:
            while True:
                async with self._changed:
                    for snap in self.snaps[after_index:]:
                        if predicate(snap):
                            return snap
                    await self._changed.wait()

        return await asyncio.wait_for(matching(), timeout_s)

    def close(self) -> None:
        self._task.cancel()


class _TrackFollower:
    """Viewer subscription to one agent track with fast 100 ms resubscribe so handover timings are sharp."""

    def __init__(self, relay: Any, namespace: str, track: str, *, retry_s: float = 0.1, idle_s: float = 6.0) -> None:
        self.relay = relay
        self.namespace = namespace
        self.track = track
        self.retry_s = retry_s
        self.idle_s = idle_s
        self.events: list[_ObjEvent] = []
        self.subscribed_at: list[tuple[int, float, int]] = []
        self.withdrawn_at: list[tuple[int, float, int]] = []
        self._changed = asyncio.Condition()
        self._stop = False
        self._task = asyncio.create_task(self._run(), name=f"follow-{namespace}")

    async def _run(self) -> None:
        agent_mod: Any = importlib.import_module("aiomoqt.agent")

        ref: Any = agent_mod.TrackRef(namespace=self.namespace, name=self.track)
        sub_num = 0
        while not self._stop:
            try:
                reader: Any = await self.relay.agent.reader(
                    agent_mod.SubscribeSpec(track=ref, start_at=agent_mod.StartAt(mode="latest"), buffer=4096)
                )
            except Exception:
                await asyncio.sleep(self.retry_s)
                continue
            sub_num += 1
            async with self._changed:
                self.subscribed_at.append((sub_num, time.perf_counter(), time.time_ns()))
                self._changed.notify_all()
            last = time.perf_counter()
            try:
                while not reader.done and not self._stop:
                    batch: list[Any] = await reader.read(1, timeout=0.05) + reader.drain()
                    if batch:
                        last = time.perf_counter()
                    elif time.perf_counter() - last > self.idle_s:
                        break
                    for obj in batch:
                        if obj.payload:
                            ev = _ObjEvent(
                                mono_s=time.perf_counter(),
                                wall_ns=time.time_ns(),
                                sub_num=sub_num,
                                group=int(obj.group),
                                object_id=int(obj.object_id),
                                payload=bytes(obj.payload),
                            )
                            async with self._changed:
                                self.events.append(ev)
                                self._changed.notify_all()
            finally:
                self.relay._unsubscribe(reader, str(ref))
            async with self._changed:
                self.withdrawn_at.append((sub_num, time.perf_counter(), time.time_ns()))
                self._changed.notify_all()
            if not self._stop:
                await asyncio.sleep(self.retry_s)

    async def wait_event(
        self, predicate: Callable[[_ObjEvent], bool], *, timeout_s: float = 60.0, after_index: int = 0
    ) -> _ObjEvent:
        async def matching() -> _ObjEvent:
            while True:
                async with self._changed:
                    for ev in self.events[after_index:]:
                        if predicate(ev):
                            return ev
                    await self._changed.wait()

        return await asyncio.wait_for(matching(), timeout_s)

    async def wait_withdrawn(self, *, after_count: int, timeout_s: float = 60.0) -> tuple[int, float, int]:
        async def matching() -> tuple[int, float, int]:
            while True:
                async with self._changed:
                    if len(self.withdrawn_at) > after_count:
                        return self.withdrawn_at[after_count]
                    await self._changed.wait()

        return await asyncio.wait_for(matching(), timeout_s)

    async def wait_subscribed(self, *, after_count: int, timeout_s: float = 60.0) -> tuple[int, float, int]:
        async def matching() -> tuple[int, float, int]:
            while True:
                async with self._changed:
                    if len(self.subscribed_at) > after_count:
                        return self.subscribed_at[after_count]
                    await self._changed.wait()

        return await asyncio.wait_for(matching(), timeout_s)

    async def close(self) -> None:
        self._stop = True
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task


@dataclass
class _ArmedJoin:
    t0_mono: float
    t0_wall_ns: int
    task: asyncio.Task[dict[str, Any]]


@dataclass
class _ArmedHandover:
    t0_mono: float
    prev_sub: int
    task: asyncio.Task[dict[str, Any]]


class _Worker:
    def __init__(self, relay_url: str, data_dir: Path) -> None:
        self.relay_url = relay_url
        self.data_dir = data_dir
        self.archive_dir = data_dir / "archive"
        self.catalogs: dict[str, _CatalogWatcher] = {}
        self.followers: dict[str, _TrackFollower] = {}
        self._armed_join: _ArmedJoin | None = None
        self._armed_handover: _ArmedHandover | None = None

    def _agent_dir(self, room: str, agent: str, track: str = ITEMS_TRACK) -> Path:
        return self.archive_dir / room / "agents" / agent / track

    def _slice_files(self, room: str, agent: str, suffix: str) -> list[int]:
        folder = self._agent_dir(room, agent)
        if not folder.is_dir():
            return []
        out: list[int] = []
        for entry in folder.iterdir():
            if entry.name.endswith(suffix) and entry.stem.isdigit():
                out.append(int(entry.stem))
        return sorted(out)

    def _slice_has_final_cue(self, room: str, agent: str, group: int) -> bool:
        path = self._agent_dir(room, agent) / f"{group:08d}{FINISHED}"
        if not path.is_file():
            return False
        for idx, raw in enumerate(path.read_text(encoding="utf-8").splitlines()):
            if not raw.strip() or idx == 0:
                continue  # object 0 is carry-in; backfill translates objects[1:]
            row = json.loads(raw)
            if "t" in row and any(c.final for c in cues_of(row["t"].encode("utf-8"))[1]):
                return True
        return False

    async def handle(self, relay: Any, cmd: dict[str, Any]) -> dict[str, Any]:
        op = str(cmd["op"])
        if op == "ping":
            return {"pong": True}
        if op == "watch_catalog":
            room = str(cmd["room"])
            if room not in self.catalogs:
                self.catalogs[room] = _CatalogWatcher(relay, room)
            return {"watching": room}
        if op == "wait_catalog_idle":
            return await self._wait_catalog_idle(str(cmd["room"]), str(cmd["agent"]), float(cmd.get("hold_s", 4.5)))
        if op == "wake_captions":
            return await self._wake_captions(relay, str(cmd["room"]))
        if op == "arm_mid_talk_join":
            return self._arm_mid_talk_join(relay, str(cmd["room"]), str(cmd["agent"]))
        if op == "await_mid_talk_join":
            assert self._armed_join is not None
            return await self._armed_join.task
        if op == "wait_mid_slice":
            return await self._wait_mid_slice(str(cmd["room"]))
        if op == "arm_handover":
            return self._arm_handover(str(cmd["room"]), int(cmd["prev_sub"]))
        if op == "list_slices_disk":
            room, agent = str(cmd["room"]), str(cmd["agent"])
            return {
                "slices": self._slice_files(room, agent, FINISHED),
                "parts": self._slice_files(room, agent, PART),
            }
        if op == "await_handover":
            assert self._armed_handover is not None
            return await self._armed_handover.task
        if op == "rehearse_selective_history":
            return await self._rehearse_selective_history(relay, str(cmd["room"]), int(cmd["group"]))
        if op == "check_token_cutoffs":
            return await self._check_token_cutoffs(
                str(cmd["judge_token"]),
                str(cmd["expired_token"]),
                str(cmd["wrong_room"]),
                str(cmd["expired_room"]),
            )
        if op == "prepare_judge_room":
            return await self._prepare_judge_room(relay, str(cmd["room"]))
        if op == "rehearse_spend_cap":
            return await self._rehearse_spend_cap(relay, str(cmd["room"]), int(cmd["past_group"]))
        raise ValueError(f"unknown worker op: {op!r}")

    async def _wait_catalog_idle(self, room: str, agent: str, hold_s: float) -> dict[str, Any]:
        watcher = self.catalogs[room]
        ns = agent_path(room, agent)
        first = await watcher.wait_for(
            lambda s: any(t.namespace == ns for t in s.catalog.tracks) and agent in s.catalog.tt.status
        )
        st0: TrackStatus = first.catalog.tt.status[agent]
        if st0.status != "idle" or st0.producing:
            raise AssertionError(f"expected {agent} idle at start, got {st0}")
        t_hold = time.perf_counter()
        await asyncio.sleep(hold_s)
        held_ms = (time.perf_counter() - t_hold) * 1000.0
        latest = watcher.latest()
        assert latest is not None
        st1 = latest.catalog.tt.status[agent]
        slices = self._slice_files(room, agent, FINISHED) + self._slice_files(room, agent, PART)
        if st1.status != "idle" or st1.producing or slices:
            raise AssertionError(f"expected {agent} to stay idle with 0 slices, got {st1}, slices={slices}")
        if not (self.archive_dir / room / "room.json").is_file():
            raise AssertionError("archive did not write room.json while speaker was on air")
        return {
            "epoch_ms": latest.catalog.tt.E,
            "idle_status": st1.status,
            "idle_producing": st1.producing,
            "idle_slices": len(slices),
            "idle_hold_ms": round(held_ms, 1),
        }

    async def _wake_captions(self, relay: Any, room: str) -> dict[str, Any]:
        watcher = self.catalogs[room]
        cat_idx = len(watcher.snaps)
        t0 = time.perf_counter()
        follower = _TrackFollower(relay, agent_path(room, "captions"), ITEMS_TRACK)
        self.followers[f"{room}/captions"] = follower

        carry_ev = await follower.wait_event(lambda e: e.object_id == 0)
        note, _ = cues_of(carry_ev.payload)
        interim_ev = await follower.wait_event(lambda e: bool(cues_of(e.payload)[1]))
        final_ev = await follower.wait_event(lambda e: any(c.final for c in cues_of(e.payload)[1]))
        live_snap = await watcher.wait_for(
            lambda s: (
                "captions" in s.catalog.tt.status
                and s.catalog.tt.status["captions"].status == "live"
                and s.catalog.tt.status["captions"].producing
            ),
            after_index=cat_idx,
        )

        # Wait until at least one finished captions .slice has a final cue AND captions has moved into a later slice
        # with object_id >= 1, so Moment 1c's Joining FETCH sees an active open slice and Moment 3 has a pre-join slice.
        pre_join_slice: int | None = None
        deadline = time.perf_counter() + 60.0
        while time.perf_counter() < deadline:
            candidates = [
                g
                for g in self._slice_files(room, "captions", FINISHED)
                if self._slice_has_final_cue(room, "captions", g)
            ]
            if candidates:
                pre_join_slice = candidates[-1]
                newer = [e for e in follower.events if e.group > pre_join_slice and e.object_id >= 1]
                if newer and (self._agent_dir(room, "captions") / f"{newer[-1].group:08d}{PART}").is_file():
                    break
            await asyncio.sleep(0.1)
        if pre_join_slice is None:
            raise TimeoutError("captions did not finish a pre-join slice with a final cue in time")

        return {
            "wake_first_carry_ms": round((carry_ev.mono_s - t0) * 1000.0, 1),
            "wake_first_interim_cue_ms": round((interim_ev.mono_s - t0) * 1000.0, 1),
            "wake_first_final_cue_ms": round((final_ev.mono_s - t0) * 1000.0, 1),
            "wake_catalog_live_ms": round((live_snap.mono_s - t0) * 1000.0, 1),
            "first_slice": carry_ev.group,
            "carry_from_ms": None if note is None else note.from_,
            "pre_join_slice": pre_join_slice,
        }

    def _arm_mid_talk_join(self, relay: Any, room: str, agent: str) -> dict[str, Any]:
        watcher = self.catalogs[room]
        cat_idx = len(watcher.snaps)
        t0_mono = time.perf_counter()
        t0_wall_ns = time.time_ns()
        ns = agent_path(room, agent)

        async def run_join() -> dict[str, Any]:
            listed = await watcher.wait_for(
                lambda s: any(t.namespace == ns for t in s.catalog.tracks),
                after_index=cat_idx,
                timeout_s=60.0,
            )
            t_sub = time.perf_counter()
            follower = _TrackFollower(relay, ns, ITEMS_TRACK)
            self.followers[f"{room}/{agent}"] = follower
            carry_ev = await follower.wait_event(lambda e: e.object_id == 0, timeout_s=60.0)
            cue_ev = await follower.wait_event(
                lambda e: (
                    e.object_id >= 1 and any(c.final and c.text.startswith("[tr] ") for c in cues_of(e.payload)[1])
                ),
                timeout_s=60.0,
            )
            first_cue = next(c for c in cues_of(cue_ev.payload)[1] if c.final)
            return {
                "t0_wall_ns": t0_wall_ns,
                "listed_wall_ns": listed.wall_ns,
                "carry_wall_ns": carry_ev.wall_ns,
                "cue_wall_ns": cue_ev.wall_ns,
                "join_catalog_listed_ms": round((listed.mono_s - t0_mono) * 1000.0, 1),
                "join_wake_carry_ms": round((carry_ev.mono_s - t_sub) * 1000.0, 1),
                "join_wake_cue_ms": round((cue_ev.mono_s - t_sub) * 1000.0, 1),
                "join_total_to_cue_ms": round((cue_ev.mono_s - t0_mono) * 1000.0, 1),
                "joined_slice": carry_ev.group,
                "first_translated_cue_id": first_cue.id,
                "first_translated_text": first_cue.text,
            }

        self._armed_join = _ArmedJoin(t0_mono=t0_mono, t0_wall_ns=t0_wall_ns, task=asyncio.create_task(run_join()))
        return {"armed": True, "t0_wall_ns": t0_wall_ns}

    async def _wait_mid_slice(self, room: str) -> dict[str, Any]:
        """Wait for a fresh slice ``k`` where ``captions`` has emitted >=1 final cue overall and has an open ``.part``
        with plenty of room (>2.5 s left in the 4 s slice) so SIGTERM/SIGKILL lands mid-slice."""
        follower = self.followers[f"{room}/captions"]
        latest_sub = follower.subscribed_at[-1][0]
        await follower.wait_event(
            lambda e: e.sub_num == latest_sub and any(c.final for c in cues_of(e.payload)[1]),
            timeout_s=45.0,
        )
        idx = len(follower.events)
        carry = await follower.wait_event(lambda e: e.object_id == 0, after_index=idx, timeout_s=30.0)
        cue_ev = await follower.wait_event(
            lambda e: e.group == carry.group and e.object_id >= 1,
            after_index=idx,
            timeout_s=30.0,
        )
        part_path = self._agent_dir(room, "captions") / f"{cue_ev.group:08d}{PART}"
        if not part_path.is_file():
            raise AssertionError(f"expected open {part_path.name} mid-slice")
        return {
            "slice_before": cue_ev.group,
            "prev_sub": latest_sub,
        }

    def _arm_handover(self, room: str, prev_sub: int) -> dict[str, Any]:
        caps = self.followers[f"{room}/captions"]
        tr = self.followers[f"{room}/translate-tr"]
        withdrawn_count = len(caps.withdrawn_at)
        sub_count = len(caps.subscribed_at)
        caps_idx = len(caps.events)
        tr_idx = len(tr.events)
        t0 = time.perf_counter()

        async def run_handover() -> dict[str, Any]:
            _, t_withdrawn, withdrawn_wall_ns = await caps.wait_withdrawn(after_count=withdrawn_count, timeout_s=60.0)
            pre_events = [e for e in caps.events if e.sub_num == prev_sub]
            before_slices = sorted({e.group for e in pre_events})
            before_cues: list[int] = []
            for ev in pre_events:
                if ev.object_id == 0:
                    continue
                for cue in cues_of(ev.payload)[1]:
                    if cue.final:
                        cid = cue_number(cue)
                        if not before_cues or cid > before_cues[-1]:
                            before_cues.append(cid)
            max_cue_before = max(before_cues)

            new_sub, t_resub, resub_wall_ns = await caps.wait_subscribed(after_count=sub_count, timeout_s=60.0)
            first_obj = await caps.wait_event(
                lambda e: e.sub_num >= new_sub and e.object_id == 0,
                after_index=caps_idx,
                timeout_s=60.0,
            )
            _, seeded_carry = cues_of(first_obj.payload)
            first_cue_ev = await caps.wait_event(
                lambda e: e.sub_num >= new_sub and e.object_id >= 1 and bool(cues_of(e.payload)[1]),
                after_index=caps_idx,
                timeout_s=60.0,
            )
            first_final_ev = await caps.wait_event(
                lambda e: e.sub_num >= new_sub and e.object_id >= 1 and any(c.final for c in cues_of(e.payload)[1]),
                after_index=caps_idx,
                timeout_s=60.0,
            )
            tr_post_ev = await tr.wait_event(
                lambda e: (
                    e.object_id >= 1 and any(c.final and cue_number(c) > max_cue_before for c in cues_of(e.payload)[1])
                ),
                after_index=tr_idx,
                timeout_s=60.0,
            )

            post_events = [e for e in caps.events[caps_idx:] if e.sub_num >= new_sub]
            after_slices = sorted({e.group for e in post_events})
            after_cues: list[int] = []
            for ev in post_events:
                if ev.object_id == 0:
                    continue
                for cue in cues_of(ev.payload)[1]:
                    if cue.final:
                        cid = cue_number(cue)
                        if not after_cues or cid > after_cues[-1]:
                            after_cues.append(cid)

            check = check_monotonic_handover(before_slices, after_slices, before_cues, after_cues)
            if not check.monotonic_slices or not check.monotonic_cues:
                raise AssertionError(f"non-monotonic handover: {check}")
            if not seeded_carry:
                raise AssertionError("restarted captions carry-in had no seeded cues from TrackArchive")

            return {
                "withdrawn_wall_ns": withdrawn_wall_ns,
                "resubscribed_wall_ns": resub_wall_ns,
                "first_object_wall_ns": first_obj.wall_ns,
                "first_cue_wall_ns": first_cue_ev.wall_ns,
                "first_final_cue_wall_ns": first_final_ev.wall_ns,
                "translate_resumed_wall_ns": tr_post_ev.wall_ns,
                "session_withdrawn_ms": round((t_withdrawn - t0) * 1000.0, 1),
                "resubscribed_ms": round((t_resub - t0) * 1000.0, 1),
                "first_object_ms": round((first_obj.mono_s - t0) * 1000.0, 1),
                "first_cue_ms": round((first_cue_ev.mono_s - t0) * 1000.0, 1),
                "first_final_cue_ms": round((first_final_ev.mono_s - t0) * 1000.0, 1),
                "translate_resumed_ms": round((tr_post_ev.mono_s - t0) * 1000.0, 1),
                "seeded_carry_cues": len(seeded_carry),
                "last_slice_before": check.last_slice_before,
                "first_slice_after": check.first_slice_after,
                "last_cue_before": check.last_cue_before,
                "first_cue_after": check.first_cue_after,
            }

        self._armed_handover = _ArmedHandover(t0_mono=t0, prev_sub=prev_sub, task=asyncio.create_task(run_handover()))
        return {"armed": True}

    async def _rehearse_selective_history(self, relay: Any, room: str, group: int) -> dict[str, Any]:
        from . import moq

        watcher = self.catalogs[room]
        tr_slice_file = self._agent_dir(room, "translate-tr") / f"{group:08d}{FINISHED}"
        caps_slice_file = self._agent_dir(room, "captions") / f"{group:08d}{FINISHED}"
        if tr_slice_file.exists():
            raise AssertionError(f"expected translate-tr slice {group} to be unproduced before FETCH")
        if not caps_slice_file.is_file():
            raise AssertionError(f"expected captions slice {group} on disk before back-fill FETCH")

        latest_before = watcher.latest()
        assert latest_before is not None
        st_before = latest_before.catalog.tt.status["translate-tr"]
        backfills_before = st_before.backfills
        fetches_before = st_before.fetches_served
        cat_idx = len(watcher.snaps)

        # 1st FETCH: misses relay cache, triggers on-demand translation back-fill from captions slice k.
        t0 = time.perf_counter()
        first_payloads = await relay.fetch_group(agent_path(room, "translate-tr"), ITEMS_TRACK, group)
        backfill_ms = (time.perf_counter() - t0) * 1000.0
        if len(first_payloads) < 2:
            raise AssertionError(
                f"expected carry-in + translated cues in back-filled slice {group}, got {len(first_payloads)}"
            )
        backfilled_cues = [c for p in first_payloads[1:] for c in cues_of(p)[1] if c.final]
        if not backfilled_cues or not all(c.text.startswith("[tr] ") for c in backfilled_cues):
            raise AssertionError(f"unexpected back-filled cues: {backfilled_cues}")
        if not tr_slice_file.is_file():
            raise AssertionError("back-fill did not persist finished .slice file")

        updated_snap = await watcher.wait_for(
            lambda s: (
                "translate-tr" in s.catalog.tt.status
                and s.catalog.tt.status["translate-tr"].backfills == backfills_before + 1
            ),
            after_index=cat_idx,
            timeout_s=10.0,
        )
        st_after_first = updated_snap.catalog.tt.status["translate-tr"]

        # 2nd FETCH: use a fresh anonymous viewer connection to verify moq-relay's shared group cache (<30 ms).
        async with moq.connect(self.relay_url, insecure=True) as second_viewer:
            t1 = time.perf_counter()
            second_payloads = await second_viewer.fetch_group(agent_path(room, "translate-tr"), ITEMS_TRACK, group)
            cache_hit_ms = (time.perf_counter() - t1) * 1000.0

        if second_payloads != first_payloads:
            raise AssertionError("2nd FETCH payloads did not match 1st FETCH byte-for-byte")
        if cache_hit_ms >= 30.0:
            raise AssertionError(f"expected relay cache hit < 30 ms, got {cache_hit_ms:.1f} ms")

        # Wait past status() (0.5 s) + archive tick (1.0 s) and confirm backfills did NOT increment.
        await asyncio.sleep(1.6)
        latest_after = watcher.latest()
        assert latest_after is not None
        st_after_second = latest_after.catalog.tt.status["translate-tr"]
        if st_after_second.backfills != backfills_before + 1:
            raise AssertionError(f"backfills incremented on cache hit: {st_after_second}")

        archive_check = validate_hls_archive(self.archive_dir, room)
        return {
            "fetched_slice": group,
            "backfilled_cue_ids": [c.id for c in backfilled_cues],
            "backfill_fetch_ms": round(backfill_ms, 1),
            "cache_hit_fetch_ms": round(cache_hit_ms, 1),
            "backfills_before": backfills_before,
            "backfills_after_first": st_after_first.backfills,
            "backfills_after_second": st_after_second.backfills,
            "fetches_before": fetches_before,
            "fetches_after_first": st_after_first.fetches_served,
            "fetches_after_second": st_after_second.fetches_served,
            "archive": asdict(archive_check),
        }

    async def _check_token_cutoffs(
        self, judge_token: str, expired_token: str, wrong_room: str, expired_room: str
    ) -> dict[str, Any]:
        from . import moq

        # 1. Judge token scoped to judge-cap1 must be refused when publishing into another room.
        t0 = time.perf_counter()
        wrong_room_refused = False
        try:
            async with moq.connect(self.relay_url, token=judge_token, insecure=True) as bad_pub:
                sink = await bad_pub.publish(teacher_path(wrong_room), "audio")
                await sink.write(b"\x00")
        except Exception:
            wrong_room_refused = True
        wrong_ms = (time.perf_counter() - t0) * 1000.0
        if not wrong_room_refused:
            raise AssertionError("judge token was allowed to publish into another room")

        # 2. Expired judge token must be refused by moq auth serve at session/publish init.
        t1 = time.perf_counter()
        expired_refused = False
        try:
            async with moq.connect(self.relay_url, token=expired_token, insecure=True) as exp_pub:
                sink = await exp_pub.publish(teacher_path(expired_room), "audio")
                await sink.write(b"\x00")
        except Exception:
            expired_refused = True
        expired_ms = (time.perf_counter() - t1) * 1000.0
        if not expired_refused:
            raise AssertionError("expired judge token was accepted by relay")

        return {
            "wrong_room_refused": True,
            "wrong_room_refused_ms": round(wrong_ms, 1),
            "expired_token_refused": True,
            "expired_token_refused_ms": round(expired_ms, 1),
        }

    async def _prepare_judge_room(self, relay: Any, room: str) -> dict[str, Any]:
        if room not in self.catalogs:
            self.catalogs[room] = _CatalogWatcher(relay, room)
        watcher = self.catalogs[room]
        await watcher.wait_for(
            lambda s: any(t.namespace == agent_path(room, "captions") for t in s.catalog.tracks),
            timeout_s=60.0,
        )
        caps = _TrackFollower(relay, agent_path(room, "captions"), ITEMS_TRACK)
        self.followers[f"{room}/captions"] = caps

        deadline = time.perf_counter() + 60.0
        past_group: int | None = None
        while time.perf_counter() < deadline:
            ready = [
                g
                for g in self._slice_files(room, "captions", FINISHED)
                if self._slice_has_final_cue(room, "captions", g)
            ]
            if ready and any(e.group > ready[-1] for e in caps.events):
                past_group = ready[-1]
                break
            await asyncio.sleep(0.1)
        if past_group is None:
            raise TimeoutError("judge-captions did not finish a slice with a final cue in time")
        return {"past_group": past_group}

    async def _rehearse_spend_cap(self, relay: Any, room: str, past_group: int) -> dict[str, Any]:
        watcher = self.catalogs[room]
        ns = agent_path(room, "translate-tr")
        await watcher.wait_for(
            lambda s: any(t.namespace == ns for t in s.catalog.tracks) and "translate-tr" in s.catalog.tt.status,
            timeout_s=60.0,
        )
        # Allow TeacherFeed + RoomTime on judge-translate-tr to observe the room edge before standalone FETCH.
        await asyncio.sleep(1.2)

        # A. 25 % back-fill cap ($0.25 of $1.00) < $0.40 per call: standalone FETCH must fail with REQUEST_ERROR
        # before any live call spends a cent.
        t0 = time.perf_counter()
        pre_refused = False
        pre_error = ""
        try:
            await relay.fetch_group(ns, ITEMS_TRACK, past_group)
        except LookupError as exc:
            pre_refused = True
            pre_error = str(exc)
        pre_refused_ms = (time.perf_counter() - t0) * 1000.0
        if not pre_refused:
            raise AssertionError("expected back-fill FETCH at $0.40/call to be refused by $0.25 (25%) back-fill cap")

        # Wait > 50 ms so the viewer SUBSCRIBE is not classified as fetch-induced, then subscribe live.
        await asyncio.sleep(0.1)
        cat_idx = len(watcher.snaps)
        tr = _TrackFollower(relay, ns, ITEMS_TRACK)
        self.followers[f"{room}/translate-tr"] = tr

        # B. Live calls: $0.40 + $0.40 = $0.80 <= $1.00 (2 cues); 3rd cue ($1.20 > $1.00) caps the track!
        t_sub = time.perf_counter()
        capped_snap = await watcher.wait_for(
            lambda s: (
                "translate-tr" in s.catalog.tt.status
                and s.catalog.tt.status["translate-tr"].status == "capped"
                and not s.catalog.tt.status["translate-tr"].producing
            ),
            after_index=cat_idx,
            timeout_s=35.0,
        )
        capped_ms = (capped_snap.mono_s - t_sub) * 1000.0
        st = capped_snap.catalog.tt.status["translate-tr"]

        # Give any trailing in-flight events a moment to settle
        await asyncio.sleep(0.5)

        capped_carry: _ObjEvent | None = None
        capped_carry_ms = 0.0
        for ev in tr.events:
            if ev.object_id == 0:
                note, _ = cues_of(ev.payload)
                if note is not None and note.capped:
                    capped_carry = ev
                    capped_carry_ms = (ev.mono_s - t_sub) * 1000.0
                    break

        # Verify exactly 2 live translated cues were emitted and zero cues appear in any capped slice.
        live_cues: list[Cue] = []
        cues_in_capped_slice: list[Cue] = []
        for ev in tr.events:
            if ev.object_id == 0:
                continue
            _, found = cues_of(ev.payload)
            if capped_carry is not None and ev.group >= capped_carry.group:
                cues_in_capped_slice.extend(found)
            else:
                live_cues.extend(c for c in found if c.final)

        if len(live_cues) != 2 or cues_in_capped_slice:
            raise AssertionError(
                f"expected 2 live cues before cap and 0 after, got {len(live_cues)} before and "
                f"{len(cues_in_capped_slice)} after"
            )
        if abs(st.spend_usd - 0.8) > 1e-6:
            raise AssertionError(f"expected catalog spend_usd == 0.8, got {st.spend_usd}")

        # C. Post-cap standalone FETCH of unproduced slice must also return REQUEST_ERROR.
        t1 = time.perf_counter()
        post_refused = False
        post_error = ""
        try:
            await relay.fetch_group(ns, ITEMS_TRACK, past_group)
        except LookupError as exc:
            post_refused = True
            post_error = str(exc)
        post_refused_ms = (time.perf_counter() - t1) * 1000.0
        if not post_refused:
            raise AssertionError("expected post-cap back-fill FETCH to fail with REQUEST_ERROR")

        # D. Audit fake ledger vs real ledger on disk.
        fake_ledger_path = self.data_dir / "fake-ledger.jsonl"
        real_ledger_path = self.data_dir / "ledger.jsonl"
        if real_ledger_path.exists():
            raise AssertionError("real ledger.jsonl was touched during --fake rehearsal!")
        ledger_rows = [
            json.loads(line) for line in fake_ledger_path.read_text(encoding="utf-8").splitlines() if line.strip()
        ]
        summary = summarize_ledger(ledger_rows, room, JUDGE_GROUP)
        if abs(summary.room_usd - 0.8) > 1e-6 or abs(summary.backfill_usd) > 1e-6:
            raise AssertionError(f"unexpected fake-ledger totals: {summary}")

        return {
            "pre_spend_backfill_refused": True,
            "pre_spend_backfill_refused_ms": round(pre_refused_ms, 1),
            "pre_spend_error": pre_error,
            "live_cues_before_cap": len(live_cues),
            "time_to_capped_carry_ms": round(capped_carry_ms if capped_carry is not None else capped_ms, 1),
            "capped_slice": capped_carry.group if capped_carry is not None else 0,
            "post_cap_backfill_refused": True,
            "post_cap_backfill_refused_ms": round(post_refused_ms, 1),
            "post_cap_error": post_error,
            "catalog_status": st.status,
            "catalog_producing": st.producing,
            "catalog_spend_usd": st.spend_usd,
            "catalog_backfills": st.backfills,
            "ledger": asdict(summary),
        }

    async def aclose(self) -> None:
        for watcher in self.catalogs.values():
            watcher.close()
        for follower in self.followers.values():
            await follower.close()


async def _worker_main(relay_url: str, data_dir: Path) -> None:
    from . import moq

    worker = _Worker(relay_url, data_dir)
    async with moq.connect(relay_url, insecure=True) as relay:
        print(json.dumps({"ready": True}), flush=True)
        loop = asyncio.get_running_loop()
        try:
            while True:
                line = await loop.run_in_executor(None, sys.stdin.readline)
                if not line:
                    break
                req = json.loads(line)
                try:
                    res = await worker.handle(relay, req)
                    print(json.dumps({"ok": True, "result": res}), flush=True)
                except Exception as exc:
                    log.exception("worker command %s failed", req.get("op"))
                    print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), flush=True)
        finally:
            await worker.aclose()


def _init_data_volume(data_dir: Path, judge_room: str) -> None:
    """Create directories, two slide PNGs and the judge cap batch inside the isolated ``tt_data`` volume."""
    (data_dir / "archive").mkdir(parents=True, exist_ok=True)
    (data_dir / "state").mkdir(parents=True, exist_ok=True)
    (data_dir / "keys").mkdir(parents=True, exist_ok=True)
    slides_dir = data_dir / "slides"
    slides_dir.mkdir(parents=True, exist_ok=True)
    (slides_dir / "slide1.png").write_bytes(make_test_png(64, 36, (24, 64, 120)))
    (slides_dir / "slide2.png").write_bytes(make_test_png(64, 36, (120, 48, 24)))
    caps_dir = data_dir / "caps"
    caps_dir.mkdir(parents=True, exist_ok=True)
    cap_doc = {
        "group": JUDGE_GROUP,
        "room_usd": JUDGE_ROOM_USD,
        "total_usd": JUDGE_TOTAL_USD,
        "rooms": [judge_room],
    }
    (caps_dir / f"{JUDGE_GROUP}.json").write_text(json.dumps(cap_doc) + "\n", encoding="utf-8")


# --- host driver (orchestrates Docker Compose -p tt-moments and talks to the probe worker) -----------------------


@dataclass
class ComposeDriver:
    project: str
    compose_file: Path
    env: dict[str, str] = field(default_factory=lambda: dict(os.environ))

    def base_cmd(self) -> list[str]:
        return ["docker", "compose", "-p", self.project, "-f", str(self.compose_file)]

    def run(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [*self.base_cmd(), *args],
            env=self.env,
            text=True,
            capture_output=True,
            check=check,
        )

    def container_id(self, service: str) -> str:
        res = self.run("ps", "-a", "-q", service)
        cid = res.stdout.strip().splitlines()
        if not cid or not cid[0].strip():
            raise RuntimeError(f"no container found for service {service!r}")
        return cid[0].strip()

    def inspect(self, cid: str) -> dict[str, Any]:
        res = subprocess.run(["docker", "inspect", cid], text=True, capture_output=True, check=True)
        items: list[dict[str, Any]] = json.loads(res.stdout)
        return items[0]

    @staticmethod
    def parse_rfc3339_ns(raw: str) -> int:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        head, dot, rest = raw.partition(".")
        if not dot:
            return int(datetime.fromisoformat(raw).timestamp()) * 1_000_000_000
        tz_pos = max(rest.find("+"), rest.find("-"))
        frac, tz = (rest[:tz_pos], rest[tz_pos:]) if tz_pos >= 0 else (rest, "")
        frac9 = (frac + "000000000")[:9]
        dt = datetime.fromisoformat(f"{head}{tz}")
        return int(dt.timestamp()) * 1_000_000_000 + int(frac9)

    def started_at_ns(self, cid: str) -> int:
        return self.parse_rfc3339_ns(str(self.inspect(cid)["State"]["StartedAt"]))

    def finished_at_ns(self, cid: str) -> int:
        return self.parse_rfc3339_ns(str(self.inspect(cid)["State"]["FinishedAt"]))


class _ProbeClient:
    def __init__(self, proc: subprocess.Popen[str]) -> None:
        self.proc = proc
        assert proc.stdout is not None
        ready_line = proc.stdout.readline()
        if not ready_line:
            stderr = proc.stderr.read() if proc.stderr is not None else ""
            raise RuntimeError(f"probe worker exited before ready: {stderr}")
        ready = json.loads(ready_line)
        if not ready.get("ready"):
            raise RuntimeError(f"unexpected probe handshake: {ready}")

    def call(self, op: str, **kwargs: Any) -> dict[str, Any]:
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.proc.stdin.write(json.dumps({"op": op, **kwargs}) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            stderr = self.proc.stderr.read() if self.proc.stderr is not None else ""
            raise RuntimeError(f"probe worker EOF on {op!r}: {stderr}")
        reply = json.loads(line)
        if not reply.get("ok"):
            raise RuntimeError(f"probe {op!r} failed: {reply.get('error')}")
        result: dict[str, Any] = reply["result"]
        return result

    def close(self) -> None:
        if self.proc.stdin is not None:
            with contextlib.suppress(Exception):
                self.proc.stdin.close()
        with contextlib.suppress(Exception):
            self.proc.wait(timeout=5.0)
        if self.proc.poll() is None:
            self.proc.kill()


def _bootstrap_volume_and_tokens(project: str, agents_src: Path) -> Tokens:
    """Create ``tt_data``, copy ``talk_tracks`` onto native Linux ext4 with precompiled ``.pyc``, and sign tokens."""
    vol = f"{project}_tt_data"
    subprocess.run(
        [
            "docker",
            "volume",
            "create",
            "--label",
            f"com.docker.compose.project={project}",
            "--label",
            "com.docker.compose.volume=tt_data",
            vol,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    tar_bytes = pack_talk_tracks_tar(agents_src)
    boot_code = (
        "import compileall, io, sys, tarfile; "
        "tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()), mode='r:').extractall('/data/py', filter='data'); "
        "compileall.compile_dir('/data/py/talk_tracks', quiet=1); "
        "sys.path.insert(0, '/data/py'); "
        "from pathlib import Path; "
        "from talk_tracks.rehearse import _init_data_volume; "
        f"_init_data_volume(Path('/data'), {JUDGE_ROOM!r})"
    )
    subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "-i",
            "-v",
            f"{vol}:/data",
            "--entrypoint",
            "python",
            AGENTS_IMAGE,
            "-c",
            boot_code,
        ],
        input=tar_bytes,
        capture_output=True,
        check=True,
    )
    subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "-v",
            f"{vol}:/data",
            AUTH_IMAGE,
            "auth",
            "generate",
            "--algorithm",
            "ES256",
            "--out",
            "/data/keys/private.jwk",
            "--public",
            "/data/keys/public.jwk",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    now = int(time.time())
    exp = str(now + 3600)
    past = str(now - 120)

    def sign(*scope_args: str, expires: str = exp) -> str:
        res = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "-v",
                f"{vol}:/data:ro",
                AUTH_IMAGE,
                "auth",
                "sign",
                "--key",
                "/data/keys/private.jwk",
                *scope_args,
                "--expires",
                expires,
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        return res.stdout.strip()

    return Tokens(
        archive=sign("--publish", "talk/*/catalog", "--subscribe", "talk/**"),
        agent=sign("--publish", "talk/*/agents/**", "--subscribe", "talk/**"),
        speaker=sign(
            "--publish",
            f"talk/{LIVE_ROOM}/teacher",
            "--publish",
            f"talk/{LIVE_ROOM}/slides",
            "--subscribe",
            f"talk/{LIVE_ROOM}/**",
        ),
        judge=sign(
            "--publish",
            f"talk/{JUDGE_ROOM}/teacher",
            "--publish",
            f"talk/{JUDGE_ROOM}/slides",
            "--subscribe",
            f"talk/{JUDGE_ROOM}/**",
        ),
        expired=sign(
            "--publish",
            f"talk/{EXPIRED_ROOM}/teacher",
            "--subscribe",
            f"talk/{EXPIRED_ROOM}/**",
            expires=past,
        ),
    )


def joining_fetch_count(logs: str, room: str) -> int:
    marker = f"joined talk/{room}/agents/captions/items with "
    for line in reversed(logs.splitlines()):
        if marker in line:
            tail = line.split(marker, 1)[1]
            count_str = tail.split(" ", 1)[0]
            if count_str.isdigit():
                return int(count_str)
    return 0


def run_rehearsal(project: str = DEFAULT_PROJECT) -> RehearsalReport:
    agents_src = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="tt-moments-") as tmp:
        compose_path = Path(tmp) / "compose.yml"
        # Clean up any leftover project state before starting.
        subprocess.run(
            ["docker", "compose", "-p", project, "down", "-v", "--remove-orphans"],
            capture_output=True,
            text=True,
            check=False,
        )
        # Ensure compose uses our pre-populated volume by writing external: false (same project prefix).
        tokens = _bootstrap_volume_and_tokens(project, agents_src)
        cfg = build_compose_config(tokens)
        compose_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
        driver = ComposeDriver(project=project, compose_file=compose_path)
        probe: _ProbeClient | None = None
        try:
            log.info("[setup] starting auth + relay in project %s", project)
            driver.run("up", "-d", "auth", "relay")
            time.sleep(1.5)  # let auth bind its unix socket and relay open UDP 4443

            probe_proc = subprocess.Popen(
                [*driver.base_cmd(), "run", "--rm", "-T", "probe"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=driver.env,
            )
            probe = _ProbeClient(probe_proc)
            probe.call("watch_catalog", room=LIVE_ROOM)

            # --- Moment 1: Lazy Idle -> Wake & Mid-Talk Agent Join ------------------------------------------
            log.info("[moment 1] starting archive, captions, teacher and slides (translate-tr kept off)")
            driver.run("up", "-d", "archive", "captions", "teacher", "slides")
            idle_info = probe.call("wait_catalog_idle", room=LIVE_ROOM, agent="captions", hold_s=4.5)
            log.info(
                "[moment 1a] captions idle confirmed over %.0f ms (slices=%d)",
                idle_info["idle_hold_ms"],
                idle_info["idle_slices"],
            )

            wake_info = probe.call("wake_captions", room=LIVE_ROOM)
            log.info(
                "[moment 1b] captions woke: carry=%.0f ms, interim=%.0f ms, final=%.0f ms, catalog=%.0f ms",
                wake_info["wake_first_carry_ms"],
                wake_info["wake_first_interim_cue_ms"],
                wake_info["wake_first_final_cue_ms"],
                wake_info["wake_catalog_live_ms"],
            )

            probe.call("arm_mid_talk_join", room=LIVE_ROOM, agent="translate-tr")
            t_up = time.perf_counter()
            driver.run("up", "-d", "translate-tr")
            docker_up_ms = (time.perf_counter() - t_up) * 1000.0
            join_info = probe.call("await_mid_talk_join")
            tr_cid = driver.container_id("translate-tr")
            tr_started_ns = driver.started_at_ns(tr_cid)
            from_started_listed_ms = max(0.0, (int(join_info["listed_wall_ns"]) - tr_started_ns) / 1_000_000.0)
            tr_logs = driver.run("logs", "translate-tr").stdout
            joined_objs = joining_fetch_count(tr_logs, LIVE_ROOM)
            if joined_objs < 1:
                raise AssertionError(f"expected translate-tr Joining FETCH >= 1 objects, logs:\n{tr_logs}")

            moment1: dict[str, Any] = {
                **idle_info,
                **wake_info,
                **join_info,
                "docker_up_ms": round(docker_up_ms, 1),
                "join_from_container_started_ms": round(from_started_listed_ms, 1),
                "joining_fetch_objects": joined_objs,
            }
            log.info(
                "[moment 1c] translate-tr listed in %.0f ms (%.0f ms from StartedAt), "
                "Joining FETCH=%d objs, 1st cue=%.0f ms",
                moment1["join_catalog_listed_ms"],
                moment1["join_from_container_started_ms"],
                joined_objs,
                moment1["join_wake_cue_ms"],
            )

            # --- Moment 2a: Planned Stop (SIGTERM / docker stop) --------------------------------------------
            caps_cid = driver.container_id("captions")
            tr_before_term = driver.inspect(tr_cid)
            mid_term = probe.call("wait_mid_slice", room=LIVE_ROOM)
            probe.call("arm_handover", room=LIVE_ROOM, prev_sub=mid_term["prev_sub"])
            t_stop = time.perf_counter()
            subprocess.run(["docker", "stop", caps_cid], capture_output=True, text=True, check=True)
            stop_ms = (time.perf_counter() - t_stop) * 1000.0
            disk_term = probe.call("list_slices_disk", room=LIVE_ROOM, agent="captions")
            if disk_term["parts"] or not disk_term["slices"] or max(disk_term["slices"]) < mid_term["slice_before"]:
                raise AssertionError(f"expected SIGTERM to close active slice cleanly with 0 .part: {disk_term}")
            closed_slice = int(max(disk_term["slices"]))
            t_start = time.perf_counter()
            subprocess.run(["docker", "start", caps_cid], capture_output=True, text=True, check=True)
            start_cmd_ms = (time.perf_counter() - t_start) * 1000.0
            term_restarted_ns = driver.started_at_ns(caps_cid)
            term_handover = probe.call("await_handover")
            tr_after_term = driver.inspect(tr_cid)
            if tr_after_term["State"]["StartedAt"] != tr_before_term["State"]["StartedAt"]:
                raise AssertionError("translate-tr restarted during captions SIGTERM handover")

            moment2_sigterm: dict[str, Any] = {
                **term_handover,
                "closed_slice": closed_slice,
                "docker_stop_ms": round(stop_ms, 1),
                "docker_start_ms": round(start_cmd_ms, 1),
                "from_start_resubscribed_ms": round(
                    max(0.0, (int(term_handover["resubscribed_wall_ns"]) - term_restarted_ns) / 1_000_000.0), 1
                ),
                "from_start_first_object_ms": round(
                    max(0.0, (int(term_handover["first_object_wall_ns"]) - term_restarted_ns) / 1_000_000.0), 1
                ),
                "from_start_first_cue_ms": round(
                    max(0.0, (int(term_handover["first_cue_wall_ns"]) - term_restarted_ns) / 1_000_000.0), 1
                ),
                "translate_restarts": int(tr_after_term["RestartCount"]),
            }
            log.info(
                "[moment 2a] SIGTERM clean close verified (stop=%.0f ms, withdrawn=%.0f ms, slice %d->%d)",
                stop_ms,
                moment2_sigterm["session_withdrawn_ms"],
                moment2_sigterm["last_slice_before"],
                moment2_sigterm["first_slice_after"],
            )

            # --- Moment 2b: Hard Crash (SIGKILL / docker kill -s KILL) --------------------------------------
            caps_cid = driver.container_id("captions")
            tr_before_kill = driver.inspect(tr_cid)
            mid_kill = probe.call("wait_mid_slice", room=LIVE_ROOM)
            probe.call("arm_handover", room=LIVE_ROOM, prev_sub=mid_kill["prev_sub"])
            t_kill = time.perf_counter()
            subprocess.run(["docker", "kill", "-s", "KILL", caps_cid], capture_output=True, text=True, check=True)
            kill_cmd_ms = (time.perf_counter() - t_kill) * 1000.0
            killed_finished_ns = driver.finished_at_ns(caps_cid)
            disk_kill = probe.call("list_slices_disk", room=LIVE_ROOM, agent="captions")
            if not disk_kill["parts"] or max(disk_kill["parts"]) < mid_kill["slice_before"]:
                raise AssertionError(f"expected SIGKILL mid-slice to leave an open .part: {disk_kill}")
            part_slice = int(max(disk_kill["parts"]))
            subprocess.run(["docker", "start", caps_cid], capture_output=True, text=True, check=True)
            kill_restarted_ns = driver.started_at_ns(caps_cid)
            kill_handover = probe.call("await_handover")
            quic_idle_ms = max(0.0, (int(kill_handover["withdrawn_wall_ns"]) - killed_finished_ns) / 1_000_000.0)
            if not (500.0 <= quic_idle_ms <= 5500.0):
                raise AssertionError(
                    f"expected 3 s QUIC idle timeout (~1-4.5 s, well below 12.4 s), got {quic_idle_ms:.1f} ms"
                )
            disk_kill_after = probe.call("list_slices_disk", room=LIVE_ROOM, agent="captions")
            if part_slice not in disk_kill_after["parts"] or part_slice in disk_kill_after["slices"]:
                raise AssertionError(f"restarted captions overwrote crashed {part_slice:08d}.part: {disk_kill_after}")
            tr_after_kill = driver.inspect(tr_cid)
            if (
                tr_after_kill["Id"] != tr_before_kill["Id"]
                or tr_after_kill["State"]["StartedAt"] != tr_before_kill["State"]["StartedAt"]
                or int(tr_after_kill["RestartCount"]) != 0
            ):
                raise AssertionError("translate-tr restarted during captions SIGKILL recovery")

            moment2_sigkill: dict[str, Any] = {
                **kill_handover,
                "quic_idle_timeout_ms": round(quic_idle_ms, 1),
                "part_slice": part_slice,
                "docker_kill_ms": round(kill_cmd_ms, 1),
                "from_kill_first_object_ms": round(
                    max(0.0, (int(kill_handover["first_object_wall_ns"]) - killed_finished_ns) / 1_000_000.0), 1
                ),
                "from_kill_first_cue_ms": round(
                    max(0.0, (int(kill_handover["first_cue_wall_ns"]) - killed_finished_ns) / 1_000_000.0), 1
                ),
                "from_restart_first_object_ms": round(
                    max(0.0, (int(kill_handover["first_object_wall_ns"]) - kill_restarted_ns) / 1_000_000.0), 1
                ),
                "translate_restarts": int(tr_after_kill["RestartCount"]),
            }
            log.info(
                "[moment 2b] SIGKILL recovery verified: QUIC idle=%.0f ms (withdrawn=%.0f ms), slice %d->%d",
                quic_idle_ms,
                float(kill_handover["session_withdrawn_ms"]),
                moment2_sigkill["last_slice_before"],
                moment2_sigkill["first_slice_after"],
            )

            # --- Moment 3: Selective History (FETCH Back-Fill + Relay Cache) & HLS Archive ------------------
            log.info("[moment 3] testing FETCH back-fill + relay cache hit on slice %d", wake_info["pre_join_slice"])
            moment3 = probe.call(
                "rehearse_selective_history",
                room=LIVE_ROOM,
                group=int(wake_info["pre_join_slice"]),
            )
            log.info(
                "[moment 3] back-fill=%.1f ms, 2nd FETCH cache hit=%.1f ms (<30 ms), HLS segments=%d",
                moment3["backfill_fetch_ms"],
                moment3["cache_hit_fetch_ms"],
                moment3["archive"]["audio_segments"],
            )

            # --- Moment 4: Spend Cap & Judge Token Cutoff ---------------------------------------------------
            log.info("[moment 4] testing judge token cutoffs + $0.40/call against $1.00 room cap ($0.25 backfill cap)")
            token_cutoffs = probe.call(
                "check_token_cutoffs",
                judge_token=tokens.judge,
                expired_token=tokens.expired,
                wrong_room=LIVE_ROOM,
                expired_room=EXPIRED_ROOM,
            )
            driver.run("up", "-d", "judge-teacher", "judge-captions")
            judge_prep = probe.call("prepare_judge_room", room=JUDGE_ROOM)
            driver.run("up", "-d", "judge-translate-tr")
            cap_info = probe.call("rehearse_spend_cap", room=JUDGE_ROOM, past_group=int(judge_prep["past_group"]))
            moment4: dict[str, Any] = {**token_cutoffs, **judge_prep, **cap_info}
            log.info(
                "[moment 4] capped verified: status=%s, spend_usd=%.2f, live_cues=%d",
                moment4["catalog_status"],
                moment4["catalog_spend_usd"],
                moment4["live_cues_before_cap"],
            )

            return RehearsalReport(
                measured_at_utc=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                moment1=moment1,
                moment2_sigterm=moment2_sigterm,
                moment2_sigkill=moment2_sigkill,
                moment3=moment3,
                moment4=moment4,
            )
        except Exception:
            ps_out = driver.run("ps", "-a", check=False).stdout
            logs_out = driver.run("logs", "--tail", "80", check=False).stdout
            log.error("rehearsal failed; compose ps:\n%s\ncompose logs:\n%s", ps_out, logs_out)
            raise
        finally:
            log.info("[teardown] tearing down Docker Compose project %s (-v)", project)
            if probe is not None:
                probe.close()
            driver.run("down", "-v", "--remove-orphans", check=False)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="talk_tracks.rehearse", description=__doc__.splitlines()[0] if __doc__ else None)
    p.add_argument("--project", default=DEFAULT_PROJECT, help="isolated Docker Compose project name")
    p.add_argument("--json-out", type=Path, default=None, help="optional path to write the full JSON report")
    p.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--relay", default="moqt://relay:4443", help=argparse.SUPPRESS)
    p.add_argument("--data-dir", type=Path, default=Path("/data"), help=argparse.SUPPRESS)
    p.add_argument("--init-data", type=Path, default=None, help=argparse.SUPPRESS)
    p.add_argument("--judge-room", default=JUDGE_ROOM, help=argparse.SUPPRESS)
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    args = parse_args(argv)
    if args.init_data is not None:
        _init_data_volume(args.init_data, args.judge_room)
        return
    if args.worker:
        asyncio.run(_worker_main(args.relay, args.data_dir))
        return
    report = run_rehearsal(project=args.project)
    if args.json_out is not None:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(asdict(report), indent=2) + "\n", encoding="utf-8")
    print("\n" + format_markdown_summary(report), flush=True)


if __name__ == "__main__":
    main()
