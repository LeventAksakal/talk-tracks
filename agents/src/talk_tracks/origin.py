# pyright: reportMissingImports=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportAttributeAccessIssue=false, reportPrivateUsage=false
"""A publisher that is the origin of its track's history (decision 0012), for tracks whose every group can be computed.

moq-relay 0.17.8 forwards a FETCH it cannot serve from its cache to the track's publisher (S2-S4c in
wiki/design/moq-track-system.md §9). aiomoqt's ``PublishedTrack`` answers it from an in-memory ``ObjectHistory`` of
what it sent. ``ComputedTrack`` swaps that history for a ``GroupSource`` that rebuilds any group on demand, so a
FETCH of any slice of a looped recording is answered, however old, without holding the room's past in memory.

Group numbers are set by the caller (the slice of the media clock), not counted by the writer. Three measured fixes:

* ``fix_end`` (from the spikes, ``spikes/moqt/common.py``): for a whole-group FETCH aiomoqt reports End Object
  2^62 + 1, which a QUIC varint cannot carry and the relay rejects as "not found"; the End Location must be the
  group's last object plus one.
* No End of Group object in a FETCH reply: moq-relay 0.17.8 fails the whole FETCH with code 18 "short buffer"
  (probed 2026-10-28). A finished group's fetched copy ends after its last item.
* ``from_next_group``: the relay subscribes upstream with the Largest Object filter. Started mid-group, a new
  subscription gets the rest of that group, and the relay relabels it as the *next* group with object ids from 1,
  then drops the real next group as a duplicate (probed 2026-10-28: slice k's tail arrived as group k + 1). Starting
  every new subscription at the next group's object 0 avoids it; the group in progress stays reachable by a Joining
  FETCH, which the history answers.

Runs in the agents' Docker image only (aiomoqt has no Windows wheels).
"""

from __future__ import annotations

import asyncio
from typing import Any, Protocol

from aiomoqt.messages.data import FetchObject
from aiomoqt.types import FilterType

from .moq import WRITE_TIMEOUT_S, TrackWriter


class GroupSource(Protocol):
    def objects(self, group: int) -> list[bytes]:
        """The objects of ``group`` published so far, in object order (none for a group not yet begun)."""
        ...


def fix_end(track: Any) -> None:
    """Report the last object of a whole-group FETCH from the history, as the d20 branch already does."""
    orig = track._fetch_range

    def fixed(session: Any, msg: Any) -> tuple[Any, ...]:
        start, last, end = orig(session, msg)
        if last[1] >= 1 << 62:
            held = track._history.last_object(last[0])
            last = (last[0], 0 if held is None else held)
            end = (last[0], last[1] + 1)
        return start, last, end

    track._fetch_range = fixed


def from_next_group(track: Any) -> None:
    """Answer a Largest Object SUBSCRIBE as Next Group Start, so a new subscription never starts mid-group."""
    orig = track._on_subscribe

    async def on_subscribe(session: Any, msg: Any) -> None:
        if getattr(msg, "filter_type", None) == FilterType.LATEST_OBJECT:
            msg.filter_type = FilterType.NEXT_GROUP_START
        await orig(session, msg)

    track._on_subscribe = on_subscribe


class ComputedHistory:
    """Stands in for aiomoqt's ``ObjectHistory``: nothing is kept, every FETCH is built from the source."""

    evicted_through = None

    def __init__(self, source: GroupSource) -> None:
        self._source = source

    def __len__(self) -> int:
        return 0

    def add(self, *_args: Any, **_kwargs: Any) -> None:
        """Live objects are not kept: the source can build them again."""

    def last_object(self, group: int) -> int | None:
        objects = self._source.objects(group)
        return len(objects) - 1 if objects else None

    def fetch(self, start: tuple[int, int], end: tuple[int, int], session: Any = None, **options: Any) -> list[Any]:
        """FetchObjects from ``start`` to ``end``, both (group, object) and inclusive; groups descend on request."""
        del session
        groups = range(start[0], end[0] + 1)
        out: list[Any] = []
        for group in reversed(groups) if options.get("descending") else groups:
            for i, payload in enumerate(self._source.objects(group)):
                if start <= (group, i) <= end:
                    out.append(FetchObject(group_id=group, object_id=i, payload=payload))
        return out


class ComputedTrack:
    """A track written group by group under the caller's group numbers, its past served from ``source``."""

    def __init__(self, sink: TrackWriter, source: GroupSource) -> None:
        self._writer = sink._writer
        self._track = self._writer._track
        self._track._history = ComputedHistory(source)
        fix_end(self._track)
        from_next_group(self._track)

    async def open(self, group: int, payload: bytes) -> None:
        """Start ``group`` with ``payload`` as object 0; the group before it ends (End of Group on the stream)."""
        self._writer._group = group - 1
        await asyncio.wait_for(self._writer.snapshot(payload), WRITE_TIMEOUT_S)
        self._track._note_largest(group, 0)

    async def append(self, group: int, index: int, payload: bytes) -> None:
        """Object ``index`` of the open ``group``."""
        await asyncio.wait_for(self._writer.write(payload), WRITE_TIMEOUT_S)
        # Largest Location as published, whether or not anyone subscribes: a FETCH's range is checked against it.
        self._track._note_largest(group, index)
