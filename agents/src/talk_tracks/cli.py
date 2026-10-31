"""Command line: ``python -m talk_tracks <agent> --relay URL --room ROOM [--lang xx] [--fake]``.

Agents: ``captions`` (speech to text), ``translate`` (one language per process), ``describe`` (slide descriptions),
``chapters`` (chapters, glossary and recap). Dev stand-ins: ``teacher`` publishes audio and ``slides`` publishes
slide images like the speaker's browser, ``catalog`` publishes the room epoch like the room service, ``watch`` prints
what the agents publish. Demo rooms (see
wiki/howto/demo-rooms.md): ``play`` publishes a lecture file as the speaker, ``record`` records a room's agent tracks,
``generate`` does both at once, ``loop`` replays a recording as a live room, forever. Fixes to a finished recording
(``--recording``, offline, spending through ``--room``'s ledger): ``retranslate`` translates its caption lines (into
``--lang`` / ``--agent``) cut to subtitle cues, ``redescribe`` describes the slides it has no note for (``--slides`` as
for ``generate``), ``resplit`` cuts retranslate's over-long subtitle cues again, free (no model call, no spend).

Agents are lazy (wiki/howto/lazy-agents.md): they read their inputs, and pay, only while their track has a
subscriber. ``--room`` serves one room; ``--rooms '*'`` serves every room a speaker opens and ``--rooms a,b`` the
rooms listed, each from when its speaker comes on air.

Settings also come from the environment: TT_RELAY, TT_ROOM, TT_ROOMS, TT_ROOMS_EXCLUDE (rooms never served, such as
the demo room), TT_TOKEN, TT_LEDGER (default data/ledger.jsonl), TT_SPEND_CEILING_USD (default 100), TT_ROOM_CAP_USD
(default 2: any room's cap), TT_CAPS_DIR (default data/caps: judge token batches with their own caps),
TT_DEMO_ROOMS (rooms never back-filled: the looped demo rooms),
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
import time
from collections.abc import AsyncGenerator, Callable, Coroutine
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .archive.slices import Status, TrackArchive, TrackInfo
from .contracts import CARRY_CUES, ITEMS_TRACK, OUTLINE_TRACK, AgentInfo, Usage, agent_path, parse_room
from .live_slices import payloads
from .llm.base import Llm
from .llm.ledger import ROOM_CAP_USD, SpendLedger, room_cap
from .languages import SUPPORTED_LANGUAGES, is_supported_language, language_name
from .llm.queued import Priority, QueuedLlm, add_usage

AGENTS = ("captions", "translate", "describe", "chapters")
DEV = ("teacher", "slides", "catalog", "watch")
DEMO = ("play", "record", "generate", "loop")
REVISE = ("retranslate", "redescribe", "resplit")  # offline: a finished recording, no relay

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


def make_llm(fake: bool, room: str, *, backfill: bool = False) -> Llm:
    """The room's model; ``backfill`` gives the one back-fills use, held to the room's back-fill budget."""
    if fake:
        from .llm.fake import FakeLlm

        usd = env_float("TT_FAKE_USD_PER_CALL", 0)
        if usd <= 0:
            return FakeLlm()
        fake_ledger = room_ledger(
            room, SpendLedger(Path(os.environ.get("TT_FAKE_LEDGER", "data/fake-ledger.jsonl")), 1e9)
        )
        return FakeLlm(fake_ledger.for_backfill() if backfill else fake_ledger, usd)
    from .llm.meta import MetaLlm

    ledger = room_ledger(room, spend_ledger())
    return MetaLlm(api_key(), ledger.for_backfill() if backfill else ledger)


def demo_room(room: str) -> bool:
    """A looped demo room: its tracks are the looper's, and nothing is back-filled in it."""
    return room in {r.strip() for r in os.environ.get("TT_DEMO_ROOMS", "").split(",") if r.strip()}


@dataclass
class RoomIo:
    """What a room's agent reads: its relay session, room time, and the shared teacher audio subscription."""

    relay: Any
    time: Any  # roomtime.RoomTime
    feed: Any  # moq.TeacherFeed


Run = Callable[[RoomIo, Any, Any], Coroutine[Any, Any, None]]  # (io, track, gate) -> the agent's live loop
Backfill = Callable[[RoomIo, Any], Any]  # (io, track) -> live_slices.Produce, or None when nothing is back-filled


# L (design §4.1): how long after its time a record may still be published, so a seek fetches far enough. A cue
# is stamped with its start and its final comes up to 7 s later plus the ASR's finalisation; a translation adds a
# model call; a slide description is a model call over an image.
CAPTIONS_LATE_MS, TRANSLATION_LATE_MS, SLIDES_LATE_MS = 10_000, 15_000, 15_000


@dataclass
class Agent:
    """One room's agent: what it publishes, how it runs live, and how it produces a past slice."""

    info: AgentInfo
    usage: Callable[[], Usage]
    catalog: TrackInfo
    run: Run
    sliced: bool = True  # False for the outline (a snapshot track)
    backfill: Backfill | None = None
    marks_from: bool = False  # it cannot hear the past, so its first carry-in of a run says where it started


def build(args: argparse.Namespace, room: str) -> Agent:
    """The agent for ``room``. Its inputs open only while its track is subscribed (``gate``)."""
    from . import moq, runtime
    from .cores.captions import CaptionsCore
    from .cores.outline import OutlineCore
    from .cores.slides import SlidesCore
    from .cores.translate import TranslateCore
    from .demand import gated
    from .records import cues_of, outline_of, slides_of

    def seeded_cues(track: Any) -> list[Any]:
        return [cue for payload in track.seed_objects() for cue in cues_of(payload)[1]]

    lang: str = args.lang or "tr"
    if args.agent == "captions":
        if args.fake:
            from .asr.scripted import ScriptedAsr, demo_script

            asr: Any = ScriptedAsr(demo_script(FAKE_SENTENCES))
            model = "fake"
        else:
            from .asr.meta import MODEL, MetaVoiceAsr

            asr, model = MetaVoiceAsr(api_key(), ledger=room_ledger(room, spend_ledger())), MODEL

        async def transcribe(io: RoomIo, track: Any, gate: Any) -> None:
            core = CaptionsCore(lang, cues=seeded_cues(track))
            track.carry = core.carry
            audio = gated(gate, lambda: moq.teacher_audio(io.feed), f"captions {room}", track.finish)
            async with contextlib.aclosing(audio) as a:
                await runtime.run_captions(a, asr, track, core)

        label = f"Captions ({language_name(lang)})"
        return Agent(  # captions are never back-filled (design §5.7): an unwatched slice stays unproduced
            AgentInfo(name="captions", label=label, model=model),
            Usage,
            TrackInfo(kind="captions", label=label, lang=lang, lateness_ms=CAPTIONS_LATE_MS),
            transcribe,
            marks_from=True,
        )

    priority = Priority()
    live_llm = make_llm(args.fake, room)
    llm = QueuedLlm(live_llm, priority, live=True)

    def captions(io: RoomIo) -> AsyncGenerator[Any]:
        """Subscribing here is what keeps the captions agent working for us (a downstream subscriber)."""
        return moq.follow_captions(io.relay, room)

    # aclosing: an agent that stops at its cap closes its input at once, which releases the track it subscribed to.
    async def translate(io: RoomIo, track: Any, gate: Any) -> None:
        core = TranslateCore(lang, done=seeded_cues(track))
        track.carry = core.carry
        cues = gated(gate, lambda: captions(io), f"translate {room}", track.finish)
        async with contextlib.aclosing(cues) as a:
            await runtime.run_translate(a, llm, track, core)

    backfill_llm = make_llm(args.fake, room, backfill=True)

    def translate_backfill(io: RoomIo, track: Any) -> Any:
        """Back-fill (design §5.7, translation only): in the FETCH handler, one at a time and behind live calls, from
        the captions slice fetched through the relay, on the room's back-fill budget. Never in a demo room."""
        if demo_room(room):
            return None
        queued = QueuedLlm(backfill_llm, priority, live=False)

        async def produce(k: int) -> Any:
            source = await io.relay.fetch_group(agent_path(room, "captions"), ITEMS_TRACK, k)
            if not source:
                raise LookupError(f"captions slice {k} is empty")
            before = track.archive.read_local(k - 1) if k > 0 else None
            tail = [c for p in payloads(before) for c in cues_of(p)[1]][-CARRY_CUES:] if before else []
            async with priority.backfill():
                return await runtime.backfill_translate(queued, lang, source, tail)

        return produce

    async def describe(io: RoomIo, track: Any, gate: Any) -> None:
        core = SlidesCore(lang)
        core.seed([s for payload in track.seed_objects() for s in slides_of(payload)[1]])
        track.carry = core.carry
        frames = gated(gate, lambda: moq.slide_frames(io.relay, room, io.time), f"describe {room}", track.finish)

        async def follow_edge() -> None:  # slides change rarely: the slices follow the speaker's media between them
            while True:
                if io.time.edge is not None:
                    track.clock.observe(io.time.edge)
                await asyncio.sleep(0.2)

        follow = asyncio.create_task(follow_edge())
        try:
            async with contextlib.aclosing(frames) as f:
                await runtime.run_describe(f, llm, track, core)
        finally:
            follow.cancel()

    async def chapters(io: RoomIo, track: Any, gate: Any) -> None:
        core = OutlineCore(lang)
        if (seed := track.seed_object()) is not None and (records := outline_of(seed)) is not None:
            core.seed(records)
        async with contextlib.aclosing(gated(gate, lambda: captions(io), f"chapters {room}")) as cues:
            await runtime.run_outline(cues, llm, track, core)

    usage = lambda: add_usage(live_llm.usage, backfill_llm.usage)  # noqa: E731
    if args.agent == "translate":
        label = f"{language_name(lang)} translation"
        return Agent(
            AgentInfo(name=f"translate-{lang}", label=label, model=llm.model),
            usage,
            TrackInfo(
                kind="translation", label=label, lang=lang, depends=["captions/items"], lateness_ms=TRANSLATION_LATE_MS
            ),
            translate,
            backfill=translate_backfill,
        )
    if args.agent == "describe":
        label = "Slide descriptions"
        return Agent(  # slide descriptions are never back-filled (design §5.7)
            AgentInfo(name="describe", label=label, model=llm.model),
            usage,
            TrackInfo(kind="slides", label=label, lang=lang, lateness_ms=SLIDES_LATE_MS),
            describe,
        )
    label = "Chapters, glossary and recap"
    return Agent(
        AgentInfo(name="chapters", label=label, model=llm.model),
        usage,
        TrackInfo(kind="outline", label=label, lang=lang, depends=["captions/items"]),
        chapters,
        sliced=False,
    )


DEMO_PREMADE_LANGUAGES = frozenset({"tr", "es", "ar"})


async def serve_translate_room(
    args: argparse.Namespace,
    room: str,
    *,
    languages: Sequence[str] | None = None,
) -> None:
    """Translation agent for ``room``: serves translation tracks on demand for any supported
    BCP 47 language tag (decision 0019). Each track is lazy and only consumes spend when subscribed.
    In a demo room, pre-made tr, es, ar stay while other languages translate live against room cap."""
    from . import moq, runtime
    from .archive.slices import TrackArchive, archive_bucket
    from .cores.translate import TranslateCore
    from .demand import IDLE_GRACE_S, Gate, gated
    from .languages import SUPPORTED_LANGUAGES, is_supported_language, language_name
    from .live_slices import SlicedTrack, Watermark
    from .llm.queued import Priority, QueuedLlm, add_usage
    from .records import cues_of, payloads
    from .rooms import TALK_OVER
    from .roomtime import RoomTime

    priority = Priority()
    live_llm = make_llm(args.fake, room)
    backfill_llm = make_llm(args.fake, room, backfill=True)
    is_demo = demo_room(room)

    if languages is not None:
        target_langs = list(languages)
    elif args.lang and args.lang not in ("*", "all", "any"):
        target_langs = [l.strip() for l in args.lang.split(",") if l.strip()]
    else:
        # Open subtitle list: in demo rooms, pre-made tr, es, ar stay; other languages run live.
        target_langs = [l for l in SUPPORTED_LANGUAGES if not (is_demo and l in DEMO_PREMADE_LANGUAGES)]

    log = logging.getLogger("talk_tracks")
    async with moq.connect(args.relay, token=args.token, insecure=args.insecure) as relay:
        room_time = RoomTime()
        io = RoomIo(relay, room_time, moq.TeacherFeed(relay, room, room_time))
        clock = Watermark(edge=lambda: room_time.edge)

        def captions() -> AsyncGenerator[Any]:
            return moq.follow_captions(relay, room)

        tracks: dict[str, SlicedTrack] = {}
        runners: list[asyncio.Task[None]] = []

        def seeded_cues(track: SlicedTrack) -> list[Any]:
            return [cue for payload in track.seed_objects() for cue in cues_of(payload)[1]]

        async def start_language(lang: str) -> SlicedTrack | None:
            if lang in tracks:
                return tracks[lang]
            if not is_supported_language(lang):
                log.warning("unsupported translation language %r for room %s", lang, room)
                return None
            name = f"translate-{lang}"
            label = f"{language_name(lang)} translation"
            track_info = TrackInfo(
                kind="translation",
                label=label,
                lang=lang,
                depends=["captions/items"],
                lateness_ms=TRANSLATION_LATE_MS,
            )
            agent_info = AgentInfo(name=name, label=label, model=live_llm.model)
            archive = TrackArchive(room, name, ITEMS_TRACK, bucket=archive_bucket(), info=track_info)
            out = await relay.publish_sliced(agent_path(room, name), ITEMS_TRACK)
            sliced = SlicedTrack(agent_info, out, archive, list, clock=clock, marks_from=False)

            if is_demo:
                produce = None
            else:
                queued = QueuedLlm(backfill_llm, priority, live=False)

                async def produce(k: int) -> Any:
                    source = await relay.fetch_group(agent_path(room, "captions"), ITEMS_TRACK, k)
                    if not source:
                        raise LookupError(f"captions slice {k} is empty")
                    before = archive.read_local(k - 1) if k > 0 else None
                    tail = [c for p in payloads(before) for c in cues_of(p)[1]][-CARRY_CUES:] if before else []
                    async with priority.backfill():
                        return await runtime.backfill_translate(queued, lang, source, tail)

            out.serve(lambda k: sliced.slice(k, produce), sliced.stats, sliced.current_slice)
            gate = Gate(out.demand, grace_s=env_float("TT_IDLE_GRACE_S", IDLE_GRACE_S))
            core = TranslateCore(lang, done=seeded_cues(sliced))
            sliced.carry = core.carry

            async def run_lang() -> None:
                cues = gated(gate, captions, f"translate-{lang} {room}", sliced.finish)
                llm = QueuedLlm(live_llm, priority, live=True)
                async with contextlib.aclosing(cues) as a:
                    await runtime.run_translate(a, llm, sliced, core)
                await asyncio.Event().wait()  # stopped at spend cap: the track stays up and says so

            def state() -> TrackState:
                capped = sliced.capped
                producing = not sliced.paused
                status_str: Status = "capped" if capped else "live" if producing else "idle"
                stats = sliced.stats
                cost = round(add_usage(live_llm.usage, backfill_llm.usage).cost_usd, 6)
                return status_str, producing, stats.fetches_served, stats.backfills, cost

            async def status() -> None:
                last: TrackState | None = None
                since = 0.0
                while True:
                    now = state()
                    if now != last or time.monotonic() - since >= REPORT_EVERY_S:
                        report(archive, now)
                        last, since = now, time.monotonic()
                    await asyncio.sleep(0.5)

            runners.append(asyncio.create_task(run_lang()))
            runners.append(asyncio.create_task(status()))
            runners.append(asyncio.create_task(sliced.run_clock()))
            tracks[lang] = sliced
            log.info("translate-%s active in room %s (lazy)", lang, room)
            return sliced

        for lang in target_langs:
            await start_language(lang)

        background = [
            asyncio.create_task(moq.room_catalog(relay, room, room_time)),
            asyncio.create_task(io.feed.run()),
        ]

        async def serve() -> None:
            await asyncio.gather(*runners)

        try:
            await moq.until_closed(relay, serve())
        except asyncio.CancelledError as exc:
            if TALK_OVER in exc.args:
                for sliced in tracks.values():
                    log.info("%s: room %s is closed: End of Track", sliced.info.name, room)
                    with contextlib.suppress(Exception):
                        await sliced.end()
            raise
        finally:
            for task in [*background, *runners]:
                task.cancel()
            for sliced in tracks.values():
                with contextlib.suppress(Exception):
                    await sliced.pause()
                sliced.archive.close()


async def serve_room(args: argparse.Namespace, room: str) -> None:
    """One room's agent on a connection of its own, under its stable name: its track stays published, idle until
    subscribed, and answers FETCH for its history from the archive (back-filling slices never produced)."""
    if args.agent == "translate":
        await serve_translate_room(args, room)
        return

    from . import moq
    from .archive.slices import TrackArchive, archive_bucket
    from .demand import IDLE_GRACE_S, Gate
    from .live_slices import SlicedTrack, SnapshotTrack, Watermark
    from .rooms import TALK_OVER
    from .roomtime import RoomTime

    agent = build(args, room)
    info = agent.info
    name = ITEMS_TRACK if agent.sliced else OUTLINE_TRACK
    archive = TrackArchive(room, info.name, name, bucket=archive_bucket(), info=agent.catalog)
    log = logging.getLogger("talk_tracks")
    async with moq.connect(args.relay, token=args.token, insecure=args.insecure) as relay:
        room_time = RoomTime()
        io = RoomIo(relay, room_time, moq.TeacherFeed(relay, room, room_time))
        out = await relay.publish_sliced(agent_path(room, info.name), name)
        clock = Watermark(edge=lambda: room_time.edge)
        track: SlicedTrack | SnapshotTrack
        if not agent.sliced:
            track = SnapshotTrack(info, out, archive, clock=clock)
            out.serve(track.slice, track.stats)
        else:
            sliced = track = SlicedTrack(info, out, archive, list, clock=clock, marks_from=agent.marks_from)
            produce = agent.backfill(io, sliced) if agent.backfill else None
            out.serve(lambda k: sliced.slice(k, produce), sliced.stats, sliced.current_slice)
        gate = Gate(out.demand, grace_s=env_float("TT_IDLE_GRACE_S", IDLE_GRACE_S))
        newest = archive.latest_group()
        log.info("%s in room %s, after slice %s", info.name, room, "none" if newest is None else newest)

        async def serve() -> None:
            await agent.run(io, track, gate)
            await asyncio.Event().wait()  # stopped at a spend cap: the track stays up and says so

        def state() -> TrackState:
            """What the room service shows for this track (design §5.10): all the counters, in one place."""
            capped = isinstance(track, SlicedTrack) and track.capped
            producing = not track.paused if isinstance(track, SlicedTrack) else out.demand.wanted()
            status: Status = "capped" if capped else "live" if producing else "idle"
            stats = track.stats
            return status, producing, stats.fetches_served, stats.backfills, round(agent.usage().cost_usd, 6)

        async def status() -> None:
            """Report on every change, and at least every ``REPORT_EVERY_S`` as a heartbeat (stale after 15 s)."""
            last: TrackState | None = None
            since = 0.0
            while True:
                now = state()
                if now != last or time.monotonic() - since >= REPORT_EVERY_S:
                    report(archive, now)
                    last, since = now, time.monotonic()
                await asyncio.sleep(0.5)

        background = [
            asyncio.create_task(moq.room_catalog(relay, room, room_time)),
            asyncio.create_task(io.feed.run()),
            asyncio.create_task(track.run_clock()),
            asyncio.create_task(status()),
        ]
        try:
            await moq.until_closed(relay, serve())
        except asyncio.CancelledError as exc:
            if TALK_OVER in exc.args and isinstance(track, SlicedTrack):
                log.info("%s: room %s is closed: End of Track", info.name, room)
                with contextlib.suppress(Exception):
                    await track.end()
            raise
        finally:
            for task in background:
                task.cancel()
            if isinstance(track, SlicedTrack):  # a clean stop closes the open slice; a replacement starts at the next
                with contextlib.suppress(Exception):
                    await track.pause()
            status_now, _, fetched, filled, spent = state()
            report(archive, ("capped" if status_now == "capped" else "idle", False, fetched, filled, spent))
            archive.close()


REPORT_EVERY_S = 5.0
TrackState = tuple[Status, bool, int, int, float]  # status, producing, FETCHes served, back-fills, spend in USD


def report(archive: TrackArchive, state: TrackState) -> None:
    status, producing, fetches_served, backfills, spend_usd = state
    archive.report(status, producing=producing, fetches_served=fetches_served, backfills=backfills, spend_usd=spend_usd)


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
    elif args.agent in REVISE:
        work = _revise(args)
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
        agents=[a for a in args.watch.split(",") if a],
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
        recording = need(args.recording, "--recording")
        await demo.loop(args.relay, args.room, recording, media=args.media, slides=slides, **common)


async def _revise(args: argparse.Namespace) -> None:
    from . import revise
    from .slideshow import Crop

    recording = need(args.recording, "--recording")
    if args.agent == "resplit":
        result, changed = revise.resplit(recording, agent=args.target_agent, lang=args.lang)
        longest = max((len(s) for line in result.lines.values() for s in line.segments), default=0)
        logging.getLogger("talk_tracks.revise").info(
            "resplit (%s): %d of %d lines cut again, longest cue now %d characters",
            result.lang,
            len(changed),
            len(result.lines),
            longest,
        )
        return
    if args.agent == "retranslate":
        translator: revise.CueTranslator = (
            revise.FakeCueTranslator(usd_per_call=env_float("TT_FAKE_USD_PER_CALL", 0))
            if args.fake
            else revise.MetaCueTranslator(api_key(), room_ledger(args.room, spend_ledger()))
        )
        result = await revise.retranslate(recording, translator, agent=args.target_agent, lang=args.lang)
        logging.getLogger("talk_tracks.revise").info(
            "retranslate (%s): %d lines cut to their cues, %s", result.lang, len(result.lines), result.usage
        )
    else:
        describer = make_llm(args.fake, args.room)
        media = args.media or recording / "lecture.mp4"
        patch = await revise.redescribe(
            recording, media, Crop.parse(args.slides or "full"), describer, agent=args.target_agent or "describe"
        )
        logging.getLogger("talk_tracks.revise").info(
            "redescribe: %d slides described, %s", len(patch.notes), patch.usage
        )


def need(value: Path | None, flag: str) -> Path:
    if value is None:
        sys.exit(f"{flag} is required")
    return value


def parse(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="talk_tracks", description=__doc__.splitlines()[0] if __doc__ else None)
    p.add_argument("agent", choices=AGENTS + DEV + DEMO + REVISE)
    p.add_argument("--relay", default=os.environ.get("TT_RELAY"), help="moqt://host:port or https://host:port/path")
    p.add_argument("--room", default=os.environ.get("TT_ROOM"))
    p.add_argument("--rooms", default=os.environ.get("TT_ROOMS") or None, help="agents: '*' for any room, or a,b")
    p.add_argument(
        "--lang", default=None, help="language of the output (translate, retranslate, resplit: target language)"
    )
    p.add_argument(
        "--agent",
        dest="target_agent",
        default=None,
        metavar="NAME",
        help="retranslate, resplit, redescribe: the recording's agent track (default: from --lang, or translate-tr)",
    )
    p.add_argument("--token", default=os.environ.get("TT_TOKEN"), help="signed relay token for publishing")
    p.add_argument("--fake", action="store_true", help="scripted speech recognition and a fake model: no API calls")
    p.add_argument("--insecure", action="store_true", help="skip TLS verification (local relay, self-signed cert)")
    p.add_argument("--wav", type=Path, default=None, help="teacher: a 16-bit WAV file to loop instead of a tone")
    p.add_argument("--image", type=Path, action="append", default=[], help="slides: a PNG or JPEG slide (repeatable)")
    p.add_argument("--watch", default="captions,translate-tr,describe,chapters", help="watch: the agents to print")
    p.add_argument("--media", type=Path, default=None, help="play, generate, loop: the lecture (MP4, H.264 + Opus)")
    p.add_argument("--out", type=Path, default=None, help="record, generate: the recording directory to write")
    p.add_argument("--recording", type=Path, default=None, help="loop, retranslate, resplit, redescribe: recording dir")
    p.add_argument("--loops", type=int, default=None, help="play: how many times (default: forever)")
    p.add_argument("--lead-in-s", type=float, default=5.0, help="generate: wait before the lecture starts")
    p.add_argument("--tail-s", type=float, default=15.0, help="generate: keep recording after the lecture ends")
    p.add_argument(
        "--slides",
        nargs="?",
        const="full",
        default=None,
        help="play, generate: also send the slides found in the video, cropped to x,y,w,h (fractions; default full);"
        " loop: also send them as the speaker's deck and slide tracks",
    )
    args = p.parse_args(argv)
    if args.agent not in AGENTS:
        args.rooms = None
    if args.agent not in REVISE and args.lang is None and args.agent != "translate":
        args.lang = "en"
    need_relay = args.agent not in REVISE
    need_room = args.agent != "resplit"
    if (need_relay and not args.relay) or (need_room and not (args.room or args.rooms)):
        p.error("--relay and --room (agents: or --rooms) are required (or TT_RELAY and TT_ROOM)")
    if args.agent == "slides" and not args.image:
        p.error("slides needs at least one --image")
    if args.rooms is None and args.room is not None:
        args.room = parse_room(args.room)
    for room in (args.rooms or "").split(","):
        if room.strip() not in ("", "*"):
            parse_room(room.strip())
    return args


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    asyncio.run(main_async(parse(argv)))
