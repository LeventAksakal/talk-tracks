"""Stats for nerds (ticket 0022): the room service publishes ``talk/<room>/stats`` track ``stats``.

Each group is one ``contracts.RoomStats`` object: every track of the room's namespace, its kind, whether it is
``running`` (published now: an agent producing, the speaker sending, the room service) or ``on_demand`` (listed, its
agent works only once someone subscribes), and the sessions subscribed to its broadcast at the relay.

Subscriber counts come from moq-relay 0.17.8's own stats feed (``--stats-enabled``): the broadcast ``.stats/node``,
track ``publisher.json``, a JSON map {broadcast path: traffic} with a ``subscriptions`` gauge per broadcast (what the
relay sends to subscribers; ``subscriptions_started - subscriptions_ended`` where the gauge is missing). Counts are per
broadcast, not per track, and agents and the room service count like browsers. No frame for 15 s: counts unknown.

A new snapshot goes out every 5 s, and only while someone reads the track (``TrackWriter.subscribed``: a panel is a
subscription); the first one at once, so an opened panel fills without waiting.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Awaitable, Callable, Iterable, Mapping
from typing import TYPE_CHECKING, Any, Protocol, cast

from ..contracts import STATS_TRACK, RoomStats, TrackStats, stats_path, teacher_path
from ..room_catalog import CATALOG_TRACK, CatalogTrack, catalog_path

if TYPE_CHECKING:
    from ..moq import Relay

log = logging.getLogger("talk_tracks.archive.stats")

INTERVAL_S = 5.0
STALE_S = 15.0
RELAY_STATS = ".stats/node"  # moq-relay's default --stats-prefix, no --stats-node
RELAY_STATS_TRACK = "publisher.json"


class RelayCounts:
    """Sessions subscribed per broadcast, from moq-relay's stats feed."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self.counts: dict[str, int] = {}
        self._at: float | None = None

    def feed(self, payload: bytes) -> None:
        """One frame of ``publisher.json``: the whole map (deltas off), so it replaces the last."""
        try:
            value: object = json.loads(payload)
        except ValueError:
            log.warning("relay stats: a frame that is not JSON")
            return
        if not isinstance(value, dict):
            return
        counts: dict[str, int] = {}
        for path, traffic in cast(dict[str, object], value).items():
            if isinstance(traffic, dict):
                counts[path.strip("/")] = subscribed(cast(dict[str, Any], traffic))
        self.counts, self._at = counts, self._clock()

    @property
    def fresh(self) -> bool:
        return self._at is not None and self._clock() - self._at < STALE_S

    def subscribers(self, namespace: str) -> int | None:
        return self.counts.get(namespace, 0) if self.fresh else None

    async def follow(self, relay: Relay, broadcast: str = RELAY_STATS, track: str = RELAY_STATS_TRACK) -> None:
        """Read the feed for as long as the service runs (``Relay.objects`` resubscribes when it goes away)."""
        log.info("reading the relay's stats on %s/%s", broadcast, track)
        async for payload in relay.objects(broadcast, track):
            self.feed(payload)


def subscribed(traffic: dict[str, Any]) -> int:
    gauge = traffic.get("subscriptions")
    if isinstance(gauge, int) and not isinstance(gauge, bool):
        return max(0, gauge)
    started, ended = traffic.get("subscriptions_started"), traffic.get("subscriptions_ended")
    return max(0, int(started or 0) - int(ended or 0))


Listed = tuple[str, str, str, str, bool]  # namespace, name, kind, lang, running


def listed(tracks: Iterable[CatalogTrack], running: Callable[[CatalogTrack], bool]) -> list[Listed]:
    return [(t.namespace, t.name, t.kind, t.lang, running(t)) for t in tracks]


def room_stats(tracks: Iterable[Listed], counts: RelayCounts | None, listeners: int, at_ms: int) -> RoomStats:
    """The snapshot: each track once (the first listing wins), in the order given."""
    seen: set[tuple[str, str]] = set()
    out: list[TrackStats] = []
    for namespace, name, kind, lang, running in tracks:
        if (namespace, name) in seen:
            continue
        seen.add((namespace, name))
        out.append(
            TrackStats(
                namespace=namespace,
                name=name,
                kind=kind,
                state="running" if running else "on_demand",
                subscribers=counts.subscribers(namespace) if counts is not None else None,
                lang=lang or None,
            )
        )
    known = counts is not None and counts.fresh
    return RoomStats(at=at_ms, relay=known, listeners=listeners, tracks=out)


def encode(stats: RoomStats) -> bytes:
    return json.dumps(stats.model_dump(mode="json", exclude_none=True), separators=(",", ":")).encode()


def snapshot(
    room: str,
    *,
    media: Mapping[str, str],
    speaker: Iterable[CatalogTrack],
    catalog: bool,
    owned: Iterable[CatalogTrack],
    agents: Iterable[CatalogTrack],
    status: Mapping[str, Mapping[str, Any]],
    counts: RelayCounts | None,
    listeners: int,
    at_ms: int,
) -> RoomStats:
    """Every track of the room now, in the order a viewer reads them: the speaker's media (``media``: track ->
    kind, while on air) and slides tracks (while sent), the room service's (the catalog once published, ``owned``,
    this stats track), then the agents' (running while ``tt.status`` says producing, else on demand)."""
    tracks: list[Listed] = [(teacher_path(room), name, kind, "", True) for name, kind in media.items()]
    tracks += listed(speaker, lambda _t: True)
    if catalog:
        tracks.append((catalog_path(room), CATALOG_TRACK, "catalog", "", True))
    tracks += listed(owned, lambda _t: True)
    tracks.append((stats_path(room), STATS_TRACK, "stats", "", True))

    def producing(track: CatalogTrack) -> bool:
        return bool(status.get(track.namespace.rsplit("/", 1)[-1], {}).get("producing"))

    tracks += listed(agents, producing)
    return room_stats(tracks, counts, listeners, at_ms)


class StatsOut(Protocol):
    """What the stats track is published through (``moq.TrackWriter``): each write a group of its own."""

    def subscribed(self) -> bool: ...

    async def write(self, data: bytes) -> None: ...


class StatsTrack:
    """One room's stats track. ``tick`` about once a second: while someone reads the track, a snapshot goes out at
    once and then every 5 s; while nobody does, nothing is built."""

    def __init__(
        self,
        open_track: Callable[[], Awaitable[StatsOut]],
        build: Callable[[], RoomStats],
        *,
        clock: Callable[[], float] = time.monotonic,
        interval_s: float = INTERVAL_S,
    ) -> None:
        self._open, self._build, self._clock, self._interval = open_track, build, clock, interval_s
        self.out: StatsOut | None = None
        self._sent: float | None = None  # when the last snapshot went out to the current readers

    async def tick(self) -> bool:
        """Whether a snapshot went out."""
        if self.out is None:
            self.out = await self._open()
        if not self.out.subscribed():
            self._sent = None
            return False
        now = self._clock()
        if self._sent is not None and now - self._sent < self._interval:
            return False
        self._sent = now
        await self.out.write(encode(self._build()))
        return True
