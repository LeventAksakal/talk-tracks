"""The agent loops: what each agent does with its inputs. Transport-free, so tests run them without a relay."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Callable

import numpy as np
from numpy.typing import NDArray

from .asr.base import AsrProvider, AsrSession
from .contracts import CaptionLine, CaptionsState, SlideFrame
from .cores.captions import CaptionsCore
from .cores.outline import OutlineCore
from .cores.slides import SlidesCore
from .cores.translate import TranslateCore
from .llm.base import Llm
from .publisher import SnapshotPublisher

log = logging.getLogger("talk_tracks")

HEARTBEAT_S = 2.0


def now_ms() -> int:
    return time.time_ns() // 1_000_000


async def heartbeat_loop(pub: SnapshotPublisher, every_s: float = HEARTBEAT_S) -> None:
    while True:
        await asyncio.sleep(every_s)
        await pub.heartbeat()


async def run_captions(
    audio: AsyncIterator[tuple[NDArray[np.int16], int]],
    asr: AsrProvider,
    pub: SnapshotPublisher,
    lang: str,
    *,
    next_id: int = 0,
) -> None:
    """Audio (pcm, media end ms) in; the captions state out. A line that finishes publishes at once."""
    core = CaptionsCore(lang, next_id)
    session: AsrSession = await asr.open(lang)
    await pub.publish(core.state())
    try:
        async for pcm, end_ms in audio:
            changed = False
            for event in await session.feed(pcm, end_ms):
                core.on_event(event)
                changed = True
            if changed:
                await pub.publish(core.state())
    finally:
        for event in await session.close():
            core.on_event(event)
        await pub.publish(core.state())


async def run_translate(captions: AsyncIterator[CaptionsState], llm: Llm, pub: SnapshotPublisher, lang: str) -> None:
    core = TranslateCore(lang)
    context: list[str] = []
    await pub.publish(core.state())
    async for state in captions:
        for line in core.pending(state.lines):
            try:
                text = await llm.translate(line.text, lang=lang, context=context)
            except Exception:
                log.exception("translate failed for line %s", line.id)
                continue
            core.add(line.id, text)
            context.append(line.text)
            del context[:-3]
            await pub.publish(core.state())


async def run_describe(frames: AsyncIterator[SlideFrame], llm: Llm, pub: SnapshotPublisher, lang: str) -> None:
    import base64

    core = SlidesCore(lang)
    await pub.publish(core.state())
    async for frame in frames:
        if not core.wants(frame):
            continue
        try:
            text = await llm.describe_slide(base64.b64decode(frame.data_b64), frame.mime, lang=lang)
        except Exception:
            log.exception("describe failed for slide %s", frame.id)
            continue
        core.add(frame, text)
        await pub.publish(core.state())


async def run_outline(
    captions: AsyncIterator[CaptionsState],
    llm: Llm,
    pub: SnapshotPublisher,
    lang: str,
    *,
    clock: Callable[[], int] = now_ms,
) -> None:
    core = OutlineCore(lang)
    await pub.publish(core.state())
    async for state in captions:
        core.add_lines(state.lines)
        if not core.due(clock()):
            continue
        lines, previous = core.request(clock())
        try:
            draft = await llm.outline(lines, previous, lang=lang)
        except Exception:
            log.exception("outline failed")
            continue
        core.apply(draft)
        await pub.publish(core.state())


async def run_with_heartbeat(pub: SnapshotPublisher, work: asyncio.Future[None] | asyncio.Task[None]) -> None:
    beat = asyncio.create_task(heartbeat_loop(pub))
    try:
        await work
    finally:
        beat.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await beat


__all__ = [
    "CaptionLine",
    "heartbeat_loop",
    "now_ms",
    "run_captions",
    "run_describe",
    "run_outline",
    "run_translate",
    "run_with_heartbeat",
]
