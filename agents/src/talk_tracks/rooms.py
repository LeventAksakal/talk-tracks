"""Which rooms an agent serves: every room a speaker opens (``*``), or the rooms in a list. Transport-free.

An agent process watches speakers come on air (``talk/<room>/teacher`` announced) and serves each wanted room on a
connection of its own. A room whose speaker left is kept for ``linger_s``, so a reload or a short break keeps the
agent's track and its history; after that the room's agent stops and withdraws its track. A talk the speaker ended
(End talk: the room service's ``room`` track says ``ended``) stops its agents as soon as the speaker has left, with no
linger.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Callable, Coroutine, Iterable
from typing import Any

from pydantic import ValidationError

from .contracts import ROOM_TRACK, RoomStateObject, catalog_path

log = logging.getLogger("talk_tracks")

ROOM_LINGER_S = 600.0
TALK_OVER = "talk over"  # the cancel message of a room whose speaker stayed away: its agents end their tracks


class RoomPolicy:
    def __init__(self, rooms: str, exclude: Iterable[str] = ()) -> None:
        """``rooms`` is ``*`` for any room, or a comma-separated list; ``exclude`` wins over both (the demo room)."""
        names = {r.strip() for r in rooms.split(",") if r.strip()}
        self.any = "*" in names
        self.rooms = frozenset(names - {"*"})
        self.exclude = frozenset(r.strip() for r in exclude if r.strip())

    def wants(self, room: str) -> bool:
        return room not in self.exclude and (self.any or room in self.rooms)


Joined = Callable[[str, str], AsyncIterator[tuple[int, int, bytes]]]  # ``moq.Relay.joined``: (group, object, payload)


async def room_ended(joined: Joined, room: str) -> None:
    """Return once the room's ``room`` track (published by the room service on ``talk/<room>/catalog``) says the
    speaker ended the talk. A carry-in (object 0) only repeats the state before its slice, so it is not read: after
    an end the speaker may start again, and that slice's carry-in still says ``ended``."""
    async for _, object_id, payload in joined(catalog_path(room), ROOM_TRACK):
        if object_id == 0:
            continue
        try:
            records = RoomStateObject.model_validate_json(payload).root
        except ValidationError:
            continue
        if records and records[-1].data.state == "ended":
            return


async def serve_rooms(
    on_air: AsyncIterator[tuple[str, bool]],
    policy: RoomPolicy,
    serve: Callable[[str], Coroutine[Any, Any, None]],
    *,
    linger_s: float = ROOM_LINGER_S,
    ended: Callable[[str], Coroutine[Any, Any, None]] | None = None,
) -> None:
    """Run ``serve(room)`` for each wanted room while its speaker is on air (plus the linger). ``ended(room)``
    returns once the room's talk is over (``room_ended``): a room whose speaker left stops then, without waiting for
    the rest of the linger. A room that fails raises here, so the process exits and restarts with every room, as a
    single-room agent does."""
    running: dict[str, asyncio.Task[None]] = {}
    stopping: dict[str, asyncio.Task[None]] = {}
    failed: asyncio.Future[BaseException] = asyncio.get_running_loop().create_future()

    def done(room: str, task: asyncio.Task[None]) -> None:
        if running.get(room) is task:
            del running[room]
        if not task.cancelled() and (exc := task.exception()) is not None and not failed.done():
            failed.set_result(exc)

    async def away(room: str) -> str:
        """Wait for the linger, or less if the talk was ended; why the room stops."""
        if ended is None:
            await asyncio.sleep(linger_s)
            return f"speaker gone for {linger_s:.0f} s"
        loop = asyncio.get_running_loop()
        until = loop.time() + linger_s
        watch = asyncio.ensure_future(ended(room))
        try:
            done, _ = await asyncio.wait({watch}, timeout=linger_s)
            if watch in done and watch.exception() is None:
                return "the speaker ended the talk"
            if watch in done:
                log.warning("room %s: watching for the end of the talk failed: %s", room, watch.exception())
                await asyncio.sleep(max(0.0, until - loop.time()))
            return f"speaker gone for {linger_s:.0f} s"
        finally:
            watch.cancel()

    async def stop_later(room: str) -> None:
        why = await away(room)
        log.info("room %s: %s, stopping", room, why)
        stopping.pop(room, None)
        if task := running.get(room):
            task.cancel(TALK_OVER)

    async def follow() -> None:
        async for room, active in on_air:
            if not policy.wants(room):
                continue
            if active:
                if stopper := stopping.pop(room, None):
                    stopper.cancel()
                if room not in running:
                    log.info("room %s: speaker on air, serving", room)
                    task = asyncio.create_task(serve(room))
                    task.add_done_callback(lambda t, r=room: done(r, t))
                    running[room] = task
            elif room in running and room not in stopping:
                stopping[room] = asyncio.create_task(stop_later(room))

    watcher = asyncio.create_task(follow())
    try:
        await asyncio.wait({watcher, failed}, return_when=asyncio.FIRST_COMPLETED)
        if failed.done():
            raise failed.result()
        watcher.result()
    finally:
        watcher.cancel()
        for task in [*running.values(), *stopping.values()]:
            task.cancel()
        for task in [*running.values(), *stopping.values()]:
            with contextlib.suppress(BaseException):
                await task
