"""The agent loops: what each agent does with its inputs, live and for a back-filled slice. Transport-free, so tests
run them without a relay.

Live loops publish through a ``SlicedTrack`` (or the outline's ``SnapshotTrack``), which cuts 4 s slices at the
input watermark and records every object (design §4). Inputs are gated by demand (``demand.gated``): ``None`` marks
a pause, while nobody subscribes to the agent's track. Every input is already in room time: audio chunks end at a
room ms, captions are cues, slide frames come with the room ms they appeared at.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from .asr.base import AsrEvent, AsrProvider, AsrSession
from .audio import SAMPLE_RATE
from .contracts import SLICE_MS, Cue, SlideFrame
from .cores.captions import CaptionsCore
from .cores.outline import OutlineCore
from .cores.slides import SlidesCore
from .cores.translate import TranslateCore
from .live_slices import SlicedTrack, SnapshotTrack
from .llm.base import Llm
from .llm.ledger import BudgetExceededError
from .records import cues_of, line_of

log = logging.getLogger("talk_tracks")

CONTEXT_CUES = 3

Pcm = tuple[NDArray[np.int16], int]  # 16 kHz mono PCM and the room time its last sample ends at, in ms


@dataclass(frozen=True)
class CaptionsObject:
    """One object of the captions track as another agent reads it: where it sits and its cues."""

    group: int
    object_id: int
    cues: list[Cue]


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def captions_object(group: int, object_id: int, payload: bytes) -> CaptionsObject:
    return CaptionsObject(group, object_id, cues_of(payload)[1])


def observe_captions(track: SlicedTrack | SnapshotTrack, obj: CaptionsObject) -> None:
    """A downstream agent's watermark follows the captions it reads: each slice's start, each cue's end."""
    track.clock.observe(obj.group * SLICE_MS)
    for cue in obj.cues:
        track.clock.observe(cue.end)


# --- captions ------------------------------------------------------------------------------------------------


async def run_captions(
    audio: AsyncIterator[Pcm | None], asr: AsrProvider, track: SlicedTrack, core: CaptionsCore
) -> None:
    """Audio (pcm, room end ms) in; cues out, interim revisions as a cue grows, then the final one.

    The ASR session opens on the first audio, so its clock starts at that chunk's room time, and reopens on the next
    chunk after any failure (a dropped stream, the server's session cap): captions pause for a moment, never stop.
    A pause (``None``) closes the session, so nothing is paid while nobody reads the captions. Past a spend cap the
    track carries on with capped slices.
    """
    session: AsrSession | None = None

    async def apply(events: list[AsrEvent], at_ms: int) -> None:
        for event in events:
            for cue in core.on_event(event, at_ms):
                await track.item(cue)

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
        # Stopping (SIGTERM, the room is closed): publish nothing more, or the cue would open a slice the
        # replacement then has to skip. It shows in the replacement's carry-in once its ASR hears it again.
        if session is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(session.close(), 1)
        raise
    await close(last_ms)


# --- translation ---------------------------------------------------------------------------------------------


async def run_translate(
    captions: AsyncIterator[CaptionsObject | None], llm: Llm, track: SlicedTrack, core: TranslateCore
) -> None:
    """Each final caption cue, translated once, with the same id.

    The first object after a (re)start is the Joining FETCH's: the whole current captions slice from its carry-in,
    so the translation starts at that slice's start (design §5.1). Earlier cues are left untranslated.
    """
    context: list[str] = []
    resumed = True
    async for obj in captions:
        if obj is None:
            resumed = True
            await track.pause()
            continue
        if resumed:
            core.skip_before(obj.group * SLICE_MS)
            resumed = False
        observe_captions(track, obj)
        track.wake()
        await track.tick()
        for cue in core.pending(obj.cues):
            try:
                text = await llm.translate(cue.text, lang=core.lang, context=context)
            except BudgetExceededError as exc:
                log.warning("translate capped: %s", exc)
                await track.cap()
                return
            except Exception:
                log.exception("translate failed for cue %s", cue.id)
                continue
            await track.item(core.add(cue, text))
            context.append(cue.text)
            del context[:-CONTEXT_CUES]


async def backfill_translate(
    llm: Llm, lang: str, captions: Sequence[bytes], before: Sequence[Cue]
) -> tuple[list[Cue], list[Cue]]:
    """A translation slice from its captions slice (objects fetched through the relay): each final cue of the slice
    translated, latest revision only. The carry-in is the end of the slice before when this track has it, else empty
    (no paid call for it)."""
    context = [c.text for c in cues_of(captions[0])[1]] if captions else []
    newest: dict[str, Cue] = {}
    for payload in captions[1:]:
        for cue in cues_of(payload)[1]:
            if cue.final and (cue.id not in newest or cue.rev >= newest[cue.id].rev):
                newest[cue.id] = cue
    core = TranslateCore(lang)
    out: list[Cue] = []
    for cue in sorted(newest.values(), key=lambda c: c.start):
        text = await llm.translate(cue.text, lang=lang, context=context[-CONTEXT_CUES:])
        out.append(core.add(cue, text))
        context.append(cue.text)
    return list(before), out


# --- slide descriptions --------------------------------------------------------------------------------------


async def run_describe(
    frames: AsyncIterator[tuple[SlideFrame, int] | None], llm: Llm, track: SlicedTrack, core: SlidesCore
) -> None:
    """Slide frames, each with the room ms it appeared at, in; one record per new slide out."""
    lang = core.lang
    async for item in frames:
        if item is None:
            await track.pause()
            continue
        frame, at_ms = item
        track.clock.observe(at_ms)
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
        await track.item(core.add(frame, at_ms, text))


# --- chapters, glossary and recap ------------------------------------------------------------------------------


async def run_outline(
    captions: AsyncIterator[CaptionsObject | None],
    llm: Llm,
    track: SnapshotTrack,
    core: OutlineCore,
    *,
    clock: Callable[[], int] = now_ms,
) -> None:
    lang = core.lang
    watermark = 0
    async for obj in captions:
        if obj is None:
            continue
        observe_captions(track, obj)
        finals = [c for c in obj.cues if c.final]
        core.add_lines([line_of(c) for c in finals])
        watermark = max([watermark, *(c.end for c in finals)])
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
        await track.publish(core.records(watermark))


__all__ = [
    "CaptionsObject",
    "backfill_translate",
    "captions_object",
    "now_ms",
    "run_captions",
    "run_describe",
    "run_outline",
    "run_translate",
]
