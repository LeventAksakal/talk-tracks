"""Command line: ``python -m talk_tracks <agent> --relay URL --room ROOM [--lang xx] [--fake]``.

Agents: ``captions`` (speech to text), ``translate`` (one language per process), ``describe`` (slide descriptions),
``chapters`` (chapters, glossary and recap). Dev stand-ins: ``teacher`` publishes audio and ``slides`` publishes
slide images like the speaker's browser, ``watch`` prints what the agents publish. Demo rooms (see
wiki/howto/demo-rooms.md): ``play`` publishes a lecture file as the speaker, ``record`` records a room's agent tracks,
``generate`` does both at once, ``loop`` replays a recording as a live room, forever.

Agents are lazy (wiki/howto/lazy-agents.md): they read their inputs, and pay, only while their track has a
subscriber. ``--room`` serves one room; ``--rooms '*'`` serves every room a speaker opens and ``--rooms a,b`` the
rooms listed, each from when its speaker comes on air.

Settings also come from the environment: TT_RELAY, TT_ROOM, TT_ROOMS, TT_ROOMS_EXCLUDE (rooms never served, such as
the demo room), TT_TOKEN, TT_LEDGER (default data/ledger.jsonl), TT_SPEND_CEILING_USD (default 100), TT_ROOM_CAP_USD
(default 2: any room's cap), TT_CAPS_DIR (default data/caps: judge token batches with their own caps),
TT_WAKE_DEBOUNCE_S (default 1: how long a track stays subscribed before its agent wakes),
TT_IDLE_GRACE_S (default 10: how long a track goes unsubscribed before its agent pauses), TT_ROOM_LINGER_S (default
600: how long a room is served after its speaker left), TT_ARCHIVE_DIR (default data/archive: every slice an agent
publishes, which it serves FETCH and restarts from), TT_ARCHIVE_BUCKET (where older slices are read back from)
and the Meta key as META_API_KEY or MODEL_API_KEY. The key is never printed. In fake mode,
TT_FAKE_USD_PER_CALL makes the fake model spend pretend money into TT_FAKE_LEDGER (default data/fake-ledger.jsonl),
to try the caps.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import os
import signal
import sys
from collections.abc import AsyncGenerator, Callable, Coroutine
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .archive.slices import TrackInfo
from .contracts import (
    ITEMS_TRACK,
    OUTLINE_TRACK,
    AgentInfo,
    Carry,
    Envelope,
    OutlineSnapshot,
    Usage,
    agent_path,
    parse_room,
)
from .live_slices import HOLD_S
from .llm.base import Llm
from .llm.ledger import ROOM_CAP_USD, SpendLedger, room_cap
from .llm.meta import language_name

AGENTS = ("captions", "translate", "describe", "chapters")
DEV = ("teacher", "slides", "watch")
DEMO = ("play", "record", "generate", "loop")

FAKE_SENTENCES = [
    "Media over QUIC lets one relay fan out many named tracks.",
    "Every AI step in this talk is its own publisher.",
    "A viewer subscribes only to the tracks they want.",
    "Agents can join, leave or restart while the talk goes on.",
]


def api_key() -> str:
    key = os.environ.get("META_API_KEY") or os.environ.get("MODEL_API_KEY")
    if not key:
        sys.exit("set META_API_KEY (or MODEL_API_KEY) to call the Meta API, or pass --fake")
    return key


def spend_ledger() -> SpendLedger:
    return SpendLedger(
        Path(os.environ.get("TT_LEDGER", "data/ledger.jsonl")), float(os.environ.get("TT_SPEND_CEILING_USD", "100"))
    )


def env_float(name: str, default: float) -> float:
    return float(os.environ.get(name) or default)


def room_ledger(room: str, ledger: SpendLedger) -> SpendLedger:
    """The ledger held to ``room``'s cap: its judge batch's, or TT_ROOM_CAP_USD."""
    caps = Path(os.environ.get("TT_CAPS_DIR", "data/caps"))
    return ledger.for_room(room, room_cap(room, caps, env_float("TT_ROOM_CAP_USD", ROOM_CAP_USD)))


def make_llm(fake: bool, room: str) -> Llm:
    if fake:
        from .llm.fake import FakeLlm

        usd = env_float("TT_FAKE_USD_PER_CALL", 0)
        if usd <= 0:
            return FakeLlm()
        fake_ledger = SpendLedger(Path(os.environ.get("TT_FAKE_LEDGER", "data/fake-ledger.jsonl")), 1e9)
        return FakeLlm(room_ledger(room, fake_ledger), usd)
    from .llm.meta import MetaLlm

    return MetaLlm(api_key(), room_ledger(room, spend_ledger()))


Run = Callable[[Any, Any, Any], Coroutine[Any, Any, None]]  # (relay, track, gate) -> the agent's live loop
Backfill = Callable[[Any, Any], Any]  # (relay, track) -> live_slices.Produce, or None when slices cannot be back-filled


@dataclass
class Agent:
    """One room's agent: what it publishes, how it runs live, and how it produces a past slice."""

    info: AgentInfo
    usage: Callable[[], Usage]
    catalog: TrackInfo
    run: Run
    empty: Callable[[], Carry] | None  # an empty carry-in; None for the outline (a snapshot track)
    backfill: Backfill | None = None
    hold_s: float | None = HOLD_S


async def silence(start_ms: int, end_ms: int) -> AsyncGenerator[tuple[Any, int]]:
    """Fake mode's archived audio: the scripted recogniser goes by the media clock, not by what it hears."""
    import numpy as np

    for t in range(start_ms + 100, end_ms + 1, 100):
        yield np.zeros(1600, dtype=np.int16), t


def build(args: argparse.Namespace, room: str) -> Agent:
    """The agent for ``room``. Its inputs open only while its track is subscribed (``gate``)."""
    from . import moq, runtime
    from .contracts import CaptionsCarry, SlidesCarry, TranslationCarry
    from .cores.captions import CaptionsCore
    from .cores.outline import OutlineCore
    from .cores.slides import SlidesCore
    from .cores.translate import TranslateCore
    from .demand import gated

    lang: str = args.lang
    if args.agent == "captions":
        past: runtime.PastAudio | None
        if args.fake:
            from .asr.scripted import ScriptedAsr, demo_script

            asr: Any = ScriptedAsr(demo_script(FAKE_SENTENCES))
            model, past = "fake", silence
        else:
            from .asr.meta import MODEL, MetaVoiceAsr

            asr, model = MetaVoiceAsr(api_key(), ledger=room_ledger(room, spend_ledger())), MODEL
            past = None  # the archive has no reader for the speaker's audio yet: real captions are not back-filled

        async def transcribe(relay: Any, track: Any, gate: Any) -> None:
            core = CaptionsCore(
                lang, lines=[line for env in track.seed_envelopes() for line in runtime.caption_lines(env)]
            )
            track.carry = core.carry
            async with contextlib.aclosing(
                gated(gate, lambda: moq.teacher_audio(relay, room), f"captions {room}")
            ) as a:
                await runtime.run_captions(a, asr, track, core)

        def captions_backfill(relay: Any, track: Any) -> Any:
            if past is None:
                return None
            source = past

            async def produce(k: int) -> Any:
                return await runtime.backfill_captions(k, asr, lang, source)

            return produce

        label = f"Captions ({language_name(lang)})"
        return Agent(
            AgentInfo(name="captions", label=label, model=model),
            Usage,
            TrackInfo(kind="captions", label=label, lang=lang),
            transcribe,
            lambda: CaptionsCarry(lang=lang, lines=[]),
            captions_backfill,
        )

    llm = make_llm(args.fake, room)

    def captions(relay: Any) -> AsyncGenerator[Envelope]:
        """Subscribing here is what keeps the captions agent working for us (a downstream subscriber)."""
        return moq.follow_agent(relay, room, "captions")

    # aclosing: an agent that stops at its cap closes its input at once, which releases the track it subscribed to.
    async def translate(relay: Any, track: Any, gate: Any) -> None:
        core = TranslateCore(lang, done=runtime.translated_lines(track.seed_envelopes()))
        track.carry = core.carry
        async with contextlib.aclosing(gated(gate, lambda: captions(relay), f"translate {room}")) as lines:
            await runtime.run_translate(lines, llm, track, core)

    def translate_backfill(relay: Any, track: Any) -> Any:
        source = moq.fetch_agent_slice(relay, room, "captions")

        async def produce(k: int) -> Any:
            before = track.archive.read_local(k - 1) if k > 0 else None
            tail = runtime.translation_carry(lang, runtime.envelopes_of(before)) if before else None
            return await runtime.backfill_translate(k, llm, lang, source, tail)

        return produce

    async def describe(relay: Any, track: Any, gate: Any) -> None:
        core = SlidesCore(lang)
        core.seed(runtime.slide_notes(track.seed_envelopes()))
        track.carry = core.carry
        async with contextlib.aclosing(gated(gate, lambda: moq.slide_frames(relay, room), f"describe {room}")) as f:
            await runtime.run_describe(f, llm, track, core)

    async def chapters(relay: Any, track: Any, gate: Any) -> None:
        core = OutlineCore(lang)
        if (seed := track.seed()) is not None and isinstance(seed.body, OutlineSnapshot):
            core.seed(seed.body)
        async with contextlib.aclosing(gated(gate, lambda: captions(relay), f"chapters {room}")) as lines:
            await runtime.run_outline(lines, llm, track, core)

    usage = lambda: llm.usage  # noqa: E731
    if args.agent == "translate":
        label = f"{language_name(lang)} translation"
        return Agent(
            AgentInfo(name=f"translate-{lang}", label=label, model=llm.model),
            usage,
            TrackInfo(kind="translation", label=label, lang=lang, depends=["captions/items"]),
            translate,
            lambda: TranslationCarry(lang=lang, lines=[]),
            translate_backfill,
        )
    if args.agent == "describe":
        label = "Slide descriptions"
        return Agent(
            AgentInfo(name="describe", label=label, model=llm.model),
            usage,
            TrackInfo(kind="slides", label=label, lang=lang),
            describe,
            lambda: SlidesCarry(lang=lang, slide=None),
            None,  # past slide images are the archiver's; describing them on FETCH is not built yet
            hold_s=None,  # slides change rarely: the clock runs on between them
        )
    label = "Chapters, glossary and recap"
    return Agent(
        AgentInfo(name="chapters", label=label, model=llm.model),
        usage,
        TrackInfo(kind="outline", label=label, lang=lang, packaging="snapshot", depends=["captions/items"]),
        chapters,
        None,
    )


async def serve_room(args: argparse.Namespace, room: str) -> None:
    """One room's agent on a connection of its own, under its stable name: its track stays published, idle until
    subscribed, and answers FETCH for its history from the archive (back-filling slices never produced)."""
    from . import moq
    from .archive.slices import TrackArchive, archive_bucket
    from .demand import IDLE_GRACE_S, WAKE_DEBOUNCE_S, Gate
    from .live_slices import MediaClock, SlicedTrack, SnapshotTrack
    from .rooms import TALK_OVER

    agent = build(args, room)
    info = agent.info
    name = ITEMS_TRACK if agent.empty is not None else OUTLINE_TRACK
    archive = TrackArchive(room, info.name, name, bucket=archive_bucket(), info=agent.catalog)
    log = logging.getLogger("talk_tracks")
    async with moq.connect(args.relay, token=args.token, insecure=args.insecure) as relay:
        out = await relay.publish_sliced(agent_path(room, info.name), name)
        clock = MediaClock(hold_s=agent.hold_s)
        track: SlicedTrack | SnapshotTrack
        if agent.empty is None:
            track = SnapshotTrack(info, out, archive, agent.usage, clock=clock)
            out.serve(track.slice)
        else:
            sliced = track = SlicedTrack(info, out, archive, agent.usage, agent.empty, clock=clock)
            produce = agent.backfill(relay, sliced) if agent.backfill else None
            empty = agent.empty
            out.serve(lambda k: sliced.slice(k, produce, empty))
        gate = Gate(
            out.subscribed,
            wake_s=env_float("TT_WAKE_DEBOUNCE_S", WAKE_DEBOUNCE_S),
            grace_s=env_float("TT_IDLE_GRACE_S", IDLE_GRACE_S),
        )
        newest = archive.latest_group()
        log.info("%s in room %s, after slice %s", info.name, room, "none" if newest is None else newest)

        async def serve() -> None:
            await agent.run(relay, track, gate)
            await asyncio.Event().wait()  # stopped at a spend cap: the track stays up and says so

        async def status() -> None:
            while True:
                capped = isinstance(track, SlicedTrack) and track.capped
                archive.set_status("capped" if capped else "live" if out.subscribed() else "idle")
                await asyncio.sleep(1)

        background = [asyncio.create_task(track.run_clock()), asyncio.create_task(status())]
        try:
            await moq.until_closed(relay, serve())
        except asyncio.CancelledError as exc:
            if TALK_OVER in exc.args and isinstance(track, SlicedTrack):
                log.info("%s: the talk in room %s is over: End of Track", info.name, room)
                with contextlib.suppress(Exception):
                    await track.end()
            raise
        finally:
            for task in background:
                task.cancel()
            if isinstance(track, SlicedTrack):  # a clean stop closes the open slice; a replacement starts at the next
                with contextlib.suppress(Exception):
                    await track.pause()
            archive.set_status("idle")
            archive.close()


async def run_agent(args: argparse.Namespace) -> None:
    if args.rooms is None:
        await serve_room(args, args.room)
        return
    from . import moq
    from .rooms import ROOM_LINGER_S, RoomPolicy, serve_rooms

    policy = RoomPolicy(args.rooms, os.environ.get("TT_ROOMS_EXCLUDE", "").split(","))
    linger = env_float("TT_ROOM_LINGER_S", ROOM_LINGER_S)
    async with moq.connect(args.relay, token=args.token, insecure=args.insecure) as relay:
        logging.getLogger("talk_tracks").info("%s serving rooms %s", args.agent, args.rooms)
        rooms = serve_rooms(moq.rooms_on_air(relay), policy, lambda room: serve_room(args, room), linger_s=linger)
        await moq.until_closed(relay, rooms)


async def main_async(args: argparse.Namespace) -> None:
    if args.agent in AGENTS:
        work = run_agent(args)
    elif args.agent in DEMO:
        work = _demo(args)
    else:
        work = _dev(args)
    task = asyncio.ensure_future(work)
    # SIGTERM (docker stop) closes the session cleanly, so the relay withdraws our tracks at once.
    with contextlib.suppress(NotImplementedError):
        asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
    with contextlib.suppress(asyncio.CancelledError):
        await task


async def _dev(args: argparse.Namespace) -> None:
    from .devtools import run_dev

    await run_dev(
        args.agent,
        args.relay,
        args.room,
        token=args.token,
        insecure=args.insecure,
        wav=args.wav,
        images=args.image,
    )


async def _demo(args: argparse.Namespace) -> None:
    from . import demo
    from .slideshow import Crop

    common: dict[str, Any] = {"token": args.token, "insecure": args.insecure}
    slides = Crop.parse(args.slides) if args.slides else None
    if args.agent == "play":
        await demo.play(args.relay, args.room, need(args.media, "--media"), loops=args.loops, slides=slides, **common)
    elif args.agent == "record":
        await demo.record(args.relay, args.room, need(args.out, "--out"), media=None, **common)
    elif args.agent == "generate":
        media, out = need(args.media, "--media"), need(args.out, "--out")
        await demo.generate(
            args.relay, args.room, media, out, lead_in_s=args.lead_in_s, tail_s=args.tail_s, slides=slides, **common
        )
    else:
        await demo.loop(args.relay, args.room, need(args.recording, "--recording"), media=args.media, **common)


def need(value: Path | None, flag: str) -> Path:
    if value is None:
        sys.exit(f"{flag} is required")
    return value


def parse(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="talk_tracks", description=__doc__.splitlines()[0] if __doc__ else None)
    p.add_argument("agent", choices=AGENTS + DEV + DEMO)
    p.add_argument("--relay", default=os.environ.get("TT_RELAY"), help="moqt://host:port or https://host:port/path")
    p.add_argument("--room", default=os.environ.get("TT_ROOM"))
    p.add_argument("--rooms", default=os.environ.get("TT_ROOMS") or None, help="agents: '*' for any room, or a,b")
    p.add_argument("--lang", default="en", help="language of the output (translate: the target language)")
    p.add_argument("--token", default=os.environ.get("TT_TOKEN"), help="signed relay token for publishing")
    p.add_argument("--fake", action="store_true", help="scripted speech recognition and a fake model: no API calls")
    p.add_argument("--insecure", action="store_true", help="skip TLS verification (local relay, self-signed cert)")
    p.add_argument("--wav", type=Path, default=None, help="teacher: a 16-bit WAV file to loop instead of a tone")
    p.add_argument("--image", type=Path, action="append", default=[], help="slides: a PNG or JPEG slide (repeatable)")
    p.add_argument("--media", type=Path, default=None, help="play, generate, loop: the lecture (MP4, H.264 + Opus)")
    p.add_argument("--out", type=Path, default=None, help="record, generate: the recording directory to write")
    p.add_argument("--recording", type=Path, default=None, help="loop: the recording directory to replay")
    p.add_argument("--loops", type=int, default=None, help="play: how many times (default: forever)")
    p.add_argument("--lead-in-s", type=float, default=5.0, help="generate: wait before the lecture starts")
    p.add_argument("--tail-s", type=float, default=15.0, help="generate: keep recording after the lecture ends")
    p.add_argument(
        "--slides",
        nargs="?",
        const="full",
        default=None,
        help="play, generate: also send the slides found in the video, cropped to x,y,w,h (fractions; default full)",
    )
    args = p.parse_args(argv)
    if args.agent not in AGENTS:
        args.rooms = None
    if not args.relay or not (args.room or args.rooms):
        p.error("--relay and --room (agents: or --rooms) are required (or TT_RELAY and TT_ROOM)")
    if args.agent == "slides" and not args.image:
        p.error("slides needs at least one --image")
    if args.rooms is None:
        args.room = parse_room(args.room)
    for room in (args.rooms or "").split(","):
        if room.strip() not in ("", "*"):
            parse_room(room.strip())
    return args


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    asyncio.run(main_async(parse(argv)))
