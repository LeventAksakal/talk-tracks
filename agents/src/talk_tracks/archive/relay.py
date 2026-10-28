"""The archiver's MoQ side: follow every room under ``talk/**`` and feed what arrives to the archive.

Runs in the agents' Docker image (aiomoqt). One namespace subscription on ``talk`` finds every room as it appears
(aiomoqt delivers a session's namespace messages through one queue, so there is exactly one), and each announced
broadcast gets its readers:

* ``<room>/teacher``: ``catalog.json``, then every legacy-container track it names (``audio`` straight away, so a
  broadcast without a catalog is archived too);
* ``<room>/slides``: ``frames``;
* ``<room>/agents/<agent>/<instance>``: ``state`` of each agent's newest instance (``RoomFollower``), heartbeats
  dropped.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from ..contracts import ROOT, SlideFrame, agents_prefix, slides_path, teacher_path
from ..follow import RoomFollower
from ..lecture import AUDIO_TRACK, CATALOG_TRACK
from ..moq import AUDIO_IDLE_S, Relay
from ..runtime import now_ms
from .store import Archive, RoomFilter

log = logging.getLogger("talk_tracks.archive")

TICK_S = 1.0


@dataclass
class _Room:
    follower: RoomFollower = field(default_factory=RoomFollower)
    agents: dict[str, asyncio.Task[None]] = field(default_factory=dict[str, asyncio.Task[None]])
    teacher: dict[str, asyncio.Task[None]] = field(default_factory=dict[str, asyncio.Task[None]])
    slides: asyncio.Task[None] | None = None


class Archiver:
    def __init__(self, relay: Relay, archive: Archive, rooms: RoomFilter) -> None:
        self.relay, self.archive, self.wanted = relay, archive, rooms
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
        ticker = asyncio.create_task(self._tick())
        try:
            async for path, active in self.relay.announced(ROOT):
                self.announced(path, active)
        finally:
            ticker.cancel()
            for room in self.rooms.values():
                for task in [*room.agents.values(), *room.teacher.values(), room.slides]:
                    if task is not None:
                        task.cancel()

    async def _tick(self) -> None:
        while True:
            await asyncio.sleep(TICK_S)
            try:
                self.archive.tick(now_ms())
            except Exception:
                log.exception("archive tick failed")

    def announced(self, path: str, active: bool) -> None:
        parts = path.split("/")
        if len(parts) < 2 or not self.wanted(parts[0]):
            return
        room, kind = parts[0], parts[1]
        state = self.rooms.setdefault(room, _Room())
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
            if active and state.slides is None:
                state.slides = self._spawn(self._slides(room), f"{room}/slides")
            elif not active and state.slides is not None:
                state.slides.cancel()
                state.slides = None
        elif kind == "agents" and len(parts) == 4 and active:
            found = state.follower.offer(f"{parts[2]}/{parts[3]}")
            if found is not None:
                agent, instance = found
                log.info("room %s: archiving %s instance %s", room, agent, instance)
                if agent in state.agents:
                    state.agents[agent].cancel()
                state.agents[agent] = self._spawn(self._agent(room, state, agent, instance), f"{room}/{agent}")

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

    async def _agent(self, room: str, state: _Room, agent: str, instance: str) -> None:
        async for payload in self.relay.objects(f"{agents_prefix(room)}/{agent}/{instance}", "state"):
            try:
                envelope = state.follower.accept(agent, payload)
            except ValueError:
                log.warning("room %s: skipping an object from %s that does not match the contract", room, agent)
                continue
            if envelope is not None:
                self._safely(f"{room}/{agent}", self.archive.room(room).snapshot, envelope, now_ms())

    @staticmethod
    def _safely(what: str, write: Callable[..., object], *args: Any) -> None:
        """A disk error on one object is logged; the reader carries on with the next."""
        try:
            write(*args)
        except OSError:
            log.exception("archiving %s failed", what)


async def archive_rooms(relay: Relay, archive: Archive, rooms: RoomFilter) -> None:
    archiver = Archiver(relay, archive, rooms)
    try:
        await archiver.run()
    finally:
        with contextlib.suppress(Exception):
            archive.close()
