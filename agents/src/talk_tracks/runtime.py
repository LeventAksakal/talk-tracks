"""The agent loops: what each agent does with its inputs. Transport-free, so tests run them without a relay."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Callable

import numpy as np
from numpy.typing import NDArray

from .asr.base import AsrEvent, AsrProvider, AsrSession
from .audio import SAMPLE_RATE
from .contracts import CaptionLine, CaptionsState, SlideFrame
from .cores.captions import CaptionsCore
from .cores.outline import OutlineCore
from .cores.slides import SlidesCore
from .cores.translate import TranslateCore
from .llm.base import Llm
from .llm.ledger import BudgetExceededError
from .publisher import SnapshotPublisher

log = logging.getLogger("talk_tracks")

HEARTBEAT_S = 2.0
BACKLOG_LINES = 2  # a translation switched on mid-talk starts with the last lines, not the whole history

# Inputs are gated by demand (demand.gated): ``None`` marks a pause, while nobody subscribes to the agent's track.


def capped_notice(exc: BudgetExceededError) -> str:
    return "paused: this room reached its spend cap" if exc.scope != "ceiling" else "paused: the spend limit is reached"


def now_ms() -> int:
    return time.time_ns() // 1_000_000


async def heartbeat_loop(pub: SnapshotPublisher, every_s: float = HEARTBEAT_S) -> None:
    while True:
        await asyncio.sleep(every_s)
        await pub.heartbeat()


async def run_captions(
    audio: AsyncIterator[tuple[NDArray[np.int16], int] | None],
    asr: AsrProvider,
    pub: SnapshotPublisher,
    lang: str,
    *,
    resume: CaptionsState | None = None,
    save: Callable[[CaptionsState], None] | None = None,
) -> None:
    """Audio (pcm, media end ms) in; the captions state out. A line that finishes publishes at once.

    The ASR session opens on the first audio, so its clock starts at that chunk's media time, and reopens on the next
    chunk after any failure (a dropped stream, the server's session cap): captions pause for a moment, never stop.
    ``resume`` is the state a previous run saved through ``save``: a restarted agent carries on with its lines and ids.
    A pause (``None``) closes the session, so nothing is paid while nobody reads the captions. Past a spend cap the
    agent says so on its track and stops.
    """
    core = CaptionsCore(lang, lines=resume.lines if resume else ())
    session: AsrSession | None = None
    await pub.publish(core.state())

    async def apply(events: list[AsrEvent]) -> None:
        made = [line for event in events if (line := core.on_event(event))]
        if events:
            await pub.publish(core.state())
        if made and save:
            save(core.state())

    async def close() -> None:
        nonlocal session
        if session is not None:
            with contextlib.suppress(Exception):
                await apply(await session.close())
            session = None

    try:
        async for chunk in audio:
            if chunk is None:
                await close()
                continue
            pcm, end_ms = chunk
            try:
                if session is None:
                    session = await asr.open(lang, offset_ms=max(0, end_ms - len(pcm) * 1000 // SAMPLE_RATE))
                await apply(await session.feed(pcm, end_ms))
            except BudgetExceededError as exc:
                log.warning("captions stop: %s", exc)
                await close()
                await pub.notice(capped_notice(exc))
                return
            except Exception:
                log.exception("ASR session failed; reopening on the next audio")
                await close()
    finally:
        if session is not None:
            await apply(await session.close())


async def run_translate(
    captions: AsyncIterator[CaptionsState | None], llm: Llm, pub: SnapshotPublisher, lang: str
) -> None:
    """Each new caption line, translated once. After a pause the translation picks up at the last few lines."""
    core = TranslateCore(lang)
    context: list[str] = []
    await pub.publish(core.state())
    resumed = True
    async for state in captions:
        if state is None:
            resumed = True
            continue
        if resumed:
            core.skip_to(state.lines, keep=BACKLOG_LINES)
            resumed = False
        for line in core.pending(state.lines):
            try:
                text = await llm.translate(line.text, lang=lang, context=context)
            except BudgetExceededError as exc:
                log.warning("translate stops: %s", exc)
                await pub.notice(capped_notice(exc))
                return
            except Exception:
                log.exception("translate failed for line %s", line.id)
                continue
            core.add(line.id, text)
            context.append(line.text)
            del context[:-3]
            await pub.publish(core.state())


async def run_describe(frames: AsyncIterator[SlideFrame | None], llm: Llm, pub: SnapshotPublisher, lang: str) -> None:
    import base64

    core = SlidesCore(lang)
    await pub.publish(core.state())
    async for frame in frames:
        if frame is None or not core.wants(frame):
            continue
        text = core.known(frame)
        if text is None:
            try:
                text = await llm.describe_slide(base64.b64decode(frame.data_b64), frame.mime, lang=lang)
            except BudgetExceededError as exc:
                log.warning("describe stops: %s", exc)
                await pub.notice(capped_notice(exc))
                return
            except Exception:
                log.exception("describe failed for slide %s", frame.id)
                continue
        core.add(frame, text)
        await pub.publish(core.state())


async def run_outline(
    captions: AsyncIterator[CaptionsState | None],
    llm: Llm,
    pub: SnapshotPublisher,
    lang: str,
    *,
    clock: Callable[[], int] = now_ms,
) -> None:
    core = OutlineCore(lang)
    await pub.publish(core.state())
    async for state in captions:
        if state is None:
            continue
        core.add_lines(state.lines)
        if not core.due(clock()):
            continue
        lines, previous = core.request(clock())
        try:
            draft = await llm.outline(lines, previous, lang=lang)
        except BudgetExceededError as exc:
            log.warning("chapters stop: %s", exc)
            await pub.notice(capped_notice(exc))
            return
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
