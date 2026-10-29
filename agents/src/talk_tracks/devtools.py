# pyright: reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportAttributeAccessIssue=false
"""Stand-ins for the browser and the room service, to run agents end to end without them: a speaker that publishes
audio with its hang catalog clock, a room catalog with the room epoch, a viewer that prints what the agents publish.
They speak the same wire formats as the web app (contracts, the hang catalog and the legacy audio container)."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
import wave
from pathlib import Path
from typing import Literal

import numpy as np
from numpy.typing import NDArray

from .audio import OpusEncoder, write_varint
from .contracts import (
    CATALOG_TRACK,
    MOQ_EPOCH_UNIX_MS,
    SLICE_MS,
    CatalogTrack,
    RoomCatalog,
    RoomTt,
    SlideFrame,
    agents_prefix,
    catalog_path,
    slides_path,
    teacher_path,
)
from .moq import HANG_CATALOG, Relay, connect, teacher_clock, until_closed
from .records import cues_of, outline_of, slides_of

log = logging.getLogger("talk_tracks.dev")


def load_audio_48k(path: Path | None, seconds: float = 10.0) -> NDArray[np.int16]:
    """A WAV file (mono or stereo, any rate) resampled to 48 kHz mono, or a quiet tone when no file is given."""
    if path is None:
        t = np.arange(int(48_000 * seconds)) / 48_000
        return (np.sin(2 * np.pi * 220 * t) * 3000).astype(np.int16)
    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError("expected 16-bit PCM WAV")
        rate, channels = w.getframerate(), w.getnchannels()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).reshape(-1, channels).mean(axis=1)
    positions = np.arange(0, len(pcm), rate / 48_000)
    return np.interp(positions, np.arange(len(pcm)), pcm).astype(np.int16)


async def publish_teacher(relay: Relay, room: str, pcm48k: NDArray[np.int16]) -> None:
    """Loop the audio at real time on ``talk/<room>/teacher`` track ``audio``, one Opus frame per group, with a hang
    ``catalog.json`` whose root ``clock`` says when PTS zero was, as @moq/publish writes it (repeated every 2 s)."""
    wall_us = (time.time_ns() // 1000) - MOQ_EPOCH_UNIX_MS * 1000
    hang = {"audio": {"renditions": {"audio": {"codec": "opus", "container": {"kind": "legacy"}}}}}
    catalog = json.dumps({**hang, "clock": {"wall": wall_us, "timescale": 1_000_000}}).encode()
    catalog_sink = await relay.publish(teacher_path(room), HANG_CATALOG)

    async def repeat_catalog() -> None:
        while True:
            await catalog_sink.write(catalog)
            await asyncio.sleep(2.0)

    repeating = asyncio.create_task(repeat_catalog())
    try:
        await _loop_audio(relay, room, pcm48k)
    finally:
        repeating.cancel()


async def _loop_audio(relay: Relay, room: str, pcm48k: NDArray[np.int16]) -> None:
    sink = await relay.publish(teacher_path(room), "audio")
    encoder = OpusEncoder()
    frame = OpusEncoder.FRAME
    start = time.monotonic()
    i = 0
    while True:
        offset = (i * frame) % (len(pcm48k) - frame)
        for packet in encoder.encode(pcm48k[offset : offset + frame]):
            await sink.write(write_varint(i * 20_000) + packet)
        i += 1
        await asyncio.sleep(max(0.0, start + i * 0.02 - time.monotonic()))


async def publish_slides(relay: Relay, room: str, images: list[Path], every_s: float = 20.0) -> None:
    """Show each image as a slide for ``every_s``, in a loop, on ``talk/<room>/slides`` track ``frames``.

    The current slide is repeated every 2 s, as the speaker console does, so an agent that subscribes late gets it.
    """
    sink = await relay.publish(slides_path(room), "frames")
    slide_id = 0
    while True:
        for path in images:
            mime: Literal["image/png", "image/jpeg"] = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
            frame = SlideFrame(
                id=slide_id,
                at_ms=time.time_ns() // 1_000_000,  # the browser stamps wall time
                mime=mime,
                data_b64=base64.b64encode(path.read_bytes()).decode(),
            )
            shown = time.monotonic()
            while time.monotonic() - shown < every_s:
                await sink.write(frame.model_dump_json().encode())
                await asyncio.sleep(2.0)
            slide_id += 1


async def publish_room_catalog(relay: Relay, room: str) -> None:
    """Stand in for the room service's room catalog (design §5.10): ``E`` from the first teacher broadcast, rounded
    down to a slice, and a shift of 0 for every broadcast, published every 2 s. No skew guard and no track list."""
    sink = await relay.publish(catalog_path(room), CATALOG_TRACK)
    epoch: int | None = None
    shift: dict[str, int] = {}
    while True:
        clock = await teacher_clock(relay, room, wait_s=2.0)
        if clock is not None:
            if epoch is None:
                first = MOQ_EPOCH_UNIX_MS + clock.wall * 1000 // clock.timescale
                epoch = first // SLICE_MS * SLICE_MS
            shift.setdefault(clock.key, 0)
        if epoch is not None:
            catalog = RoomCatalog(tracks=list[CatalogTrack](), tt=RoomTt(E=epoch, shift=shift))
            await sink.write(catalog.model_dump_json(exclude_none=True).encode())
        await asyncio.sleep(2.0)


def summary(agent: str, group: int, object_id: int, payload: bytes) -> str:
    where = f"{agent} {group}/{object_id}"
    if agent == "chapters":
        records = outline_of(payload) or []
        return f"{where}: outline of {len(records)} records"
    if agent == "describe":
        note, slides = slides_of(payload)
        what = ", ".join(f"slide {s.id} at {s.at / 1000:.1f} s {s.text[:40]!r}" for s in slides)
    else:
        note, cues = cues_of(payload)
        what = ", ".join(
            f"{'final' if c.final else 'interim'} {c.id} r{c.rev} {c.start / 1000:.1f}-{c.end / 1000:.1f} s {c.text!r}"
            for c in cues
        )
    flags = (
        ""
        if note is None
        else f" [{'capped ' if note.capped else ''}{'from ' + str(note.from_) if note.from_ is not None else ''}]"
    )
    return f"{where}{flags}: {what or '(empty)'}"


async def watch_room(relay: Relay, room: str, agents: list[str]) -> None:
    """Print every object the room's agents publish, as a viewer subscribed to their tracks receives them."""

    async def read(agent: str) -> None:
        track = "outline" if agent == "chapters" else "items"
        async for _, group, object_id, payload in relay.located(f"{agents_prefix(room)}/{agent}", track):
            print(summary(agent, group, object_id, payload), flush=True)

    await asyncio.gather(*(read(a) for a in agents))


async def run_dev(
    command: str,
    url: str,
    room: str,
    *,
    token: str | None,
    insecure: bool,
    wav: Path | None,
    images: list[Path],
    agents: list[str] | None = None,
) -> None:
    async with connect(url, token=token, insecure=insecure) as relay:
        if command == "teacher":
            await until_closed(relay, publish_teacher(relay, room, load_audio_48k(wav)))
        elif command == "slides":
            await until_closed(relay, publish_slides(relay, room, images))
        elif command == "catalog":
            await until_closed(relay, publish_room_catalog(relay, room))
        else:
            await until_closed(relay, watch_room(relay, room, agents or ["captions"]))
