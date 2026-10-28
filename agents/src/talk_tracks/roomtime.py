"""Room time for one room (design §4.5): what every agent stamps its records with. Transport-free.

room ms = wall time of the speaker's media - ``E`` + the broadcast's ``tt.shift``. The wall time comes from the
teacher's hang catalog root ``clock`` (``wall`` of PTS zero, in ``timescale`` units since 2020-01-01); ``E`` and the
shifts come from the room catalog, which the room service publishes. Nothing is stamped from a teacher broadcast
until the room catalog lists its ``clock.wall`` in ``tt.shift``: ``mapping`` is None until then.

``edge`` is the newest teacher media seen, in room time: an idle agent's slice edge (``⌊edge/4000⌋``), never its own
wall clock.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .contracts import RoomCatalog, room_ms, wall_unix_ms

log = logging.getLogger("talk_tracks")

DEFAULT_TIMESCALE = 1_000_000  # hang's default: µs


@dataclass(frozen=True)
class HangClock:
    wall: int
    timescale: int = DEFAULT_TIMESCALE

    @property
    def key(self) -> str:
        """How the room catalog's ``tt.shift`` names this broadcast."""
        return str(self.wall)


class _Clock(BaseModel):
    wall: int = Field(ge=0)
    timescale: int = Field(gt=0, default=DEFAULT_TIMESCALE)


class _HangRoot(BaseModel):
    model_config = ConfigDict(extra="allow")

    clock: _Clock | None = None


def hang_clock(catalog_json: bytes) -> HangClock | None:
    """The root ``clock`` of a hang catalog, or None when the broadcast has none (a device clock before 2020)."""
    try:
        clock = _HangRoot.model_validate_json(catalog_json).clock
    except ValidationError:
        return None
    return None if clock is None else HangClock(clock.wall, clock.timescale)


Mapping = Callable[[float], int]  # media PTS in ms -> room ms


class RoomTime:
    def __init__(self) -> None:
        self.epoch: int | None = None
        self.shift: dict[str, int] = {}
        self.teacher: HangClock | None = None  # the current teacher broadcast's clock
        self.edge: int | None = None
        self._changed = asyncio.Condition()

    async def on_room_catalog(self, payload: bytes) -> None:
        try:
            catalog = RoomCatalog.model_validate_json(payload)
        except ValidationError:
            log.warning("skipping a room catalog that does not match the contract")
            return
        await self._update(lambda: self._set_room(catalog.tt.E, dict(catalog.tt.shift)))

    async def on_teacher_clock(self, clock: HangClock | None) -> None:
        def set_teacher() -> None:
            self.teacher = clock

        await self._update(set_teacher)

    def _set_room(self, epoch: int, shift: dict[str, int]) -> None:
        if self.epoch is not None and epoch != self.epoch:
            log.error("the room epoch changed from %d to %d: it is set once per room", self.epoch, epoch)
        self.epoch, self.shift = epoch, shift

    async def _update(self, change: Callable[[], None]) -> None:
        async with self._changed:
            change()
            self._changed.notify_all()

    def mapping(self, clock: HangClock | None = None) -> Mapping | None:
        """Media PTS (ms) of ``clock``'s broadcast (default: the current one) to room ms, once the room catalog has
        ``E`` and that broadcast's shift."""
        clock = clock or self.teacher
        if clock is None or self.epoch is None or clock.key not in self.shift:
            return None
        epoch, shift = self.epoch, self.shift[clock.key]
        return lambda pts_ms: room_ms(wall_unix_ms(clock.wall, clock.timescale, pts_ms), epoch, shift)

    async def wait_mapping(self, clock: HangClock) -> Mapping:
        async with self._changed:
            await self._changed.wait_for(lambda: self.mapping(clock) is not None)
        found = self.mapping(clock)
        assert found is not None
        return found

    def of_wall(self, wall_ms: float) -> int | None:
        """Room ms of a Unix wall time stamped by the speaker's browser (slide frames), under the current
        broadcast's shift."""
        clock = self.teacher
        if clock is None or self.epoch is None or clock.key not in self.shift:
            return None
        return room_ms(wall_ms, self.epoch, self.shift[clock.key])

    def saw(self, at_ms: int) -> None:
        """Teacher media at room ``at_ms`` exists."""
        if self.edge is None or at_ms > self.edge:
            self.edge = at_ms
