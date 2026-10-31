"""The archiver's MoQ side: the room service. It records what browsers publish and publishes each room's catalog.

Runs in the agents' Docker image (aiomoqt). One namespace subscription on ``talk`` finds every room as it appears
(aiomoqt delivers a session's namespace messages through one queue, so there is exactly one):

* ``<room>/teacher``: ``catalog.json``, then every legacy-container track it names, into fMP4 segments and HLS
  playlists in room time (design §4.5). A catalog without a root ``clock`` is refused: no track is read;
* ``<room>/slides``: ``frames``, and the speaker's event tracks (deck, slide, ink, marks, pointer), mirrored into the
  archive and served by FETCH on ``<room>/archive/slides`` (``archive.events``, decision 0022);
* ``<room>/agents/<agent>``: never subscribed. A subscription is demand and keeps a lazy agent awake; agents record
  their own slices (decision 0012). Their announcements only list them in the catalog;
* ``<room>/catalog``: published here (``archive.catalog``), with the room's epoch and each broadcast's shift as soon
  as they are decided, since consumers stamp nothing before; beside it the ``room`` track (on air, paused, or ended
  by the speaker), which the room service archives and serves by FETCH like an agent's track.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from ..contracts import ROOT, SlideFrame, slides_path, teacher_path
from ..lecture import AUDIO_TRACK, CATALOG_TRACK
from ..moq import AUDIO_IDLE_S, Relay, TrackWriter
from ..room_catalog import CATALOG_TRACK as ROOM_CATALOG_TRACK
from ..room_catalog import catalog_path, speaker_sources
from ..runtime import now_ms
from .audience import Audience
from .catalog import REFRESH_S, CatalogFeed
from .create import CreateConfig
from .events import RoomEvents
from .listeners import EndpointConfig
from .store import Archive, RoomArchive, RoomFilter

log = logging.getLogger("talk_tracks.archive")

TICK_S = 1.0


@dataclass
class _Room:
    catalog: CatalogFeed
    events: RoomEvents
    agents: dict[str, set[str]] = field(default_factory=dict[str, set[str]])  # agent -> its announced paths
    teacher: dict[str, asyncio.Task[None]] = field(default_factory=dict[str, asyncio.Task[None]])
    slides: asyncio.Task[None] | None = None
    writer: TrackWriter | None = None
    sent_s: float = 0.0


class Archiver:
    def __init__(
        self,
        relay: Relay,
        archive: Archive,
        rooms: RoomFilter,
        *,
        on_tick: Callable[[], None] | None = None,
        publish_catalog: bool = True,
        capped: Callable[[str], bool] | None = None,
        described: Callable[[str], tuple[str | None, str | None] | None] | None = None,
    ) -> None:
        self.relay, self.archive, self.wanted = relay, archive, rooms
        self.on_tick, self.publish_catalog, self.capped = on_tick, publish_catalog, capped
        self.described = described  # a created room's title and speaker (decision 0025)
        self.rooms: dict[str, _Room] = {}
        self._wake = asyncio.Event()  # a room's clock changed: publish without waiting for the tick

    def _spawn(self, work: Coroutine[Any, Any, None], name: str) -> asyncio.Task[None]:
        task = asyncio.create_task(work, name=name)
        task.add_done_callback(self._done)
        return task

    @staticmethod
    def _done(task: asyncio.Task[None]) -> None:
        if not task.cancelled() and task.exception() is not None:
            log.error("reader %s stopped", task.get_name(), exc_info=task.exception())

    async def run(self) -> None:
        for name in self.archive.known_rooms():  # their catalog carries E and the shifts
            if self.wanted(name):
                self._spawn(self._room(name).events.restore(), f"{name}/history")  # their talks stay fetchable
        ticker = asyncio.create_task(self._tick())
        try:
            async for path, active in self.relay.announced(ROOT):
                self.announced(path, active)
        finally:
            ticker.cancel()
            for room in self.rooms.values():
                for task in [*room.teacher.values(), *([room.slides] if room.slides else [])]:
                    task.cancel()
                await room.events.close()

    async def _tick(self) -> None:
        while True:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._wake.wait(), TICK_S)
            self._wake.clear()
            try:
                self.archive.tick(now_ms())
                if self.on_tick is not None:
                    self.on_tick()
            except Exception:
                log.exception("archive tick failed")
            for name, room in list(self.rooms.items()):
                try:
                    await self._events(name, room)
                except Exception:
                    log.exception("room %s: its event tracks failed", name)
            if self.publish_catalog:
                for name, room in list(self.rooms.items()):
                    try:
                        await self._publish(name, room)
                    except Exception:
                        log.exception("room %s: publishing the catalog failed", name)

    def _room(self, room: str) -> _Room:
        state = self.rooms.get(room)
        if state is None:
            catalog = CatalogFeed(room, self.archive.root, capped=self.capped)
            events = RoomEvents(
                room,
                self.relay,
                self.archive.root,
                on_file=self._finished,
                room_now=lambda: room_now(self.archive.room(room), now_ms()),
            )
            state = self.rooms[room] = _Room(catalog, events)
            if self.described is not None and (meta := self.described(room)) is not None:
                events.describe(*meta)
        return state

    async def audience(self, room: str) -> Audience | None:
        """A room's listener writes (the endpoint's lookup): only for a room this service holds, one a speaker has
        opened or the archive keeps; never a folder made for any name a stranger tries."""
        state = self.rooms.get(room)
        if state is None or not self.wanted(room):
            return None
        return await state.events.audience_tracks()

    def holds(self, room: str) -> bool:
        """The room is in use: a speaker opened it or the archive keeps it (room creation's ``taken``)."""
        return room in self.rooms or room in self.archive.known_rooms()

    def created(self, room: str, title: str, speaker: str | None) -> None:
        """A room was created (or re-issued) with this title and speaker: its state track carries them."""
        if self.wanted(room):
            self._room(room).events.describe(title, speaker)

    async def end(self, room: str) -> int | None:
        """The speaker ended the room's talk (the endpoint's ``end``): its room track says ``ended``."""
        state = self.rooms.get(room)
        if state is None or not self.wanted(room):
            return None
        return await state.events.end()

    def _finished(self, path: Path) -> None:
        self.archive.reported(path, mutable=False)  # a finished event slice: copied to the bucket

    async def _events(self, name: str, room: _Room) -> None:
        """The room's event tracks follow its newest teacher media: the ``room`` track and the mirrored slices."""
        archived = self.archive.room(name)
        run = archived.run
        room_ms = run.clock_ms if run is not None and archived.epoch_ms is not None else None
        await room.events.tick(room_ms, live=archived.live)

    async def _publish(self, name: str, room: _Room) -> None:
        cat, archived = room.catalog, self.archive.room(name)
        cat.epoch_ms, cat.shift = archived.epoch_ms, archived.shift
        cat.event_tracks = room.events.catalog_tracks()
        kinds = {config.kind for config in archived.teacher.catalog.values()} if archived.live else set[str]()
        cat.sources = speaker_sources(
            name, audio="audio" in kinds, camera="video" in kinds, slides=room.events.slides_on_air()
        )
        data = cat.changed()
        now = time.monotonic()
        if data is None:
            if now - room.sent_s < REFRESH_S:
                return
            data = cat.latest
        if data is None:
            return
        if room.writer is None:
            room.writer = await self.relay.publish(catalog_path(name), ROOM_CATALOG_TRACK)
        await room.writer.write(data)
        room.sent_s = now

    def announced(self, path: str, active: bool) -> None:
        parts = path.split("/")
        if len(parts) < 2 or not self.wanted(parts[0]):
            return
        room, kind = parts[0], parts[1]
        state = self._room(room)
        state.events.announced(f"{ROOT}/{path}", active)  # the speaker's event tracks, by their catalog namespaces
        if kind == "teacher" and len(parts) == 2:
            if active and not state.teacher:
                log.info("room %s: archiving the teacher broadcast", room)
                state.teacher[CATALOG_TRACK] = self._spawn(self._catalog(room, state), f"{room}/catalog")
            elif not active:
                for task in state.teacher.values():
                    task.cancel()
                state.teacher.clear()
                self.archive.room(room).teacher_gone()
        elif kind == "slides" and len(parts) == 2:
            if active and state.slides is None:
                state.slides = self._spawn(self._slides(room), f"{room}/slides")
            elif not active and state.slides is not None:
                state.slides.cancel()
                state.slides = None
        elif kind == "agents" and len(parts) >= 3:
            paths = state.agents.setdefault(parts[2], set())
            log.info("room %s: agent %s %s", room, parts[2], "announced" if active else "gone")
            if active:
                paths.add(path)
            else:
                paths.discard(path)
            state.catalog.agents = {agent for agent, held in state.agents.items() if held}

    async def _catalog(self, room: str, state: _Room) -> None:
        async for payload in self.relay.objects(teacher_path(room), CATALOG_TRACK):
            archived = self.archive.room(room)
            if not archived.catalog(payload, now_ms()):
                continue  # no clock: refused
            for track in archived.teacher.catalog:
                if track not in state.teacher:
                    state.teacher[track] = self._spawn(self._media(room, track), f"{room}/{track}")

    async def _media(self, room: str, track: str) -> None:
        idle = AUDIO_IDLE_S if track == AUDIO_TRACK else None
        archived = self.archive.room(room)
        async for payload in self.relay.objects(teacher_path(room), track, idle_s=idle):
            known = len(archived.shift), archived.epoch_ms
            self._safely(f"{room}/{track}", archived.media, track, payload, now_ms())
            if (len(archived.shift), archived.epoch_ms) != known:
                self._wake.set()  # a new broadcast's shift: consumers wait for it

    async def _slides(self, room: str) -> None:
        async for payload in self.relay.objects(slides_path(room), "frames"):
            try:
                frame = SlideFrame.model_validate_json(payload)
            except ValidationError:
                log.warning("room %s: skipping a slide frame that does not match the contract", room)
                continue
            self._safely(f"{room}/slides", self.archive.room(room).slide, frame, now_ms())

    @staticmethod
    def _safely(what: str, write: Callable[..., object], *args: Any) -> None:
        """A disk error on one object is logged; the reader carries on with the next."""
        try:
            write(*args)
        except OSError:
            log.exception("archiving %s failed", what)


def room_now(archived: RoomArchive, wall_ms: int) -> int | None:
    """Room time now for what listeners write: the newest teacher media time plus the time since it arrived, so
    their ink sits on the speaker's clock as the speaker's own does. None before the room's first media."""
    run = archived.run
    if archived.epoch_ms is None or run is None or run.index.media_last_ms is None:
        return None
    return max(0, run.clock_ms + max(0, wall_ms - run.index.last_wall_ms))


def _log_failure(task: asyncio.Task[None]) -> None:
    if not task.cancelled() and task.exception() is not None:
        log.error("%s stopped", task.get_name(), exc_info=task.exception())


async def archive_rooms(
    relay: Relay,
    archive: Archive,
    rooms: RoomFilter,
    *,
    on_tick: Callable[[], None] | None = None,
    publish_catalog: bool = True,
    capped: Callable[[str], bool] | None = None,
    listeners: EndpointConfig | None = None,
    creation: CreateConfig | None = None,
) -> None:
    registry = creation.registry() if creation is not None else None

    def described(room: str) -> tuple[str | None, str | None] | None:
        found = registry.created(room) if registry is not None else None
        return (found.title, found.speaker) if found is not None else None

    archiver = Archiver(
        relay, archive, rooms, on_tick=on_tick, publish_catalog=publish_catalog, capped=capped, described=described
    )
    servers: list[asyncio.Task[None]] = []
    if listeners is not None:
        servers.append(asyncio.create_task(listeners.run(archiver.audience, archiver.end)))
    if creation is not None:
        servers.append(asyncio.create_task(creation.run(archiver.holds, archiver.created)))
    for server in servers:
        server.add_done_callback(_log_failure)
    try:
        await archiver.run()
    finally:
        for server in servers:
            server.cancel()
        with contextlib.suppress(Exception):
            archive.close()
