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
600: how long a room is served after its speaker left), TT_STATE_DIR (default data/state: where captions keeps its
lines across a restart) and the Meta key as META_API_KEY or MODEL_API_KEY. The key is never printed. In fake mode,
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
from pathlib import Path
from typing import Any

from .contracts import AgentInfo, CaptionsState, Usage, agent_path, parse_room
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


Work = Callable[[Any, Any, Any], Coroutine[Any, Any, None]]  # (relay, publisher, gate) -> the agent's loop


def build(args: argparse.Namespace, room: str) -> tuple[AgentInfo, Callable[[], Usage], Work]:
    """The agent for ``room``. Its inputs open only while its track is subscribed (``gate``)."""
    from . import moq, runtime
    from .demand import gated

    lang: str = args.lang
    if args.agent == "captions":
        if args.fake:
            from .asr.scripted import ScriptedAsr, demo_script

            asr: Any = ScriptedAsr(demo_script(FAKE_SENTENCES))
            model = "fake"
        else:
            from .asr.meta import MODEL, MetaVoiceAsr

            asr, model = MetaVoiceAsr(api_key(), ledger=room_ledger(room, spend_ledger())), MODEL

        from . import statefile

        saved = Path(os.environ.get("TT_STATE_DIR", "data/state")) / f"captions-{room}-{lang}.json"

        async def transcribe(relay: Any, pub: Any, gate: Any) -> None:
            async with contextlib.aclosing(
                gated(gate, lambda: moq.teacher_audio(relay, room), f"captions {room}")
            ) as a:
                await runtime.run_captions(
                    a, asr, pub, lang, resume=statefile.load_captions(saved), save=lambda s: statefile.save(saved, s)
                )

        return AgentInfo(name="captions", label=f"Captions ({language_name(lang)})", model=model), Usage, transcribe

    llm = make_llm(args.fake, room)

    async def captions(relay: Any) -> AsyncGenerator[CaptionsState]:
        """Subscribing here is what keeps the captions agent working for us (a downstream subscriber)."""
        async for envelope in moq.follow_agent(relay, room, "captions"):
            if isinstance(envelope.state, CaptionsState):
                yield envelope.state

    # aclosing: an agent that stops at its cap closes its input at once, which releases the track it subscribed to.
    async def translate(relay: Any, pub: Any, gate: Any) -> None:
        async with contextlib.aclosing(gated(gate, lambda: captions(relay), f"translate {room}")) as lines:
            await runtime.run_translate(lines, llm, pub, lang)

    async def describe(relay: Any, pub: Any, gate: Any) -> None:
        async with contextlib.aclosing(gated(gate, lambda: moq.slide_frames(relay, room), f"describe {room}")) as f:
            await runtime.run_describe(f, llm, pub, lang)

    async def chapters(relay: Any, pub: Any, gate: Any) -> None:
        async with contextlib.aclosing(gated(gate, lambda: captions(relay), f"chapters {room}")) as lines:
            await runtime.run_outline(lines, llm, pub, lang)

    if args.agent == "translate":
        info = AgentInfo(name=f"translate-{lang}", label=f"{language_name(lang)} translation", model=llm.model)
        return info, lambda: llm.usage, translate
    if args.agent == "describe":
        return AgentInfo(name="describe", label="Slide descriptions", model=llm.model), lambda: llm.usage, describe
    info = AgentInfo(name="chapters", label="Chapters, glossary and recap", model=llm.model)
    return info, lambda: llm.usage, chapters


async def serve_room(args: argparse.Namespace, room: str) -> None:
    """One room's agent on a connection of its own: its track stays published, and idle until subscribed."""
    from . import moq
    from .demand import IDLE_GRACE_S, WAKE_DEBOUNCE_S, Gate
    from .publisher import SnapshotPublisher
    from .runtime import now_ms, run_with_heartbeat

    info, usage, work = build(args, room)
    instance = str(now_ms())
    async with moq.connect(args.relay, token=args.token, insecure=args.insecure) as relay:
        sink = await relay.publish(agent_path(room, info.name, instance), "state")
        pub = SnapshotPublisher(info, sink, usage, instance=instance)
        gate = Gate(
            sink.subscribed,
            wake_s=env_float("TT_WAKE_DEBOUNCE_S", WAKE_DEBOUNCE_S),
            grace_s=env_float("TT_IDLE_GRACE_S", IDLE_GRACE_S),
        )
        logging.getLogger("talk_tracks").info("%s instance %s in room %s", info.name, instance, room)

        async def serve() -> None:
            await work(relay, pub, gate)
            await asyncio.Event().wait()  # stopped at a spend cap: the track stays up and says so

        await moq.until_closed(relay, run_with_heartbeat(pub, asyncio.ensure_future(serve())))


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
