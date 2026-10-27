"""Command line: ``python -m talk_tracks <agent> --relay URL --room ROOM [--lang xx] [--fake]``.

Agents: ``captions`` (speech to text), ``translate`` (one language per process), ``describe`` (slide descriptions),
``chapters`` (chapters, glossary and recap). Dev stand-ins: ``teacher`` publishes audio and ``slides`` publishes
slide images like the speaker's browser, ``watch`` prints what the agents publish.

Settings also come from the environment: TT_RELAY, TT_ROOM, TT_TOKEN, TT_LEDGER (default data/ledger.jsonl),
TT_SPEND_CEILING_USD (default 100), TT_STATE_DIR (default data/state: where captions keeps its lines across a
restart) and the Meta key as META_API_KEY or MODEL_API_KEY. The key is never printed.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import os
import signal
import sys
from collections.abc import AsyncIterator, Callable, Coroutine
from pathlib import Path
from typing import Any

from .contracts import AgentInfo, CaptionsState, Usage, agent_path, parse_room
from .llm.base import Llm
from .llm.ledger import SpendLedger
from .llm.meta import language_name

AGENTS = ("captions", "translate", "describe", "chapters")
DEV = ("teacher", "slides", "watch")

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


def make_llm(fake: bool) -> Llm:
    if fake:
        from .llm.fake import FakeLlm

        return FakeLlm()
    from .llm.meta import MetaLlm

    return MetaLlm(api_key(), spend_ledger())


Work = Callable[[Any, Any], Coroutine[Any, Any, None]]  # (relay, publisher) -> the agent's loop


def build(args: argparse.Namespace) -> tuple[AgentInfo, Callable[[], Usage], Work]:
    from . import moq, runtime

    lang: str = args.lang
    if args.agent == "captions":
        if args.fake:
            from .asr.scripted import ScriptedAsr, demo_script

            asr: Any = ScriptedAsr(demo_script(FAKE_SENTENCES))
            model = "fake"
        else:
            from .asr.meta import MODEL, MetaVoiceAsr

            asr, model = MetaVoiceAsr(api_key(), ledger=spend_ledger()), MODEL

        from . import statefile

        saved = Path(os.environ.get("TT_STATE_DIR", "data/state")) / f"captions-{args.room}-{lang}.json"

        async def transcribe(relay: Any, pub: Any) -> None:
            await runtime.run_captions(
                moq.teacher_audio(relay, args.room),
                asr,
                pub,
                lang,
                resume=statefile.load_captions(saved),
                save=lambda state: statefile.save(saved, state),
            )

        return AgentInfo(name="captions", label=f"Captions ({language_name(lang)})", model=model), Usage, transcribe

    llm = make_llm(args.fake)

    async def captions(relay: Any) -> AsyncIterator[CaptionsState]:
        async for envelope in moq.follow_agent(relay, args.room, "captions"):
            if isinstance(envelope.state, CaptionsState):
                yield envelope.state

    async def translate(relay: Any, pub: Any) -> None:
        await runtime.run_translate(captions(relay), llm, pub, lang)

    async def describe(relay: Any, pub: Any) -> None:
        await runtime.run_describe(moq.slide_frames(relay, args.room), llm, pub, lang)

    async def chapters(relay: Any, pub: Any) -> None:
        await runtime.run_outline(captions(relay), llm, pub, lang)

    if args.agent == "translate":
        info = AgentInfo(name=f"translate-{lang}", label=f"{language_name(lang)} translation", model=llm.model)
        return info, lambda: llm.usage, translate
    if args.agent == "describe":
        return AgentInfo(name="describe", label="Slide descriptions", model=llm.model), lambda: llm.usage, describe
    info = AgentInfo(name="chapters", label="Chapters, glossary and recap", model=llm.model)
    return info, lambda: llm.usage, chapters


async def run_agent(args: argparse.Namespace) -> None:
    from . import moq
    from .publisher import SnapshotPublisher
    from .runtime import now_ms, run_with_heartbeat

    info, usage, work = build(args)
    instance = str(now_ms())
    async with moq.connect(args.relay, token=args.token, insecure=args.insecure) as relay:
        sink = await relay.publish(agent_path(args.room, info.name, instance), "state")
        pub = SnapshotPublisher(info, sink, usage, instance=instance)
        logging.getLogger("talk_tracks").info("%s instance %s in room %s", info.name, instance, args.room)
        await moq.until_closed(relay, run_with_heartbeat(pub, asyncio.ensure_future(work(relay, pub))))


async def main_async(args: argparse.Namespace) -> None:
    task = asyncio.ensure_future(run_agent(args) if args.agent in AGENTS else _dev(args))
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


def parse(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="talk_tracks", description=__doc__.splitlines()[0] if __doc__ else None)
    p.add_argument("agent", choices=AGENTS + DEV)
    p.add_argument("--relay", default=os.environ.get("TT_RELAY"), help="moqt://host:port or https://host:port/path")
    p.add_argument("--room", default=os.environ.get("TT_ROOM"))
    p.add_argument("--lang", default="en", help="language of the output (translate: the target language)")
    p.add_argument("--token", default=os.environ.get("TT_TOKEN"), help="signed relay token for publishing")
    p.add_argument("--fake", action="store_true", help="scripted speech recognition and a fake model: no API calls")
    p.add_argument("--insecure", action="store_true", help="skip TLS verification (local relay, self-signed cert)")
    p.add_argument("--wav", type=Path, default=None, help="teacher: a 16-bit WAV file to loop instead of a tone")
    p.add_argument("--image", type=Path, action="append", default=[], help="slides: a PNG or JPEG slide (repeatable)")
    args = p.parse_args(argv)
    if not args.relay or not args.room:
        p.error("--relay and --room are required (or TT_RELAY and TT_ROOM)")
    if args.agent == "slides" and not args.image:
        p.error("slides needs at least one --image")
    args.room = parse_room(args.room)
    return args


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    asyncio.run(main_async(parse(argv)))
