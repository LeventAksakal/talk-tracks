"""Publishing snapshots: the envelope around a state, the instance name, and the heartbeat."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Protocol

from .contracts import ENVELOPE, AgentInfo, Envelope, State, Usage


class ObjectSink(Protocol):
    async def write(self, data: bytes) -> None:
        """Publish one object in a group of its own."""
        ...


class SnapshotPublisher:
    def __init__(
        self,
        info: AgentInfo,
        sink: ObjectSink,
        usage: Callable[[], Usage],
        *,
        instance: str | None = None,
        clock_ms: Callable[[], int] = lambda: time.time_ns() // 1_000_000,
    ) -> None:
        self.info = info
        self._label = info.label
        self.instance = instance or str(clock_ms())
        self._sink = sink
        self._usage = usage
        self._clock = clock_ms
        self._seq = 0
        self._last: State | None = None

    @property
    def seq(self) -> int:
        return self._seq

    async def publish(self, state: State) -> None:
        """A state change: the sequence number goes up by one."""
        self._seq += 1
        self._last = state
        await self._write(state)

    async def notice(self, text: str) -> None:
        """Say something about the track itself (a spend cap reached) in its label, and republish the state."""
        self.info = self.info.model_copy(update={"label": f"{self._label} ({text})"})
        if self._last is not None:
            await self.publish(self._last)

    async def heartbeat(self) -> None:
        """Repeat the current state with the same sequence number so a late subscriber gets it within seconds."""
        if self._last is not None:
            await self._write(self._last)

    async def _write(self, state: State) -> None:
        envelope = Envelope(
            agent=self.info,
            instance=self.instance,
            seq=self._seq,
            at_ms=self._clock(),
            usage=self._usage(),
            state=state,
        )
        await self._sink.write(ENVELOPE.dump_json(envelope))
