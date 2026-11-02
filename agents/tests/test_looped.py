"""A looped demo room at the room service (decisions 0027, 0028): its chat and stats tracks, and nothing archived.

The looper publishes the room's media, slides, agent tracks and catalog; the room service reads the catalogs and
publishes only ``talk/<room>/chat`` and ``talk/<room>/stats`` there (``archive.looped``)."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import replace
from pathlib import Path
from typing import Any, cast

import pytest

from talk_tracks.archive.events import HistoryOut
from talk_tracks.archive.listeners import LIMITS, Endpoint, Identities, Session
from talk_tracks.archive.looped import CHAT_EPOCH_MS, LoopedRoom, with_room_service
from talk_tracks.archive.slices import NORMAL, Slice, TrackArchive, TrackInfo
from talk_tracks.archive.stats import StatsOut
from talk_tracks.contracts import SLICE_MS, ChatObject, ChatRecord, RoomStats, TrackStatus, slice_of
from talk_tracks.contracts import RoomCatalog as MsfCatalog
from talk_tracks.demo_slides import with_slides
from talk_tracks.room_catalog import RoomCatalog, translation_track
from talk_tracks.runtime import now_ms

ROOM = "virus"
E = CHAT_EPOCH_MS  # the chat clock: wall time minus it, in every session (the old looper's E)
CHAT = f"talk/{ROOM}/chat"
LOOP_MS = 40 * 60_000


# --- a relay: the looper's catalogs fed by the test, what the room service publishes kept ------------------------


class Out:
    def __init__(self) -> None:
        self.live: dict[int, list[bytes]] = {}
        self.ended: list[int] = []
        self.reading = False
        self.source: Any = None

    def subscribed(self) -> bool:
        return self.reading

    async def put(self, group: int, object_id: int, payload: bytes) -> None:
        objects = self.live.setdefault(group, [])
        assert object_id == len(objects)
        objects.append(payload)

    async def end_group(self, group: int) -> None:
        self.ended.append(group)

    async def end_track(self) -> None:
        pass

    def serve(self, source: Any, stats: object = None, open_slice: object = None) -> None:
        self.source = source

    async def write(self, data: bytes) -> None:  # the stats track: one group per snapshot
        self.live.setdefault(len(self.live), []).append(data)


class Relay:
    def __init__(self) -> None:
        self.queues: dict[tuple[str, str], asyncio.Queue[bytes]] = {}
        self.published: dict[tuple[str, str], Out] = {}

    def queue(self, namespace: str, track: str) -> asyncio.Queue[bytes]:
        return self.queues.setdefault((namespace, track), asyncio.Queue())

    async def objects(self, namespace: str, track: str) -> AsyncIterator[bytes]:
        q = self.queue(namespace, track)
        while True:
            yield await q.get()

    async def publish_sliced(self, namespace: str, track: str) -> HistoryOut:
        out = self.published[(namespace, track)] = Out()
        return cast(HistoryOut, out)

    async def publish(self, namespace: str, track: str) -> StatsOut:
        out = self.published[(namespace, track)] = Out()
        out.reading = True
        return out


async def settle() -> None:
    for _ in range(50):
        await asyncio.sleep(0)


class Wall:
    def __init__(self, ms: int) -> None:
        self.ms = ms

    def __call__(self) -> int:
        return self.ms


def looper_catalog() -> RoomCatalog:
    """What the looper publishes on talk/virus/catalog: a recorded agent track, the slides and the room service's."""
    tracks = (translation_track(ROOM, "tr", cost="free"),)
    status = {
        "translate-tr": TrackStatus(
            status="live", producing=True, fetches_served=0, backfills=0, spend_usd=0.1, updated_ms=E
        )
    }
    built = with_slides(RoomCatalog(E, tracks, shift={183813200000000: 0}, status=status), ROOM)
    return with_room_service(built, ROOM)


HANG = {
    "audio": {"renditions": {"audio": {"container": {"kind": "legacy"}, "codec": "opus", "sampleRate": 48_000}}},
    "video": {
        "renditions": {
            "video": {"container": {"kind": "legacy"}, "codec": "avc1.64001f", "codedWidth": 1280, "codedHeight": 720}
        }
    },
}


class Looped:
    """One looped room at the room service, its looper on air at room time ``at``, and the endpoint before it."""

    def __init__(self, tmp: Path, *, at: int = 30 * LOOP_MS + 12_345, keep: int = 64) -> None:
        self.relay = Relay()
        self.wall = Wall(E + at)
        self.room = LoopedRoom(
            ROOM, self.relay, tmp / "looped", wall=self.wall, keep=keep, archive_root=tmp / "archive"
        )
        self.clock = 0.0
        self.endpoint = Endpoint(self.lookup, Identities(b"secret"), clock=lambda: self.clock)

    async def lookup(self, room: str) -> Any:
        return await self.room.audience_tracks() if room == ROOM else None

    async def on_air(self) -> None:
        self.room.announced(f"talk/{ROOM}/teacher", True)
        self.room.feed_catalog(json.dumps(looper_catalog().to_json()).encode())
        self.room.feed_teacher(json.dumps(HANG).encode())
        await self.room.tick()

    async def join(self, name: str) -> Session:
        async def send(_: str) -> None:
            pass

        session = self.endpoint.open(ROOM, "192.0.2.1", send)
        await self.endpoint.handle(session, json.dumps({"type": "hello", "name": name}))
        return session

    async def write(self, session: Session, track: str, data: dict[str, Any]) -> dict[str, Any]:
        [answer] = await self.endpoint.handle(
            session, json.dumps({"type": "write", "seq": 1, "track": track, "data": data})
        )
        return answer

    async def later(self, ms: int) -> None:
        self.wall.ms += ms
        await self.room.tick()

    @property
    def chat(self) -> Out:
        return self.relay.published[(CHAT, "chat")]


def messages(payloads: list[bytes]) -> list[ChatRecord]:
    return [r for p in payloads for r in ChatObject.model_validate_json(p).root]


# --- stats ----------------------------------------------------------------------------------------------------------


def test_the_loopers_catalog_lists_the_room_services_chat_and_stats_tracks() -> None:
    catalog = MsfCatalog.model_validate(looper_catalog().to_json())  # the contract accepts it
    listed = {(t.namespace, t.name) for t in catalog.tracks}
    assert {(CHAT, "chat"), (f"talk/{ROOM}/stats", "stats")} <= listed
    assert (f"talk/{ROOM}/slides", "deck") in listed and (f"talk/{ROOM}/agents/translate-tr", "items") in listed


async def test_a_looped_room_publishes_stats_listing_every_track_the_looper_sends(tmp_path: Path) -> None:
    room = Looped(tmp_path)
    await room.on_air()
    await room.join("Ada")
    assert await room.room.tick_stats(None, room.endpoint.listeners)
    [[payload]] = room.relay.published[(f"talk/{ROOM}/stats", "stats")].live.values()
    stats = RoomStats.model_validate_json(payload)
    rows = {(t.namespace, t.name): t for t in stats.tracks}
    assert set(rows) == {
        (f"talk/{ROOM}/teacher", "audio"),
        (f"talk/{ROOM}/teacher", "video"),
        (f"talk/{ROOM}/slides", "deck"),
        (f"talk/{ROOM}/slides", "slide"),
        (f"talk/{ROOM}/catalog", "catalog"),
        (CHAT, "chat"),
        (f"talk/{ROOM}/stats", "stats"),
        (f"talk/{ROOM}/agents/translate-tr", "items"),
    }
    assert rows[(f"talk/{ROOM}/agents/translate-tr", "items")].state == "running"
    assert rows[(f"talk/{ROOM}/teacher", "video")].kind == "video"
    assert stats.listeners == 1 and not stats.relay  # no relay counts read here: unknown, not zero


async def test_an_announced_agent_the_looper_does_not_list_shows_in_the_stats(tmp_path: Path) -> None:
    room = Looped(tmp_path)
    await room.on_air()
    # translate-any serves another language here: its own track.json says what the track is and how it is doing
    track = TrackArchive(
        ROOM, "translate-fr", "items", root=tmp_path / "archive", info=TrackInfo("translation", lang="fr")
    )
    track.report("live", producing=True)
    room.room.announced(f"talk/{ROOM}/agents/translate-fr", True)
    rows = {(t.namespace, t.name): t for t in room.room.snapshot(None, 0, now_ms()).tracks}
    fr = rows[(f"talk/{ROOM}/agents/translate-fr", "items")]
    assert (fr.kind, fr.lang, fr.state) == ("translation", "fr", "running")
    room.room.announced(f"talk/{ROOM}/agents/translate-fr", False)
    rows = {(t.namespace, t.name) for t in room.room.snapshot(None, 0, now_ms()).tracks}
    assert (f"talk/{ROOM}/agents/translate-fr", "items") not in rows
    assert not (tmp_path / "looped" / ROOM / "agents").exists()  # read only: nothing written for it


# --- chat -----------------------------------------------------------------------------------------------------------


async def test_listeners_chat_in_a_looped_room_on_the_room_clock_with_a_live_rooms_limits(tmp_path: Path) -> None:
    room = Looped(tmp_path)
    ada = await room.join("Ada")
    assert (await room.write(ada, "chat", {"text": "anyone?"}))["code"] == "not-live"  # the looper is not on air
    await room.on_air()
    said = await room.write(ada, "chat", {"text": "  Hello from Lisbon  "})
    assert said["type"] == "ack" and said["m"] == room.wall.ms - E  # room time runs on across loops
    [record] = messages(room.chat.live[slice_of(said["m"])])[-1:]
    assert (record.data.by.name, record.data.text) == ("Ada", "Hello from Lisbon")

    # drawing, marks and comments stay off in a looped room
    stroke = {"kind": "stroke", "stroke": f"{ada.user_id}:1", "deck": 1, "index": 0, "points": [[0, 0]], "done": True}
    assert (await room.write(ada, "ink", stroke))["code"] == "forbidden"
    assert (await room.write(ada, "comments", {"kind": "comment", "text": "hi", "anchor": None}))["type"] == "error"

    rate, burst = LIMITS["chat"]
    grace = await room.join("Grace")
    answers = [(await room.write(grace, "chat", {"text": f"#{i}"}))["type"] for i in range(int(burst) + 1)]
    assert answers == ["ack"] * int(burst) + ["error"]
    room.clock += 1 / rate
    assert (await room.write(grace, "chat", {"text": "later"}))["type"] == "ack"


async def test_the_chat_runs_on_through_the_gap_between_two_sessions_and_never_goes_back(tmp_path: Path) -> None:
    room = Looped(tmp_path)
    await room.on_air()
    ada = await room.join("Ada")
    first = await room.write(ada, "chat", {"text": "great session"})
    room.room.announced(f"talk/{ROOM}/catalog", True)  # the session player's catalog stays up through the gap
    room.room.announced(f"talk/{ROOM}/teacher", False)  # the session ended
    await room.later(10_000)
    between = await room.write(ada, "chat", {"text": "when is the next one?"})
    assert between["type"] == "ack" and between["m"] > first["m"]
    # the next session has a new E: the chat's clock is not the session's, so its groups never go back
    room.room.feed_catalog(json.dumps(replace(looper_catalog(), epoch_ms=E + 3_600_000).to_json()).encode())
    room.room.announced(f"talk/{ROOM}/teacher", True)
    await room.later(10_000)
    after = await room.write(ada, "chat", {"text": "it started"})
    assert after["m"] == room.wall.ms - CHAT_EPOCH_MS > between["m"]
    room.room.announced(f"talk/{ROOM}/catalog", False)
    room.room.announced(f"talk/{ROOM}/teacher", False)  # no session player at all
    assert (await room.write(ada, "chat", {"text": "anyone?"}))["code"] == "not-live"


async def test_an_opened_chat_gets_the_recent_history_at_once_and_nobody_reading_writes_nothing(
    tmp_path: Path,
) -> None:
    room = Looped(tmp_path)
    await room.on_air()
    ada = await room.join("Ada")
    await room.write(ada, "chat", {"text": "Hello"})
    first = max(room.chat.live)
    await room.later(SLICE_MS * 3)
    assert room.chat.ended == [first] and max(room.chat.live) == first  # nobody reads: no slice after it

    room.chat.reading = True  # a drawer opens
    await room.later(10)
    opened = max(room.chat.live)
    assert opened > first
    assert [r.data.text for r in messages(room.chat.live[opened][:1])] == ["Hello"]  # its carry-in: the history
    room.chat.reading = False


async def test_a_restarted_room_service_carries_the_chat_on_and_keeps_only_the_newest_slices(tmp_path: Path) -> None:
    room = Looped(tmp_path, keep=3)
    await room.on_air()
    ada = await room.join("Ada")
    for i in range(6):
        room.clock += 10
        assert (await room.write(ada, "chat", {"text": f"#{i}"}))["type"] == "ack"
        await room.later(SLICE_MS)
    folder = tmp_path / "looped" / ROOM / "chat" / "chat"
    assert len(list(folder.iterdir())) <= 3

    again = Looped(tmp_path, at=room.wall.ms - E + LOOP_MS)  # the next loop, an hour of no one writing later
    await again.on_air()
    again.chat.reading = True
    await again.room.tick()
    [carry] = again.chat.live[max(again.chat.live)][:1]
    assert [r.data.text for r in messages([carry])] == [f"#{i}" for i in range(6)]
    fetched: Slice = await again.chat.source(max(again.chat.live))
    assert [o.payload for o in fetched.objects if o.status == NORMAL] == again.chat.live[max(again.chat.live)]


async def test_a_drawer_open_for_longer_than_the_kept_slices_loses_no_message(tmp_path: Path) -> None:
    room = Looped(tmp_path, keep=3)
    await room.on_air()
    ada = await room.join("Ada")
    for i in range(55):  # more than one carry-in holds: the newest 50 are what a drawer shows
        room.clock += 10
        assert (await room.write(ada, "chat", {"text": f"#{i}"}))["type"] == "ack"
    room.chat.reading = True  # a drawer stays open, nobody writes, for many more slices than are kept
    for _ in range(10):
        await room.later(SLICE_MS)
    newest = max(room.chat.live)
    assert [r.data.text for r in messages(room.chat.live[newest][:1])] == [f"#{i}" for i in range(5, 55)]
    room.chat.reading = False
    await room.later(SLICE_MS)

    again = Looped(tmp_path, at=room.wall.ms - E + LOOP_MS)  # restarted, and a drawer opened much later
    await again.on_air()
    again.chat.reading = True
    await again.room.tick()
    [carry] = again.chat.live[max(again.chat.live)][:1]
    assert [r.data.text for r in messages([carry])] == [f"#{i}" for i in range(5, 55)]


# --- the room service: a looped room is never archived ---------------------------------------------------------------


async def test_the_room_service_archives_nothing_of_a_looped_room(tmp_path: Path) -> None:
    pytest.importorskip("aiomoqt.agent")  # archive.relay needs aiomoqt (Linux only): run it in the agents' image
    from talk_tracks.archive.relay import Archiver
    from talk_tracks.archive.store import Archive, RoomFilter

    relay = Relay()
    archive = Archive(tmp_path / "archive")
    archiver = Archiver(
        cast(Any, relay), archive, RoomFilter("*"), looped=RoomFilter("virus"), looped_root=tmp_path / "looped"
    )
    for path in ("virus/teacher", "virus/slides", "virus/catalog", "virus/agents/translate-tr"):
        archiver.announced(path, True)
    await settle()
    assert archiver.rooms == {} and ROOM in archiver.looped_rooms  # no media, events or catalog of it
    assert await archiver.audience("virus") is not None
    assert not (tmp_path / "archive" / ROOM).exists()
    for task in [r.reader for r in archiver.looped_rooms.values()]:
        assert task is not None
        task.cancel()
