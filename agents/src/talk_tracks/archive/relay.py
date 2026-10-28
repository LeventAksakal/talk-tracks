"""The archiver's MoQ side: the room service. It records what browsers publish and publishes each room's catalog.

Runs in the agents' Docker image (aiomoqt). One namespace subscription on ``talk`` finds every room as it appears
(aiomoqt delivers a session's namespace messages through one queue, so there is exactly one):

* ``<room>/teacher``: ``catalog.json``, then every legacy-container track it names (``audio`` straight away, so a
  broadcast without a catalog is archived too), into fMP4 segments;
* ``<room>/slides``: ``frames``, and ``clock``, the room clock (design §4.5): media is written in room time, the
  speaker's timestamps plus the broadcast's offset;
* ``<room>/agents/<agent>``: never subscribed. A subscription is demand and keeps a lazy agent awake; agents record
  their own slices (decision 0012). Their announcements only list them in the catalog;
* ``<room>/catalog``: published here (``archive.catalog``).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from ..contracts import ROOT, SlideFrame, slides_path, teacher_path
from ..lecture import AUDIO_TRACK, CATALOG_TRACK
from ..moq import AUDIO_IDLE_S, Relay, TrackWriter
from ..runtime import now_ms
from .catalog import REFRESH_S, TRACK, RoomCatalog, catalog_path
from .store import DEFAULT_AUDIO, Archive, RoomClock, RoomFilter

log = logging.getLogger("talk_tracks.archive")

TICK_S = 1.0
CLOCK_TRACK = "clock"


@dataclass
class _Room:
    catalog: RoomCatalog
    agents: dict[str, set[str]] = field(default_factory=dict[str, set[str]])  # agent -> its announced paths
    teacher: dict[str, asyncio.Task[None]] = field(default_factory=dict[str, asyncio.Task[None]])
    slides: list[asyncio.Task[None]] = field(default_factory=list[asyncio.Task[None]])
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
    ) -> None:
        self.relay, self.archive, self.wanted = relay, archive, rooms
        self.on_tick, self.publish_catalog = on_tick, publish_catalog
        self.rooms: dict[str, _Room] = {}

    def _spawn(self, work: Coroutine[Any, Any, None], name: str) -> asyncio.Task[None]:
        task = asyncio.create_task(work, name=name)
        task.add_done_callback(self._done)
        return task

    @staticmethod
    def _done(task: asyncio.Task[None]) -> None:
        if not task.cancelled() and task.exception() is not None:
            log.error("reader %s stopped", task.get_name(), exc_info=task.exception())

    async def run(self) -> None:
        for name in self.archive.known_rooms():  # their catalog carries epoch_ms and end_ms for the next broadcast
            if self.wanted(name):
                self._room(name)
        ticker = asyncio.create_task(self._tick())
        try:
            async for path, active in self.relay.announced(ROOT):
                self.announced(path, active)
        finally:
            ticker.cancel()
            for room in self.rooms.values():
                for task in [*room.teacher.values(), *room.slides]:
                    task.cancel()

    async def _tick(self) -> None:
        while True:
            await asyncio.sleep(TICK_S)
            try:
                self.archive.tick(now_ms())
                if self.on_tick is not None:
                    self.on_tick()
            except Exception:
                log.exception("archive tick failed")
            if self.publish_catalog:
                for name, room in list(self.rooms.items()):
                    try:
                        await self._publish(name, room)
                    except Exception:
                        log.exception("room %s: publishing the catalog failed", name)

    def _room(self, room: str) -> _Room:
        state = self.rooms.get(room)
        if state is None:
            state = self.rooms[room] = _Room(RoomCatalog(room, self.archive.root))
        return state

    async def _publish(self, name: str, room: _Room) -> None:
        cat, archived = room.catalog, self.archive.room(name)
        cat.teacher = (archived.teacher.catalog or {AUDIO_TRACK: DEFAULT_AUDIO}) if room.teacher else None
        cat.epoch_ms, cat.media_end_ms = archived.epoch_ms, archived.end_ms
        data = cat.changed()
        now = time.monotonic()
        if data is None:
            if now - room.sent_s < REFRESH_S:
                return
            data = cat.latest
        if data is None:
            return
        if room.writer is None:
            room.writer = await self.relay.publish(catalog_path(name), TRACK)
        await room.writer.write(data)
        room.sent_s = now

    def announced(self, path: str, active: bool) -> None:
        parts = path.split("/")
        if len(parts) < 2 or not self.wanted(parts[0]):
            return
        room, kind = parts[0], parts[1]
        state = self._room(room)
        if kind == "teacher" and len(parts) == 2:
            if active and not state.teacher:
                log.info("room %s: archiving the teacher broadcast", room)
                state.teacher[CATALOG_TRACK] = self._spawn(self._catalog(room, state), f"{room}/catalog")
                state.teacher[AUDIO_TRACK] = self._spawn(self._media(room, AUDIO_TRACK), f"{room}/{AUDIO_TRACK}")
            elif not active:
                for task in state.teacher.values():
                    task.cancel()
                state.teacher.clear()
                self.archive.room(room).teacher_gone()
        elif kind == "slides" and len(parts) == 2:
            state.catalog.slides = active
            if active and not state.slides:
                state.slides = [
                    self._spawn(self._slides(room), f"{room}/slides"),
                    self._spawn(self._clock(room), f"{room}/clock"),
                ]
            elif not active:
                for task in state.slides:
                    task.cancel()
                state.slides = []
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
            archived.catalog(payload, now_ms())
            for track in archived.teacher.catalog:
                if track not in state.teacher:
                    state.teacher[track] = self._spawn(self._media(room, track), f"{room}/{track}")

    async def _media(self, room: str, track: str) -> None:
        idle = AUDIO_IDLE_S if track == AUDIO_TRACK else None
        async for payload in self.relay.objects(teacher_path(room), track, idle_s=idle):
            self._safely(f"{room}/{track}", self.archive.room(room).media, track, payload, now_ms())

    async def _slides(self, room: str) -> None:
        async for payload in self.relay.objects(slides_path(room), "frames"):
            try:
                frame = SlideFrame.model_validate_json(payload)
            except ValidationError:
                log.warning("room %s: skipping a slide frame that does not match the contract", room)
                continue
            self._safely(f"{room}/slides", self.archive.room(room).slide, frame, now_ms())

    async def _clock(self, room: str) -> None:
        async for payload in self.relay.objects(slides_path(room), CLOCK_TRACK):
            try:
                clock = RoomClock.model_validate_json(payload)
            except ValidationError:
                log.warning("room %s: skipping a clock object that does not match the design", room)
                continue
            self._safely(f"{room}/clock", self.archive.room(room).clock, clock, now_ms())

    @staticmethod
    def _safely(what: str, write: Callable[..., object], *args: Any) -> None:
        """A disk error on one object is logged; the reader carries on with the next."""
        try:
            write(*args)
        except OSError:
            log.exception("archiving %s failed", what)


async def archive_rooms(
    relay: Relay,
    archive: Archive,
    rooms: RoomFilter,
    *,
    on_tick: Callable[[], None] | None = None,
    publish_catalog: bool = True,
) -> None:
    archiver = Archiver(relay, archive, rooms, on_tick=on_tick, publish_catalog=publish_catalog)
    try:
        await archiver.run()
    finally:
        with contextlib.suppress(Exception):
            archive.close()
