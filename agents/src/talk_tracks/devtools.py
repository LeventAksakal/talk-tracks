# pyright: reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportAttributeAccessIssue=false
"""Stand-ins for the browser, to run agents end to end without one: a speaker that publishes audio, a viewer that
prints what the agents publish. They speak the same wire formats as the web app (contracts and the legacy audio
container)."""

from __future__ import annotations

import asyncio
import base64
import logging
import time
import wave
from pathlib import Path
from typing import Literal

import numpy as np
from numpy.typing import NDArray

from .audio import OpusEncoder, write_varint
from .contracts import (
    ENVELOPE,
    CaptionsState,
    SlideFrame,
    SlidesState,
    TranslationState,
    slides_path,
    teacher_path,
)
from .moq import Relay, connect, until_closed

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
    """Loop the audio at real time on ``talk/<room>/teacher`` track ``audio``, one Opus frame per group."""
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
    start = time.monotonic()
    slide_id = 0
    while True:
        for path in images:
            mime: Literal["image/png", "image/jpeg"] = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
            frame = SlideFrame(
                id=slide_id,
                at_ms=int((time.monotonic() - start) * 1000),
                mime=mime,
                data_b64=base64.b64encode(path.read_bytes()).decode(),
            )
            shown = time.monotonic()
            while time.monotonic() - shown < every_s:
                await sink.write(frame.model_dump_json().encode())
                await asyncio.sleep(2.0)
            slide_id += 1


def summary(payload: bytes) -> str:
    env = ENVELOPE.validate_json(payload)
    state = env.state
    if isinstance(state, CaptionsState):
        last = state.lines[-1] if state.lines else None
        what = (
            f"{len(state.lines)} lines, last #{last.id} ending {last.end_ms / 1000:.1f} s {last.text!r}"
            if last
            else "no lines"
        )
        what += f", interim {state.interim!r}" if state.interim else ""
    elif isinstance(state, TranslationState):
        what = (
            f"{len(state.lines)} lines, last #{state.lines[-1].id} {state.lines[-1].text!r}"
            if state.lines
            else "no lines"
        )
    elif isinstance(state, SlidesState):
        what = f"{len(state.slides)} slides, last {state.slides[-1].description!r}" if state.slides else "no slides"
    else:
        what = f"{len(state.chapters)} chapters, {len(state.glossary)} terms"
    return f"{env.agent.name}/{env.instance} seq {env.seq} ${env.usage.cost_usd:.4f}: {what}"


async def watch_room(relay: Relay, room: str) -> None:
    """Print every agent snapshot published in the room, as a viewer would receive it, with the speaker's media time
    when the snapshot arrived (from the teacher audio), so you can see the tracks keep step with the talk."""
    from .contracts import agents_prefix
    from .follow import RoomFollower
    from .replay import MediaClock

    prefix = agents_prefix(room)
    following: dict[str, asyncio.Task[None]] = {}  # agent -> the reader of its newest instance
    newest = RoomFollower()
    clock = MediaClock()

    async def media() -> None:
        async for payload in relay.objects(teacher_path(room), "audio", idle_s=5.0):
            clock.observe(payload)

    async def read(path: str) -> None:
        async for payload in relay.objects(f"{prefix}/{path}", "state"):
            stamp = f"[media {clock.ms / 1000:8.1f} s] " if clock.us is not None else ""
            print(stamp + summary(payload), flush=True)

    teacher = asyncio.create_task(media())
    try:
        async for path, active in relay.announced(prefix):
            print(f"{'announced' if active else 'withdrawn'}: {path}", flush=True)
            found = newest.offer(path) if active else None
            if found is not None:
                agent, _ = found
                if agent in following:
                    following[agent].cancel()  # replaced (a restart, or the next loop of a demo room)
                following[agent] = asyncio.create_task(read(path))
    finally:
        teacher.cancel()
        for task in following.values():
            task.cancel()


async def run_dev(
    command: str, url: str, room: str, *, token: str | None, insecure: bool, wav: Path | None, images: list[Path]
) -> None:
    async with connect(url, token=token, insecure=insecure) as relay:
        if command == "teacher":
            await until_closed(relay, publish_teacher(relay, room, load_audio_48k(wav)))
        elif command == "slides":
            await until_closed(relay, publish_slides(relay, room, images))
        else:
            await until_closed(relay, watch_room(relay, room))
