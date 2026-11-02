"""Stats for nerds (ticket 0022): what the room service says on talk/<room>/stats, and when it says it."""

from __future__ import annotations

import json
from typing import Any

from talk_tracks.archive.stats import RelayCounts, StatsTrack, snapshot
from talk_tracks.contracts import RoomStats
from talk_tracks.room_catalog import room_service_tracks, speaker_tracks, translation_track

ROOM = "talk1"


def frame(**subscriptions: int) -> bytes:
    """A publisher.json frame as moq-relay 0.17.8 sends it (keys and fields as read from a local relay)."""
    return json.dumps(
        {
            path.replace("__", "/"): {
                "announces_started": 1,
                "broadcasts_started": 1,
                "broadcasts": 1,
                "broadcasts_ended": 0,
                "subscriptions_started": n + 2,
                "subscriptions": n,
                "subscriptions_ended": 2,
                "bytes": 7,
            }
            for path, n in subscriptions.items()
        }
    ).encode()


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


def test_subscriber_counts_come_from_the_relays_stats_and_go_unknown_when_it_stops() -> None:
    clock = Clock()
    counts = RelayCounts(clock)
    assert counts.subscribers("talk/talk1/chat") is None  # no frame yet: unknown, not zero
    counts.feed(frame(talk__talk1__chat=3, talk__talk1__agents__captions=1))
    assert counts.subscribers("talk/talk1/chat") == 3
    assert counts.subscribers("talk/talk1/agents/captions") == 1
    assert counts.subscribers("talk/talk1/agents/translate-tr") == 0  # not in the frame: nobody subscribed
    counts.feed(json.dumps({"/talk/talk1/chat": {"subscriptions_started": 5, "subscriptions_ended": 1}}).encode())
    assert counts.subscribers("talk/talk1/chat") == 4  # no gauge: started minus ended
    counts.feed(b"not json")
    assert counts.subscribers("talk/talk1/chat") == 4
    clock.t += 15
    assert counts.subscribers("talk/talk1/chat") is None


def build(counts: RelayCounts | None, *, on_air: bool, producing: bool) -> RoomStats:
    captions = translation_track(ROOM, "tr")
    return snapshot(
        ROOM,
        media={"audio": "audio", "video": "video"} if on_air else {},
        speaker=speaker_tracks(ROOM) if on_air else (),
        catalog=True,
        owned=room_service_tracks(ROOM)[:1] + room_service_tracks(ROOM)[-1:],  # room and chat
        agents=[captions],
        status={"translate-tr": {"producing": producing}},
        counts=counts,
        listeners=2,
        at_ms=1_700_000_000_000,
    )


def test_the_snapshot_lists_every_track_of_the_room_running_or_on_demand_with_its_subscribers() -> None:
    counts = RelayCounts(Clock())
    counts.feed(frame(talk__talk1__chat=3, talk__talk1__teacher=2))
    stats = build(counts, on_air=True, producing=False)
    rows = {(t.namespace, t.name): t for t in stats.tracks}
    assert stats.relay and stats.listeners == 2
    assert rows[("talk/talk1/teacher", "audio")].subscribers == 2
    assert rows[("talk/talk1/chat", "chat")].subscribers == 3
    assert rows[("talk/talk1/slides", "slide")].state == "running"
    assert ("talk/talk1/catalog", "catalog") in rows and ("talk/talk1/stats", "stats") in rows
    translation = rows[("talk/talk1/agents/translate-tr", "items")]
    assert translation.state == "on_demand" and translation.lang == "tr" and translation.subscribers == 0
    assert build(counts, on_air=False, producing=True).tracks[-1].state == "running"  # its agent is producing
    off_air = {(t.namespace, t.name) for t in build(counts, on_air=False, producing=False).tracks}
    assert ("talk/talk1/teacher", "audio") not in off_air and ("talk/talk1/slides", "slide") not in off_air

    unknown = build(None, on_air=True, producing=False)
    assert not unknown.relay and all(t.subscribers is None for t in unknown.tracks)
    RoomStats.model_validate(unknown.model_dump(mode="json"))  # what goes out matches the contract


class Out:
    def __init__(self) -> None:
        self.reading = False
        self.sent: list[dict[str, Any]] = []

    def subscribed(self) -> bool:
        return self.reading

    async def write(self, data: bytes) -> None:
        self.sent.append(json.loads(data))


async def test_a_snapshot_goes_out_only_while_someone_reads_at_once_then_every_5_s() -> None:
    out, clock = Out(), Clock()
    opened: list[str] = []
    built: list[int] = []

    async def open_track() -> Out:
        opened.append("stats")
        return out

    def snap() -> RoomStats:
        built.append(1)
        return build(None, on_air=False, producing=False)

    track = StatsTrack(open_track, snap, clock=clock)
    assert not await track.tick() and opened == ["stats"] and built == []  # published, nobody reads: nothing built
    out.reading = True
    assert await track.tick()  # the panel opened: a snapshot at once
    clock.t += 1
    assert not await track.tick()
    clock.t += 4
    assert await track.tick()
    out.reading = False
    assert not await track.tick()
    out.reading = True
    assert await track.tick()  # opened again: at once, not 5 s later
    assert len(out.sent) == 3 and opened == ["stats"]
    assert out.sent[0]["listeners"] == 2 and out.sent[0]["relay"] is False
