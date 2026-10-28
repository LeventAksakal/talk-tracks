"""Shared helpers for the MoQT spikes: a clock, a log line, and reading a FETCH or a subscription to the end."""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any

from aiomoqt.agent import AgentError, FetchSpec, PublishSpec, StartAt, SubscribeSpec, TrackRef

RELAY = os.environ.get("SPIKE_RELAY", "moqt://relay:4443")
T0 = time.monotonic()


def log(*parts: Any) -> None:
    print(f"{time.monotonic() - T0:7.2f}s", *parts, flush=True)


def ref(ns: str, name: str) -> TrackRef:
    return TrackRef(namespace=ns, name=name)


def payload(group: int) -> bytes:
    return json.dumps({"g": group, "wall_ms": time.time_ns() // 1_000_000}).encode()


def groups_of(objs: list[Any]) -> list[int]:
    return [o.group for o in objs]


def span(groups: list[int]) -> str:
    if not groups:
        return "none"
    return f"{len(groups)} objects, groups {min(groups)}..{max(groups)}"


async def fetch(relay: Any, ns: str, name: str, start: int, end: int, *, timeout: float = 5.0) -> dict[str, Any]:
    """A standalone FETCH of groups start..end. Returns what came back and how long it took."""
    t = time.monotonic()
    try:
        rdr = await relay.agent.fetch(
            FetchSpec(track=ref(ns, name), start_at=StartAt.range(start, end), timeout_s=timeout)
        )
    except (AgentError, Exception) as exc:  # refused, or no reply
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "ms": round((time.monotonic() - t) * 1000)}
    objs: list[Any] = []
    while not rdr.done and time.monotonic() - t < timeout:
        objs += rdr.drain()
        await asyncio.sleep(0.02)
    objs += rdr.drain()
    return {
        "ok": True,
        "ended": rdr.ended,
        "groups": groups_of(objs),
        "ms": round((time.monotonic() - t) * 1000),
    }


async def subscribe(relay: Any, ns: str, name: str, start_at: StartAt | None = None, *, forward: bool = True) -> Any:
    return await relay.agent.reader(
        SubscribeSpec(track=ref(ns, name), start_at=start_at or StartAt(mode="latest"), forward=forward, buffer=4096)
    )


def unsubscribe(relay: Any, ns: str, name: str, rdr: Any) -> None:
    """Cancel on the wire (d18: reset the request stream), then drop the reader. close_reader alone sends nothing."""
    if rdr.request_id is not None:
        relay.session.unsubscribe(rdr.request_id)
    relay.agent.close_reader(str(ref(ns, name)))


def writer_spec(ns: str, name: str) -> PublishSpec:
    return PublishSpec(track=ref(ns, name), buffer=64, on_full="drop_oldest")
