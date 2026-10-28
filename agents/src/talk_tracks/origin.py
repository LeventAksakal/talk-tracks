# pyright: reportMissingImports=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportAttributeAccessIssue=false, reportPrivateUsage=false
"""A publisher that is the origin of its track's history (decision 0012), for tracks whose every group can be computed.

moq-relay 0.17.8 forwards a FETCH it cannot serve from its cache to the track's publisher (S2-S4c in
wiki/design/moq-track-system.md §9). aiomoqt's ``PublishedTrack`` answers it from an in-memory ``ObjectHistory`` of
what it sent. ``ComputedTrack`` swaps that history for a ``GroupSource`` that rebuilds any group on demand, so a
FETCH of any slice of a looped recording is answered, however old, without holding the room's past in memory.

Two measured fixes are applied as in the spikes (``spikes/moqt/common.py``):

* ``fix_end``: for a whole-group FETCH aiomoqt reports End Object 2^62 + 1, which a QUIC varint cannot carry and the
  relay rejects as "not found"; the End Location must be the group's last object plus one.
* group numbers are set by the caller (the slice of the media clock), not counted by the writer.

Runs in the agents' Docker image only (aiomoqt has no Windows wheels).
"""

from __future__ import annotations

import asyncio
from typing import Any, Protocol

from aiomoqt.messages.data import FetchObject
from aiomoqt.types import ObjectStatus

from .moq import WRITE_TIMEOUT_S, TrackWriter


class GroupSource(Protocol):
    def objects(self, group: int) -> list[bytes]:
        """The objects of ``group`` published so far, in object order (none for a group not yet begun)."""
        ...

    def complete(self, group: int) -> bool:
        """Whether ``group`` is over, so a FETCH of it ends with End of Group."""
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


class ComputedHistory:
    """Stands in for aiomoqt's ``ObjectHistory``: nothing is kept, every FETCH is built from the source."""

    evicted_through = None

    def __init__(self, source: GroupSource) -> None:
        self._source = source

    def __len__(self) -> int:
        return 0

    def add(self, *_args: Any, **_kwargs: Any) -> None:
        """Live objects are not kept: the source can build them again."""

    def _group(self, group: int) -> list[tuple[int, bytes, Any]]:
        objects = [(i, payload, ObjectStatus.NORMAL) for i, payload in enumerate(self._source.objects(group))]
        if objects and self._source.complete(group):
            objects.append((len(objects), b"", ObjectStatus.END_OF_GROUP))
        return objects

    def last_object(self, group: int) -> int | None:
        objects = self._group(group)
        return objects[-1][0] if objects else None

    def fetch(self, start: tuple[int, int], end: tuple[int, int], session: Any = None, **options: Any) -> list[Any]:
        """FetchObjects from ``start`` to ``end``, both (group, object) and inclusive; groups descend on request."""
        del session
        groups = range(start[0], end[0] + 1)
        out: list[Any] = []
        for group in reversed(groups) if options.get("descending") else groups:
            for i, payload, status in self._group(group):
                if start <= (group, i) <= end:
                    out.append(FetchObject(group_id=group, object_id=i, status=status, payload=payload))
        return out


class ComputedTrack:
    """A track written group by group under the caller's group numbers, its past served from ``source``."""

    def __init__(self, sink: TrackWriter, source: GroupSource) -> None:
        self._writer = sink._writer
        self._track = self._writer._track
        self._track._history = ComputedHistory(source)
        fix_end(self._track)

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
