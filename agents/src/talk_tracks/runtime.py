"""The agent loops: what each agent does with its inputs, live and for a back-filled slice. Transport-free, so tests
run them without a relay.

Live loops publish through a ``SlicedTrack`` (or the outline's ``SnapshotTrack``), which cuts 4 s slices on the media
clock and records every object (decision 0012). Inputs are gated by demand (``demand.gated``): ``None`` marks a
pause, while nobody subscribes to the agent's track. Back-fill functions produce one past slice when a FETCH asks
for it; they are charged to the same room cap.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable

import numpy as np
from numpy.typing import NDArray

from .asr.base import AsrEvent, AsrFinal, AsrProvider, AsrSession
from .audio import SAMPLE_RATE
from .contracts import (
    CARRY_LINES,
    SLICE_MS,
    CaptionItem,
    CaptionLine,
    CaptionsCarry,
    Envelope,
    SlideFrame,
    SlideItem,
    SlideNote,
    SlidesCarry,
    TranslatedLine,
    TranslationCarry,
    TranslationItem,
)
from .cores.captions import CaptionsCore
from .cores.outline import OutlineCore
from .cores.slides import SlidesCore
from .cores.translate import TranslateCore
from .llm.base import Llm
from .llm.ledger import BudgetExceededError
from .slicing import SlicedTrack, SnapshotTrack, envelopes_of

log = logging.getLogger("talk_tracks")

BACKLOG_LINES = 2  # a translation switched on mid-talk starts with the last lines, not the whole history
LOOKBACK_MS = 8_000  # a back-filled captions slice hears this much before it, to finish lines that began earlier
CONTEXT_LINES = 3

Pcm = tuple[NDArray[np.int16], int]  # 16 kHz mono PCM and the media time its last sample ends at, in ms
PastAudio = Callable[[int, int], AsyncIterator[Pcm]]  # the archived speaker audio of media time [start, end) ms
FetchSlice = Callable[[int], Awaitable[list[Envelope] | None]]  # another agent's slice k, by FETCH


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def caption_lines(env: Envelope, *, interim: bool = False) -> list[CaptionLine]:
    """The caption lines an object of the captions track carries: the carry-in's, or the item's (final ones only,
    unless ``interim``)."""
    body = env.body
    if isinstance(body, CaptionsCarry):
        return list(body.lines)
    if isinstance(body, CaptionItem) and (body.final or interim):
        return [body.line]
    return []


def translated_lines(envelopes: list[Envelope]) -> list[TranslatedLine]:
    out: list[TranslatedLine] = []
    for env in envelopes:
        if isinstance(env.body, TranslationCarry):
            out += env.body.lines
        elif isinstance(env.body, TranslationItem):
            out.append(env.body.line)
    return out


def translation_carry(lang: str, envelopes: list[Envelope]) -> TranslationCarry:
    """The carry-in that follows a slice: its last lines."""
    lines = {line.id: line for line in translated_lines(envelopes)}
    return TranslationCarry(lang=lang, lines=[lines[i] for i in sorted(lines)][-CARRY_LINES:])


def slide_notes(envelopes: list[Envelope]) -> list[SlideNote]:
    notes = [env.body.slide for env in envelopes if isinstance(env.body, SlidesCarry | SlideItem)]
    return [note for note in notes if note is not None]


def observe_captions(track: SlicedTrack | SnapshotTrack, env: Envelope) -> None:
    """A downstream agent's media clock follows the captions it reads."""
    track.clock.observe(env.slice * SLICE_MS)
    if isinstance(env.body, CaptionItem):
        track.clock.observe(env.body.line.end_ms)


# --- captions ------------------------------------------------------------------------------------------------


async def run_captions(
    audio: AsyncIterator[Pcm | None], asr: AsrProvider, track: SlicedTrack, core: CaptionsCore
) -> None:
    """Audio (pcm, media end ms) in; caption items out, an interim version as a line grows, then the final one.

    The ASR session opens on the first audio, so its clock starts at that chunk's media time, and reopens on the next
    chunk after any failure (a dropped stream, the server's session cap): captions pause for a moment, never stop.
    A pause (``None``) closes the session, so nothing is paid while nobody reads the captions. Past a spend cap the
    track carries on with capped slices.
    """
    session: AsrSession | None = None

    async def apply(events: list[AsrEvent], at_ms: int) -> None:
        for event in events:
            if (item := core.on_event(event, at_ms)) is not None:
                await track.item(item)

    async def close(at_ms: int) -> None:
        nonlocal session
        if session is not None:
            with contextlib.suppress(Exception):
                await apply(await session.close(), at_ms)
            session = None

    last_ms = 0
    try:
        async for chunk in audio:
            if chunk is None:
                await close(last_ms)
                await track.pause()
                continue
            pcm, last_ms = chunk
            track.clock.observe(last_ms)
            track.wake()
            await track.tick()  # open the slice before this audio changes the state its carry-in shows
            try:
                if session is None:
                    session = await asr.open(core.lang, offset_ms=max(0, last_ms - len(pcm) * 1000 // SAMPLE_RATE))
                await apply(await session.feed(pcm, last_ms), last_ms)
            except BudgetExceededError as exc:
                log.warning("captions capped: %s", exc)
                await close(last_ms)
                await track.cap()
                return
            except Exception:
                log.exception("ASR session failed; reopening on the next audio")
                await close(last_ms)
    except asyncio.CancelledError:
        # Stopping (SIGTERM, the talk is over): publish nothing more, or the line would open a slice the
        # replacement then has to skip. It shows in the replacement's carry-in once its ASR hears it again.
        if session is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(session.close(), 1)
        raise
    await close(last_ms)


async def backfill_captions(
    k: int, asr: AsrProvider, lang: str, past: PastAudio
) -> tuple[CaptionsCarry, list[CaptionItem]]:
    """Captions slice k from the archived audio: the lines that end inside it, and the ones before as its carry-in.
    Only final lines: nobody watched the interim versions of a slice that was never live."""
    start, end = k * SLICE_MS, (k + 1) * SLICE_MS
    core = CaptionsCore(lang)
    session = await asr.open(lang, offset_ms=0)
    lines: list[CaptionLine] = []
    try:
        async for pcm, end_ms in past(max(0, start - LOOKBACK_MS), end):
            for event in await session.feed(pcm, end_ms):
                item = core.on_event(event, end_ms) if isinstance(event, AsrFinal) else None
                if item is not None:
                    lines.append(item.line)
    finally:
        with contextlib.suppress(Exception):
            await session.close()  # what it still holds ends after the slice
    carry = CaptionsCarry(lang=lang, lines=[line for line in lines if line.end_ms < start][-CARRY_LINES:])
    inside = [CaptionItem(lang=lang, line=line, final=True) for line in lines if start <= line.end_ms < end]
    return carry, inside


# --- translation ---------------------------------------------------------------------------------------------


async def run_translate(
    captions: AsyncIterator[Envelope | None], llm: Llm, track: SlicedTrack, core: TranslateCore
) -> None:
    """Each new final caption line, translated once. After a pause the translation picks up at the last few lines."""
    context: list[str] = []
    resumed = True
    async for env in captions:
        if env is None:
            resumed = True
            await track.pause()
            continue
        observe_captions(track, env)
        track.wake()
        await track.tick()
        lines = caption_lines(env)
        if resumed and lines:
            core.skip_to(lines, keep=BACKLOG_LINES)
            resumed = False
        for line in core.pending(lines):
            try:
                text = await llm.translate(line.text, lang=core.lang, context=context)
            except BudgetExceededError as exc:
                log.warning("translate capped: %s", exc)
                await track.cap()
                return
            except Exception:
                log.exception("translate failed for line %s", line.id)
                continue
            await track.item(core.add(line, text))
            context.append(line.text)
            del context[:-CONTEXT_LINES]


async def backfill_translate(
    k: int, llm: Llm, lang: str, captions: FetchSlice, before: TranslationCarry | None
) -> tuple[TranslationCarry, list[TranslationItem]]:
    """Translation slice k: captions slice k by FETCH (which back-fills captions in turn), each final line translated.
    The carry-in is the end of slice k-1 when this track has it, else empty (no paid call for it)."""
    envelopes = await captions(k)
    if envelopes is None:
        raise LookupError(f"captions slice {k} is not available")
    lines: dict[int, CaptionLine] = {}
    context: list[str] = []
    for env in envelopes:
        for line in caption_lines(env):
            if env.kind == "carry":
                context.append(line.text)
            else:
                lines[line.id] = line
    core = TranslateCore(lang)
    items: list[TranslationItem] = []
    for line in [lines[i] for i in sorted(lines)]:
        items.append(core.add(line, await llm.translate(line.text, lang=lang, context=context[-CONTEXT_LINES:])))
        context.append(line.text)
    return before or TranslationCarry(lang=lang, lines=[]), items


# --- slide descriptions --------------------------------------------------------------------------------------


async def run_describe(
    frames: AsyncIterator[SlideFrame | None], llm: Llm, track: SlicedTrack, core: SlidesCore
) -> None:
    lang = core.lang
    async for frame in frames:
        if frame is None:
            await track.pause()
            continue
        track.clock.observe(frame.at_ms)
        track.wake()
        await track.tick()
        if not core.wants(frame):
            continue
        text = core.known(frame)
        if text is None:
            try:
                text = await llm.describe_slide(base64.b64decode(frame.data_b64), frame.mime, lang=lang)
            except BudgetExceededError as exc:
                log.warning("describe capped: %s", exc)
                await track.cap()
                return
            except Exception:
                log.exception("describe failed for slide %s", frame.id)
                continue
        await track.item(core.add(frame, text))


# --- chapters, glossary and recap ------------------------------------------------------------------------------


async def run_outline(
    captions: AsyncIterator[Envelope | None],
    llm: Llm,
    track: SnapshotTrack,
    core: OutlineCore,
    *,
    clock: Callable[[], int] = now_ms,
) -> None:
    lang = core.lang
    async for env in captions:
        if env is None:
            continue
        observe_captions(track, env)
        core.add_lines(caption_lines(env))
        if not core.due(clock()):
            continue
        lines, previous = core.request(clock())
        try:
            draft = await llm.outline(lines, previous, lang=lang)
        except BudgetExceededError as exc:
            log.warning("chapters stop: %s", exc)
            return
        except Exception:
            log.exception("outline failed")
            continue
        core.apply(draft)
        await track.publish(core.snapshot())


__all__ = [
    "backfill_captions",
    "backfill_translate",
    "caption_lines",
    "envelopes_of",
    "now_ms",
    "run_captions",
    "run_describe",
    "run_outline",
    "run_translate",
]
