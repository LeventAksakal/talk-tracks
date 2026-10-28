"""Spike 4: the publisher as the origin of history, and what a FETCH costs it.

A. A FETCH with nobody subscribed: does the relay SUBSCRIBE upstream (waking a lazy publisher), and for how long?
B. A group the relay never saw (prefilled into the publisher's history only): FETCH it through the relay.
C. A slow origin: the publisher answers the FETCH 3 s late (an agent back-filling): does the relay wait?
D. Late join to a quiet track (one object, then 8 s of silence), three ways: Largest Object filter,
   Next Group Start filter (draft-18: the relay ignores it and starts at the latest group), and a joining FETCH
   (relative 0) next to a Largest Object subscription.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from aiomoqt.agent import StartAt
from aiomoqt.agent.reader import Reader
from aiomoqt.agent.spec import FetchSpec
from aiomoqt.messages.fetch import FetchType
from common import RELAY, fetch, log, ref, subscribe, unsubscribe, writer_spec

from talk_tracks.moq import connect

results: dict[str, Any] = {}


def watch(track: Any) -> list[tuple[str, float]]:
    """(event, monotonic time) for each SUBSCRIBE, FETCH and cancel the relay sends this publisher."""
    events: list[tuple[str, float]] = []
    for name in ("_on_subscribe", "_on_fetch"):
        orig = getattr(track, name)

        async def wrapped(session: Any, msg: Any, orig: Any = orig, name: str = name) -> None:
            events.append((name, time.monotonic()))
            await orig(session, msg)

        setattr(track, name, wrapped)
    orig_cancel = track._on_request_cancelled

    def cancelled(request_id: int, sub: Any = None) -> None:
        events.append(("cancelled", time.monotonic()))
        orig_cancel(request_id, sub)

    track._on_request_cancelled = cancelled
    return events


async def part_abc() -> None:
    ns, name = "spike/origin", "t"
    async with connect(RELAY, insecure=True) as pub, connect(RELAY, insecure=True) as sub:
        w = pub.agent.writer(writer_spec(ns, name))
        await w.start()
        track = w._track
        track.prefill(40)  # groups 0..39 exist only in the publisher's history; the relay never saw them
        w._group = 39
        events = watch(track)
        await asyncio.sleep(1)

        t = time.monotonic()
        r = await fetch(sub, ns, name, 12, 12)
        producing_at = track.producing
        # how long does the upstream subscription the FETCH created stay?
        while track.producing is False and time.monotonic() - t < 2:
            await asyncio.sleep(0.01)
        while track.producing and time.monotonic() - t < 70:
            await asyncio.sleep(0.05)
        results["A_fetch_without_subscriber"] = {
            **r,
            "events": [(e, round((at - t) * 1000)) for e, at in events],
            "producing_right_after": producing_at,
            "upstream_subscription_lasted_ms": round((time.monotonic() - t) * 1000),
        }
        log("A+B: FETCH group 12 (prefilled, never relayed), nobody subscribed:", results["A_fetch_without_subscriber"])

        # B again, with a live subscriber holding the upstream subscription
        viewer = await subscribe(sub, ns, name)
        await asyncio.sleep(0.5)
        events.clear()
        t = time.monotonic()
        r = await fetch(sub, ns, name, 20, 20)
        results["B_fetch_unseen_group_with_subscriber"] = {**r, "events": [(e, round((at - t) * 1000)) for e, at in events]}
        log("B: FETCH group 20 (never relayed) with a subscriber:", results["B_fetch_unseen_group_with_subscriber"])

        # C: a slow origin
        orig = track._on_fetch

        async def slow(session: Any, msg: Any) -> None:
            await asyncio.sleep(3)
            await orig(session, msg)

        track._on_fetch = slow
        t = time.monotonic()
        r = await fetch(sub, ns, name, 25, 25, timeout=15)
        results["C_slow_origin_3s"] = r
        log("C: FETCH answered 3 s late by the origin:", r)
        unsubscribe(sub, ns, name, viewer)


async def part_d() -> None:
    ns, name = "spike/quiet2", "t"
    async with connect(RELAY, insecure=True) as pub, connect(RELAY, insecure=True) as warm:
        w = pub.agent.writer(writer_spec(ns, name))
        await w.start()
        keep = await subscribe(warm, ns, name)
        await asyncio.sleep(0.5)
        await w.snapshot(json.dumps({"state": "only object"}).encode())
        await asyncio.sleep(8)
        for label, start in (("largest_object", StartAt(mode="latest")), ("next_group_start", StartAt.next_group())):
            async with connect(RELAY, insecure=True) as late:
                t = time.monotonic()
                rdr = await subscribe(late, ns, name, start)
                got = await rdr.read(1, timeout=3)
                results[f"D_{label}"] = {"groups": [o.group for o in got], "ms": round((time.monotonic() - t) * 1000)}
                log(f"D: late join with {label}:", results[f"D_{label}"])
        async with connect(RELAY, insecure=True) as late:
            t = time.monotonic()
            rdr = await subscribe(late, ns, name)
            msg = late.session.joining_fetch(rdr.request_id, joining_start=0, fetch_type=FetchType.RELATIVE_JOINING)
            jr = Reader(FetchSpec(track=ref(ns, name), start_at=StartAt.range(0, 0)), "join")
            late.session.register_fetch_object_handler(msg.request_id, jr.on_fetched)
            clean = await late.session.await_fetch_done(msg.request_id, 5)
            results["D_joining_fetch_relative_0"] = {
                "clean": clean,
                "groups": [o.group for o in jr.drain()],
                "ms": round((time.monotonic() - t) * 1000),
            }
            log("D: SUBSCRIBE + joining FETCH relative 0:", results["D_joining_fetch_relative_0"])
        unsubscribe(warm, ns, name, keep)


async def main() -> None:
    for part in (part_d, part_abc):
        try:
            await part()
        except Exception as exc:
            results[part.__name__ + "_error"] = f"{type(exc).__name__}: {exc}"
            log(part.__name__, "failed:", exc)
    print("RESULTS " + json.dumps(results, default=str))


asyncio.run(main())
