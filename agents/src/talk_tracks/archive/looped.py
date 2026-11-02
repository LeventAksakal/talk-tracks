"""A looped demo room at the room service: its chat and its stats track, nothing else (decisions 0027, 0028).

The looper publishes the rest of the room (the teacher's media, the slides, the agents' tracks and the room catalog;
``demo.loop``), and its recording is the room's archive, so the room service archives nothing of it: no media, no
event tracks, no catalog. It only reads two catalogs off the relay, the looper's room catalog (E, the tracks and the
agents' status) and the teacher's hang catalog (the media tracks), and publishes two tracks, which the looper's
catalog lists (``with_room_service``; one publisher per track name):

* ``talk/<room>/chat``: written over the listener WebSocket as in a live room (``archive.audience``: the same
  validation, stamps and rate limits; any other write is refused). It lives on the room clock, wall time minus E,
  which runs on across loops. A slice is written when a message is said and, while someone reads the chat, every
  4 s with its carry-in (the last 50 messages), so a drawer opened at any moment gets the history at once; when
  nobody reads and nobody writes, nothing is written. A rewind within the loop does not replay the chat (the
  player keeps it live in a looped room), so the slices are kept only to carry the conversation across restarts:
  in a folder of their own beside the archive (``TT_LOOPED_DIR``, never in the archive Caddy serves or the bucket
  copy), the newest ``KEEP_SLICES`` of them.
* ``talk/<room>/stats``: Stats for nerds, as in a live room (``archive.stats``): the teacher's media, the looper's
  catalog and every track it lists, the chat, and the agents (running while their status says producing), with any
  other agent announced in the room (``translate-any``) as its ``track.json`` in the archive folder describes it,
  read only, as the live room's catalog does.

Retention: every chat slice's object 0 is the last 50 messages (``chat_carry``), so slices written while a drawer is
open and nobody writes still carry the whole recent conversation; the newest slice alone seeds a restart.

Transport-free: the relay is ``LoopedRelay`` (``moq.Relay``), tests hand in a fake.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterator, Callable
from dataclasses import replace
from pathlib import Path
from typing import Protocol

from pydantic import ValidationError

from ..contracts import (
    CATALOG_TRACK,
    CHAT_TRACK,
    HANG_CATALOG_TRACK,
    STATS_TRACK,
    Author,
    ChatRecord,
    CommentRecord,
    InkRecord,
    MarkRecord,
    RoomCatalog,
    RoomStats,
    agents_prefix,
    catalog_path,
    chat_path,
    slides_path,
    stats_path,
    teacher_path,
)
from ..follow import catalog_tracks
from ..records import chat_carry
from ..room_catalog import EVENT_TYPES, CatalogTrack, room_service_tracks, stats_track
from ..room_catalog import RoomCatalog as BuiltCatalog
from ..runtime import now_ms
from .audience import Audience, Done, Refusal
from .catalog import CatalogFeed
from .events import HistoryOut, ServiceTrack, chat_records
from .slices import FINISHED, PART, TrackArchive
from .stats import Listed, RelayCounts, StatsOut, StatsTrack, room_stats
from .store import track_configs

log = logging.getLogger("talk_tracks.archive.looped")

KEEP_SLICES = 64  # chat slices kept on disk per looped room: the newest carries the conversation across restarts

# What a non-agent track of the looper's catalog is, by its event type (deck, slide, chat, stats).
_KINDS = {event: kind for kind, event in EVENT_TYPES.items() if kind not in ("captions", "translation")}


def looped_tracks(room: str) -> tuple[CatalogTrack, CatalogTrack]:
    """The room service's tracks in a looped room: the chat and the stats."""
    chat = next(t for t in room_service_tracks(room) if t.name == CHAT_TRACK)
    return chat, stats_track(room)


def with_room_service(catalog: BuiltCatalog, room: str) -> BuiltCatalog:
    """A looped room's catalog with the room service's chat and stats tracks, so the player finds them. The looper
    lists them; the room service publishes them."""
    return replace(catalog, tracks=(*catalog.tracks, *looped_tracks(room)))


class LoopedRelay(Protocol):
    """What a looped room needs of the relay (``moq.Relay``)."""

    def objects(self, namespace: str, track: str) -> AsyncIterator[bytes]: ...

    async def publish_sliced(self, namespace: str, track: str) -> HistoryOut: ...

    async def publish(self, namespace: str, track: str) -> StatsOut: ...


class _NoTrack[R]:
    """Ink, marks and comments in a looped room: none, and nothing is ever added (``ChatOnly`` refuses first)."""

    @property
    def records(self) -> list[R]:
        return []

    async def add(self, record: R) -> None:
        raise Refusal("forbidden", "A looped demo room takes chat only")


class ChatOnly(Audience):
    """A looped room's listener writes: chat, as in a live room; drawing, marks and comments are refused."""

    def __init__(self, chat: ServiceTrack[ChatRecord], *, now: Callable[[], int | None]) -> None:
        super().__init__(_NoTrack[InkRecord](), _NoTrack[MarkRecord](), _NoTrack[CommentRecord](), chat, now=now)

    async def write(self, by: Author, track: str, data: object, at: int | None = None) -> Done:
        if track != "chat":
            raise Refusal("forbidden", "A looped demo room takes chat only")
        return await super().write(by, track, data, at)


class LoopedRoom:
    """One looped room at the room service. ``announced`` follows the room's broadcasts, ``run`` reads its catalogs,
    ``tick`` about once a second writes the chat's slices and the stats."""

    def __init__(
        self,
        room: str,
        relay: LoopedRelay,
        root: Path,
        *,
        wall: Callable[[], int] = now_ms,
        keep: int = KEEP_SLICES,
        archive_root: Path | None = None,
    ) -> None:
        self.room, self.relay, self.root, self._wall, self._keep = room, relay, root, wall, max(1, keep)
        # Agents announced in the room; those the looper's catalog does not list are read from their track.json here.
        self.agents: set[str] = set()
        self._agent_tracks = CatalogFeed(room, archive_root) if archive_root is not None else None
        self.catalog: RoomCatalog | None = None  # the looper's, as last read
        self.media: dict[str, str] = {}  # the teacher's media tracks: name -> audio or video
        self.on_air = False  # the teacher broadcast is announced
        self.chat: ServiceTrack[ChatRecord] | None = None
        self.audience: ChatOnly | None = None
        self.stats: StatsTrack | None = None
        self._lock = asyncio.Lock()
        self.reader: asyncio.Task[None] | None = None  # ``run``, as the room service started it
        self._pruned: int | None = None  # the newest slice when the folder was last pruned

    # --- the room clock -------------------------------------------------------------------------------------------

    def room_now(self) -> int | None:
        """Room time now: wall time minus the looper's E, while the looper is on air; None before."""
        if self.catalog is None or not self.on_air:
            return None
        return max(0, self._wall() - self.catalog.tt.E)

    # --- what the looper publishes --------------------------------------------------------------------------------

    def announced(self, namespace: str, active: bool) -> None:
        if namespace == teacher_path(self.room):
            self.on_air = active
            if not active:
                self.media = {}
        prefix = f"{agents_prefix(self.room)}/"
        if namespace.startswith(prefix) and "/" not in (agent := namespace.removeprefix(prefix)) and agent:
            (self.agents.add if active else self.agents.discard)(agent)

    def feed_catalog(self, payload: bytes) -> None:
        try:
            self.catalog = RoomCatalog.model_validate_json(payload)
        except ValidationError:
            log.warning("%s: a room catalog that does not match the contract", self.room)

    def feed_teacher(self, payload: bytes) -> None:
        try:
            hang: object = json.loads(payload)
        except ValueError:
            log.warning("%s: a hang catalog that is not JSON", self.room)
            return
        self.media = {track: config.kind for track, config in track_configs(hang).items()}

    async def run(self) -> None:
        """Read the looper's room catalog and the teacher's hang catalog for as long as the service runs."""

        async def read(namespace: str, track: str, feed: Callable[[bytes], None]) -> None:
            async for payload in self.relay.objects(namespace, track):
                feed(payload)

        readers = [
            asyncio.create_task(read(catalog_path(self.room), CATALOG_TRACK, self.feed_catalog)),
            asyncio.create_task(read(teacher_path(self.room), HANG_CATALOG_TRACK, self.feed_teacher)),
        ]
        try:
            await asyncio.gather(*readers)
        finally:
            for task in readers:
                task.cancel()
            for task in readers:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task

    # --- the chat -------------------------------------------------------------------------------------------------

    def _archive(self) -> TrackArchive:
        return TrackArchive.of(chat_path(self.room), CHAT_TRACK, root=self.root)

    async def audience_tracks(self) -> ChatOnly:
        """The chat, published (live, its slices on disk, FETCH from them) on first use, seeded from the newest slice
        a room service before this one wrote."""
        async with self._lock:
            if self.audience is None:
                out = await self.relay.publish_sliced(chat_path(self.room), CHAT_TRACK)
                self.chat = ServiceTrack(
                    self._archive(), out, carry=lambda rs, _: chat_carry(rs), parse=chat_records, compact=chat_carry
                )
                self.chat.reopen()  # a slice a stopped room service left open is written afresh, live
                out.serve(self.chat.slice, None, self.chat.open_slice)
                self.audience = ChatOnly(self.chat, now=self.room_now)
                log.info(
                    "%s: publishing the chat of a looped room (%d messages kept)", self.room, len(self.chat.records)
                )
            return self.audience

    async def tick(self) -> None:
        """Once a second: the chat's open slice closes once over, and while someone reads the chat (and there is a
        conversation to carry) the slice of now opens with its carry-in. Then the old slices go."""
        await self.audience_tracks()
        chat, now = self.chat, self.room_now()
        assert chat is not None
        if now is None:
            await chat.close()  # the looper is gone: its slice is over
        else:
            reading = chat.out.subscribed() and bool(chat.records)
            await chat.at(max(now, chat.records[-1].m if chat.records else 0), active=reading)
        self.prune()

    def prune(self) -> None:
        """Keep the newest ``keep`` slices on disk (finished, or left open by a process before this one)."""
        chat = self.chat
        if chat is None or chat.newest is None or chat.newest == self._pruned:
            return
        self._pruned = chat.newest
        archive = chat.archive
        for group in archive.groups()[: -self._keep]:
            if group == chat.open_group:
                continue
            for suffix in (FINISHED, PART):
                with contextlib.suppress(FileNotFoundError):
                    archive.path(group, suffix).unlink()

    # --- the stats ------------------------------------------------------------------------------------------------

    async def tick_stats(self, counts: RelayCounts | None, listeners: Callable[[str], int]) -> bool:
        if self.stats is None:

            async def open_track() -> StatsOut:
                return await self.relay.publish(stats_path(self.room), STATS_TRACK)

            self.stats = StatsTrack(open_track, lambda: self.snapshot(counts, listeners(self.room), now_ms()))
        return await self.stats.tick()

    def snapshot(self, counts: RelayCounts | None, listeners: int, at_ms: int) -> RoomStats:
        """Every track of the room now: the teacher's media, the looper's speaker tracks (slides), its catalog, the
        room service's chat and stats, then the agents (running while their status says producing)."""
        room = self.room
        tracks: list[Listed] = [(teacher_path(room), name, kind, "", True) for name, kind in self.media.items()]
        cat = self.catalog
        if cat is not None:
            others = [t for t in cat.tracks if "/agents/" not in t.namespace]
            slides = [t for t in others if t.namespace == slides_path(room)]
            tracks += [
                (t.namespace, t.name, _KINDS.get(t.eventType or "", "event"), t.lang or "", True) for t in slides
            ]
            tracks.append((catalog_path(room), CATALOG_TRACK, "catalog", "", True))
            tracks += [
                (t.namespace, t.name, _KINDS.get(t.eventType or "", "event"), t.lang or "", True)
                for t in others
                if t not in slides
            ]
        tracks += [(t.namespace, t.name, t.kind, t.lang, True) for t in looped_tracks(room)]
        if cat is not None:
            status = {name: s.producing for name, s in cat.tt.status.items()}
            tracks += [(t.namespace, t.name, t.kind, t.lang, bool(status.get(t.agent))) for t in catalog_tracks(cat)]
        if self._agent_tracks is not None:
            listed = {t.agent for t in catalog_tracks(cat)} if cat is not None else set[str]()
            self._agent_tracks.agents = self.agents - listed
            more, live = self._agent_tracks.agent_tracks(at_ms)
            for t in more:
                producing = bool(live.get(t.namespace.rsplit("/", 1)[-1], {}).get("producing"))
                tracks.append((t.namespace, t.name, t.kind, t.lang, producing))
        return room_stats(tracks, counts, listeners, at_ms)
