"""Command line: ``python -m talk_tracks <agent> --relay URL --room ROOM [--lang xx] [--fake]``.

Agents: ``captions`` (speech to text), ``translate`` (a lazy track for each language of ``contracts/languages.json``,
or ``--lang a,b``), ``describe`` (slide descriptions), ``chapters`` (chapters, glossary and recap). Dev stand-ins:
``teacher`` publishes audio and ``slides`` publishes
slide images like the speaker's browser, ``catalog`` publishes the room epoch like the room service, ``watch`` prints
what the agents publish. Demo rooms (see
wiki/howto/demo-rooms.md): ``play`` publishes a lecture file as the speaker, ``record`` records a room's agent tracks,
``generate`` does both at once, ``session`` runs a demo lecture's live sessions in its room one after the other (each
plays the lecture once from 00:00 and ends; ``TT_DEMO_LIVE_AGENTS`` on: its AI tracks come from the live agents only),
``serve-recording`` serves a recording room ``<id>-recording`` that ``record-archive`` built. Offline and free:
``record-archive`` builds a recording room into the archive (TT_ARCHIVE_DIR), ``cue-report`` counts where a
recording's subtitle cues end, ``find-regions`` finds where a lecture's frame holds the slides and the speaker's
webcam and writes ``regions.json`` beside it (``--slides auto`` cuts the slides from it; ``session`` and
``serve-recording`` put it in the room catalog, for the player's camera tile). Fixes to a finished recording
(``--recording``, offline, spending through ``--room``'s ledger): ``redescribe`` describes the slides it has no note
for (``--slides`` as for ``generate``), ``repunctuate`` adds sentence and clause punctuation to its caption lines,
words unchanged (``--dry-run``: no call, no write, the estimate).

Agents are lazy (wiki/howto/lazy-agents.md): they read their inputs, and pay, only while their track has a
subscriber. ``--room`` serves one room; ``--rooms '*'`` serves every room a speaker opens and ``--rooms a,b`` the
rooms listed, each from when its speaker comes on air. With ``TT_DEMO_LIVE_AGENTS`` on, ``translate`` also serves
the recording rooms built in the archive, back-filling a slice only when a viewer fetches it (decision 0035).

Settings also come from the environment: TT_RELAY, TT_ROOM, TT_ROOMS, TT_ROOMS_EXCLUDE (rooms never served, such as
the demo room), TT_TOKEN, TT_LEDGER (default data/ledger.jsonl), TT_SPEND_CEILING_USD (default 100), TT_ROOM_CAP_USD
(default 2: any room's cap), TT_CAPS_DIR (default data/caps: judge token batches with their own caps),
TT_DEMO_ROOMS (the demo rooms: never back-filled; with TT_DEMO_LIVE_AGENTS on, served session by session and
dropped from TT_ROOMS_EXCLUDE),
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
from collections.abc import AsyncGenerator, Callable, Coroutine, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .archive.slices import Status, TrackArchive, TrackInfo
from .contracts import CARRY_CUES, ITEMS_TRACK, OUTLINE_TRACK, AgentInfo, Usage, agent_path, parse_room
from .languages import language_name
from .live_slices import Produce, payloads
from .llm.base import Llm
from .llm.ledger import ROOM_CAP_USD, SpendLedger, room_cap
from .llm.queued import Priority, QueuedLlm, add_usage

AGENTS = ("captions", "translate", "describe", "chapters")
DEV = ("teacher", "slides", "catalog", "watch")
DEMO = ("play", "record", "generate", "session", "serve-recording")
REVISE = ("redescribe", "repunctuate")  # offline: a finished recording, no relay
OFFLINE = ("record-archive", "cue-report", "find-regions")  # offline and free: no relay, no model

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


def make_llm(fake: bool, room: str, *, backfill: bool = False, share: float | None = None) -> Llm:
    """The room's model; ``backfill`` gives the one back-fills use, held to the room's back-fill budget (``share``
    of its cap, default ``BACKFILL_SHARE``)."""
    from .llm.ledger import BACKFILL_SHARE

    part = BACKFILL_SHARE if share is None else share
    if fake:
        from .llm.fake import FakeLlm

        usd = env_float("TT_FAKE_USD_PER_CALL", 0)
        if usd <= 0:
            return FakeLlm()
        fake_ledger = room_ledger(
            room, SpendLedger(Path(os.environ.get("TT_FAKE_LEDGER", "data/fake-ledger.jsonl")), 1e9)
        )
        return FakeLlm(fake_ledger.for_backfill(part) if backfill else fake_ledger, usd)
    from .llm.meta import MetaLlm

    ledger = room_ledger(room, spend_ledger())
    return MetaLlm(api_key(), ledger.for_backfill(part) if backfill else ledger)


def demo_room(room: str) -> bool:
    """A demo room (decision 0032): live sessions, each on a room clock of its own, and nothing back-filled in it."""
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
    """The captions, describe or chapters agent for ``room`` (translation is ``serve_translate_room``). Its inputs
    open only while its track is subscribed (``gate``)."""
    from . import moq, runtime
    from .cores.captions import CaptionsCore
    from .cores.outline import OutlineCore
    from .cores.slides import SlidesCore
    from .demand import gated
    from .records import cues_of, outline_of, slides_of

    def seeded_cues(track: Any) -> list[Any]:
        return [cue for payload in track.seed_objects() for cue in cues_of(payload)[1]]

    lang: str = args.lang or "en"
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

    usage = lambda: live_llm.usage  # noqa: E731  (translate is serve_translate_room's: only it back-fills)
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


def translation_backfill(
    relay: Any, room: str, lang: str, archive: TrackArchive, llm: Llm, priority: Priority
) -> Produce:
    """Back-fill one translation slice ``k`` (design §5.7): translate the captions slice fetched through the relay,
    carrying in the end of this track's slice before when the archive has it, one at a time behind live calls."""
    from . import runtime
    from .records import cues_of

    async def produce(k: int) -> Any:
        source = await relay.fetch_group(agent_path(room, "captions"), ITEMS_TRACK, k)
        if not source:
            raise LookupError(f"captions slice {k} is empty")
        before = archive.read_local(k - 1) if k > 0 else None
        tail = [c for p in payloads(before) for c in cues_of(p)[1]][-CARRY_CUES:] if before else []
        async with priority.backfill():
            return await runtime.backfill_translate(llm, lang, source, tail)

    return produce


def open_languages(lang: str | None) -> list[str]:
    """The languages ``translate --lang`` serves: a comma-separated list, or with ``any`` (``*``, ``all``, unset)
    every one in ``contracts/languages.json``, in every room alike (decision 0035): each track is lazy."""
    from .languages import SUPPORTED_LANGUAGES

    if lang and lang not in ("*", "all", "any"):
        return [tag.strip() for tag in lang.split(",") if tag.strip()]
    return list(SUPPORTED_LANGUAGES)


def is_recording_room(room: str) -> bool:
    """A demo lecture's recording room, ``<id>-recording`` (decision 0032): ended, with no speaker."""
    from .session import RECORDING_SUFFIX

    return room.endswith(RECORDING_SUFFIX)


def recording_rooms(root: Path) -> list[str]:
    """The recording rooms ``record-archive`` built into the archive ``root``: ``<id>-recording/room.json``. The room
    service skips ``*-recording`` (``TT_ARCHIVE_SKIP``), so no live talk of that name has a ``room.json``."""
    from .archive.slices import listdir

    return sorted(r for r in listdir(root) if is_recording_room(r) and (root / r / "room.json").is_file())


def recording_edge(room: str, root: Path) -> int | None:
    """Room time just past a recording room's end (its ``room`` track's last slice): every slice before it is past,
    so a FETCH of any of them may be back-filled. None while the room is not built."""
    from .archive.slices import TrackArchive
    from .contracts import ROOM_TRACK, SLICE_MS, catalog_path

    last = TrackArchive.of(catalog_path(room), ROOM_TRACK, root=root).latest_group()
    return None if last is None else (last + 1) * SLICE_MS


RECORDING_BACKFILL_SHARE = 1.0  # a recording room has no live work to keep its cap for: back-fill is all it does


async def serve_translate_room(
    args: argparse.Namespace,
    room: str,
    *,
    languages: Sequence[str] | None = None,
) -> bool:
    """Translation agent for ``room``: one lazy translation track per listed language (decisions 0019 and 0035),
    which spends only while subscribed (live) or fetched (back-fill), against the room's cap. Demo rooms get live
    translation only, session by session; a recording room (``is_recording_room``) gets back-fill only, from its
    archived captions, and is never stopped by its ``ended``. True when the demo room's live session changed under it
    (``epoch_changed``)."""
    from . import moq, runtime
    from .archive.slices import TrackArchive, archive_bucket, default_root
    from .cores.translate import TranslateCore
    from .demand import IDLE_GRACE_S, Gate, gated
    from .languages import is_supported_language, language_name
    from .live_slices import SlicedTrack, Watermark
    from .llm.queued import Priority, QueuedLlm
    from .records import cues_of
    from .rooms import TALK_OVER
    from .roomtime import RoomTime

    priority = Priority()
    recorded = is_recording_room(room)
    live_llm = make_llm(args.fake, room)
    backfill_llm = make_llm(args.fake, room, backfill=True, share=RECORDING_BACKFILL_SHARE if recorded else None)
    is_demo = demo_room(room)
    target_langs = list(languages) if languages is not None else open_languages(args.lang)
    log = logging.getLogger("talk_tracks")
    end_edge = recording_edge(room, default_root()) if recorded else None
    if recorded and end_edge is None:
        raise FileNotFoundError(f"{room}: no room track in the archive; build it with record-archive")

    sessions = demo_room(room)  # live sessions: one instance each; slices stay on the VM (each writes group 0 again)
    bucket = None if sessions or recorded else archive_bucket()
    changed = False
    async with moq.connect(args.relay, token=args.token, insecure=args.insecure) as relay:
        room_time = RoomTime()
        io = RoomIo(relay, room_time, moq.TeacherFeed(relay, room, room_time))
        # A recording room is all past: its edge is its end. A live room's is the speaker's newest media.
        clock = Watermark(edge=(lambda: end_edge) if recorded else (lambda: room_time.edge))
        catalogs = asyncio.create_task(moq.room_catalog(relay, room, room_time))
        try:
            epoch = await session_epoch(room_time) if sessions else None
        except BaseException:
            catalogs.cancel()
            raise

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
            archive = TrackArchive(room, name, ITEMS_TRACK, bucket=bucket, info=track_info)
            if epoch is not None and archive.start_session(epoch):
                log.info("%s in room %s: a new session (E %d), the last one's slices cleared", name, room, epoch)
            out = await relay.publish_sliced(agent_path(room, name), ITEMS_TRACK)
            sliced = SlicedTrack(agent_info, out, archive, list, clock=clock, marks_from=False)

            produce: Produce | None = None  # never back-filled in a demo room
            if not is_demo:
                queued = QueuedLlm(backfill_llm, priority, live=False)
                produce = translation_backfill(relay, room, lang, archive, queued, priority)
            out.serve(lambda k: sliced.slice(k, produce), sliced.stats, sliced.current_slice)
            gate = Gate(out.demand, grace_s=env_float("TT_IDLE_GRACE_S", IDLE_GRACE_S))
            core = TranslateCore(lang, done=seeded_cues(sliced))
            sliced.carry = core.carry

            async def run_lang() -> None:
                if recorded:  # nothing is live in an ended room: a FETCH back-fills its slice, nothing else runs
                    await asyncio.Event().wait()
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

        background = [catalogs, *([] if recorded else [asyncio.create_task(io.feed.run())])]

        async def serve() -> None:
            nonlocal changed
            if epoch is None:
                await asyncio.gather(*runners)
                return
            work = asyncio.ensure_future(asyncio.gather(*runners))
            moved = asyncio.ensure_future(epoch_changed(room_time, epoch))
            try:
                await asyncio.wait({work, moved}, return_when=asyncio.FIRST_COMPLETED)
                if not moved.done():
                    work.result()
                await moved
                changed = True
                for sliced in tracks.values():
                    with contextlib.suppress(Exception):
                        await sliced.end()
            finally:
                work.cancel()
                moved.cancel()

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
    return changed


def room_exclusions(exclude: str) -> list[str]:
    """The rooms an agent never serves (``TT_ROOMS_EXCLUDE``): with ``TT_DEMO_LIVE_AGENTS`` on, not the demo rooms,
    whose live sessions then get their AI tracks from the live agents only (decision 0032)."""
    from .session import live_agents

    rooms = [r.strip() for r in exclude.split(",") if r.strip()]
    if live_agents():
        rooms = [r for r in rooms if not demo_room(r)]
    return rooms


async def session_epoch(room_time: Any) -> int:
    """The ``E`` of a demo room's current live session: the first room catalog's (the session player publishes it
    before its teacher comes on air)."""
    return await room_time.wait_epoch()


async def epoch_changed(room_time: Any, epoch: int) -> None:
    """Return when the room catalog's ``E`` is no longer ``epoch``: a new live session began while this agent still
    served the last one (it missed the ``ended``). The agent then starts again on the new session."""
    now = await room_time.wait_epoch(other_than=epoch)
    logging.getLogger("talk_tracks").info("room epoch %d -> %d: a new session", epoch, now)


async def serve_room(args: argparse.Namespace, room: str) -> None:
    """One room's agent on a connection of its own, under its stable name: its track stays published, idle until
    subscribed, and answers FETCH for its history from the archive (back-filling slices never produced). In a demo
    room's live sessions, one instance per session: a new ``E`` starts it again from the session's group 0."""
    while await (serve_translate_room(args, room) if args.agent == "translate" else _serve_room(args, room)):
        pass


async def _serve_room(args: argparse.Namespace, room: str) -> bool:
    """True when the demo room's session changed under it (``epoch_changed``)."""
    from . import moq
    from .archive.slices import TrackArchive, archive_bucket
    from .demand import IDLE_GRACE_S, Gate
    from .live_slices import SlicedTrack, SnapshotTrack, Watermark
    from .rooms import TALK_OVER
    from .roomtime import RoomTime

    agent = build(args, room)
    info = agent.info
    name = ITEMS_TRACK if agent.sliced else OUTLINE_TRACK
    sessions = demo_room(room)  # live sessions: one instance each; slices stay on the VM (each writes group 0 again)
    archive = TrackArchive(room, info.name, name, bucket=None if sessions else archive_bucket(), info=agent.catalog)
    log = logging.getLogger("talk_tracks")
    changed = False
    async with moq.connect(args.relay, token=args.token, insecure=args.insecure) as relay:
        room_time = RoomTime()
        io = RoomIo(relay, room_time, moq.TeacherFeed(relay, room, room_time))
        catalogs = asyncio.create_task(moq.room_catalog(relay, room, room_time))
        try:
            epoch = await session_epoch(room_time) if sessions else None
        except BaseException:
            catalogs.cancel()
            raise
        if epoch is not None and archive.start_session(epoch):
            log.info("%s in room %s: a new session (E %d), the last one's slices cleared", info.name, room, epoch)
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
            nonlocal changed
            work = asyncio.ensure_future(agent.run(io, track, gate))
            moved = asyncio.ensure_future(epoch_changed(room_time, epoch)) if epoch is not None else None
            try:
                await asyncio.wait({work, *([moved] if moved else [])}, return_when=asyncio.FIRST_COMPLETED)
                if moved is not None and moved.done():
                    changed = True
                    if isinstance(track, SlicedTrack):
                        await track.end()
                    return
                work.result()
                await (moved if moved is not None else asyncio.Event().wait())  # capped: the track stays up
                changed = True
            finally:
                work.cancel()
                if moved is not None:
                    moved.cancel()

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
            catalogs,
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
    return changed


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
    from .rooms import ROOM_LINGER_S, RoomPolicy, room_ended, serve_rooms

    policy = RoomPolicy(args.rooms, room_exclusions(os.environ.get("TT_ROOMS_EXCLUDE", "")))
    linger = env_float("TT_ROOM_LINGER_S", ROOM_LINGER_S)
    async with moq.connect(args.relay, token=args.token, insecure=args.insecure) as relay:
        logging.getLogger("talk_tracks").info("%s serving rooms %s", args.agent, args.rooms)
        rooms = serve_rooms(
            moq.rooms_on_air(relay),
            policy,
            lambda room: serve_room(args, room),
            linger_s=linger,
            ended=lambda room: room_ended(relay.joined, room),
        )
        if serves_recordings(args):
            rooms = _first_of(rooms, serve_recording_rooms(policy, lambda room: serve_room(args, room)))
        await moq.until_closed(relay, rooms)


RECORDINGS_RESCAN_S = 60.0


def serves_recordings(args: argparse.Namespace) -> bool:
    """Whether this agent also serves the recording rooms: the translation agent only, and only with
    ``TT_DEMO_LIVE_AGENTS`` on (off, no model call happens in a demo lecture's rooms, decision 0034)."""
    from .session import live_agents

    return args.agent == "translate" and live_agents()


async def serve_recording_rooms(
    policy: Any,
    serve: Callable[[str], Coroutine[Any, Any, None]],
    *,
    root: Path | None = None,
    every_s: float = RECORDINGS_RESCAN_S,
) -> None:
    """Serve every recording room built in the archive (``recording_rooms``) that ``policy`` wants, for good: it has
    no speaker to come on air and is ended from the start, so neither starts or stops it. The archive is read again
    every ``every_s``, so a room built later is picked up. A room that fails raises here, so the process restarts."""
    from .archive.slices import default_root

    log = logging.getLogger("talk_tracks")
    running: dict[str, asyncio.Task[None]] = {}
    try:
        while True:
            folder = root or default_root()
            for room in recording_rooms(folder):
                if room not in running and policy.wants(room) and recording_edge(room, folder) is not None:
                    log.info("recording room %s: serving its translations on demand", room)
                    running[room] = asyncio.create_task(serve(room))
            for room, task in list(running.items()):
                if task.done():
                    del running[room]
                    task.result()  # a failure ends the process; a room that returned is served again
            await asyncio.sleep(every_s)
    finally:
        for task in running.values():
            task.cancel()
        for task in running.values():
            with contextlib.suppress(BaseException):
                await task


async def _first_of(*works: Coroutine[Any, Any, None]) -> None:
    """Run ``works`` together until the first one returns or fails; then stop the rest."""
    tasks = [asyncio.ensure_future(w) for w in works]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(BaseException):
                await task


async def main_async(args: argparse.Namespace) -> None:
    if args.agent in AGENTS:
        work = run_agent(args)
    elif args.agent in DEMO:
        work = _demo(args)
    elif args.agent in REVISE:
        work = _revise(args)
    elif args.agent in OFFLINE:
        _offline(args)
        return
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
    from .regions import slides_spec

    common: dict[str, Any] = {"token": args.token, "insecure": args.insecure}
    slides = slides_spec(args.slides)
    if args.agent == "play":
        await demo.play(args.relay, args.room, need(args.media, "--media"), loops=args.loops, slides=slides, **common)
    elif args.agent == "record":
        await demo.record(args.relay, args.room, need(args.out, "--out"), media=None, **common)
    elif args.agent == "generate":
        media, out = need(args.media, "--media"), need(args.out, "--out")
        await demo.generate(
            args.relay, args.room, media, out, lead_in_s=args.lead_in_s, tail_s=args.tail_s, slides=slides, **common
        )
    elif args.agent == "session":
        from .archive.slices import default_root
        from .session import gap_s, live_agents

        recording = need(args.recording, "--recording")
        await demo.session(
            args.relay,
            args.room,
            recording,
            media=args.media,
            slides=slides,
            live=live_agents(),
            gap_s=gap_s() if args.gap_s is None else args.gap_s,
            archive_root=default_root(),
            **common,
        )
    else:
        from .archive.slices import default_root

        await demo.serve_recording(
            args.relay, args.room, archive_root=default_root(), media=args.media, slides=slides, **common
        )


def _offline(args: argparse.Namespace) -> None:
    from .archive.slices import default_root

    if args.agent == "find-regions":
        _find_regions(args)
        return
    recording = need(args.recording, "--recording")
    if args.agent == "record-archive":
        from .recording_room import record_archive
        from .session import recording_room

        room = args.room or recording_room(recording.resolve().name)
        built = record_archive(recording, parse_room(room), default_root(), media=args.media)
        print(f"{built.room}: E {built.epoch_ms}, {built.end_ms / 1000:.1f} s, {len(built.tracks)} AI tracks")
    else:
        from .resegment import cue_report
        from .revise import read_recording

        print(f"{recording.name}: {cue_report(read_recording(recording))}")


def _find_regions(args: argparse.Namespace) -> None:
    """``find-regions``: the lecture's slide and webcam regions into ``regions.json`` beside it; with ``--sheet``, a
    JPEG to check them by eye (it holds the lecture's slides: look, then delete it; never commit or serve it)."""
    from .regions import beside, contact_sheet, find_regions
    from .slideshow import find_slides

    media = args.media or need(args.recording, "--media or --recording") / "lecture.mp4"
    started = time.monotonic()
    found = find_regions(media)
    regions = found.regions
    regions.write(beside(media))
    print(f"{beside(media)}: slides {regions.to_json()['slides']}, camera {regions.to_json()['camera']}", end="")
    print(f" ({len(regions.camera_spans)} places)" if regions.camera_spans else "", end="")
    print(f", {time.monotonic() - started:.0f} s")
    if args.sheet is not None:
        slides = find_slides(media, regions.slides)
        args.sheet.write_bytes(contact_sheet(media, regions, slides, found.sample_ms))
        print(f"{args.sheet}: {len(slides)} slides cut from the slide region")


async def _revise(args: argparse.Namespace) -> None:
    from . import revise
    from .regions import beside, load, resolve, slides_spec

    recording = need(args.recording, "--recording")
    if args.agent == "repunctuate":
        await _repunctuate(args, recording)
        return
    describer = make_llm(args.fake, args.room)
    media = args.media or recording / "lecture.mp4"
    crop = resolve(slides_spec(args.slides or "full"), load(beside(media)))
    assert crop is not None
    patch = await revise.redescribe(recording, media, crop, describer, agent=args.target_agent or "describe")
    logging.getLogger("talk_tracks.revise").info("redescribe: %d slides described, %s", len(patch.notes), patch.usage)


async def _repunctuate(args: argparse.Namespace, recording: Path) -> None:
    from . import repunctuate as rp

    punctuator: rp.Punctuator
    if args.fake or args.dry_run:
        punctuator = rp.FakePunctuator(usd_per_call=env_float("TT_FAKE_USD_PER_CALL", 0))
    else:
        punctuator = rp.MetaPunctuator(api_key(), room_ledger(args.room, spend_ledger()))
    result = await rp.repunctuate(recording, punctuator, dry_run=args.dry_run)
    plan = result.plan
    print(
        f"{recording.name}: {plan.agent}: {plan.lines} lines to send ({plan.chars} characters, about "
        f"${plan.usd:.4f} at most), {plan.saved} already saved"
    )
    print(f"  before: {result.before}")
    if result.written:
        print(f"  after:  {result.after}")
        print(
            f"  {result.changed} lines changed, {result.kept} words the model changed kept as recorded, {result.usage}"
        )
    else:
        print(f"  with what is saved: {result.after}")
        print("  dry run: nothing sent, nothing written")


def need(value: Path | None, flag: str) -> Path:
    if value is None:
        sys.exit(f"{flag} is required")
    return value


def parse(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="talk_tracks", description=__doc__.splitlines()[0] if __doc__ else None)
    p.add_argument("agent", choices=AGENTS + DEV + DEMO + REVISE + OFFLINE)
    p.add_argument("--relay", default=os.environ.get("TT_RELAY"), help="moqt://host:port or https://host:port/path")
    p.add_argument("--room", default=os.environ.get("TT_ROOM"))
    p.add_argument("--rooms", default=os.environ.get("TT_ROOMS") or None, help="agents: '*' for any room, or a,b")
    p.add_argument(
        "--lang", default=None, help="language of the output (translate: a,b or any, the default: every listed one)"
    )
    p.add_argument(
        "--agent",
        dest="target_agent",
        default=None,
        metavar="NAME",
        help="redescribe: the recording's agent track (default: describe)",
    )
    p.add_argument("--token", default=os.environ.get("TT_TOKEN"), help="signed relay token for publishing")
    p.add_argument("--fake", action="store_true", help="scripted speech recognition and a fake model: no API calls")
    p.add_argument("--insecure", action="store_true", help="skip TLS verification (local relay, self-signed cert)")
    p.add_argument("--wav", type=Path, default=None, help="teacher: a 16-bit WAV file to loop instead of a tone")
    p.add_argument("--image", type=Path, action="append", default=[], help="slides: a PNG or JPEG slide (repeatable)")
    p.add_argument("--watch", default="captions,describe,chapters", help="watch: the agents to print")
    p.add_argument(
        "--media",
        type=Path,
        default=None,
        help="play, generate, session, serve-recording, record-archive, find-regions: the lecture (MP4, H.264 + Opus;"
        " default the recording's)",
    )
    p.add_argument("--out", type=Path, default=None, help="record, generate: the recording directory to write")
    p.add_argument(
        "--recording",
        type=Path,
        default=None,
        help="session, record-archive, cue-report, find-regions, repunctuate, redescribe: the recording directory",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="repunctuate: send nothing and write nothing; print the lines it would send, the estimate and cue report",
    )
    p.add_argument("--loops", type=int, default=None, help="play: how many times (default: forever)")
    p.add_argument(
        "--gap-s",
        type=float,
        default=None,
        help="session: seconds between a session's end and the next one's start (default TT_DEMO_SESSION_GAP_S or 30)",
    )
    p.add_argument("--lead-in-s", type=float, default=5.0, help="generate: wait before the lecture starts")
    p.add_argument("--tail-s", type=float, default=15.0, help="generate: keep recording after the lecture ends")
    p.add_argument(
        "--slides",
        nargs="?",
        const="full",
        default=None,
        help="play, generate: also send the slides found in the video, cropped to x,y,w,h (fractions; default full)"
        " or to the lecture's slide region with 'auto' (regions.json from find-regions; the whole frame without it);"
        " session, serve-recording: also send them as the speaker's deck and slide tracks (a live-agents session"
        " also sends the frames, for describe)",
    )
    p.add_argument(
        "--sheet",
        type=Path,
        default=None,
        help="find-regions: also write a JPEG to check the regions by eye (it holds the slides: delete it after)",
    )
    args = p.parse_args(argv)
    if args.agent not in AGENTS:
        args.rooms = None
    if args.agent not in REVISE and args.lang is None and args.agent != "translate":
        args.lang = "en"
    need_relay = args.agent not in REVISE + OFFLINE
    need_room = args.agent not in OFFLINE and not (args.agent == "repunctuate" and args.dry_run)
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
