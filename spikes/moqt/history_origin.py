"""Spike 2: can the original publisher be the origin of a track's history behind moq-relay 0.17.8?

A. One-group FETCH of a group older than the relay's 30 s cache, while a viewer holds the live SUBSCRIBE: does
   the relay forward it, and does the publisher's own history answer it? Also a cached group, for comparison.
B. The same FETCH with nobody subscribed (the publisher still connected).
C. Late join to a quiet track: one object, then 10 s of silence. Does a new SUBSCRIBE get that latest group?
D. Takeover of a stable name: a second publisher announces the same namespace with continuing group ids.
   Which publisher do an existing and a new subscriber read, and what happens when the first one leaves?
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from typing import Any

from common import RELAY, fetch, log, subscribe, unsubscribe, writer_spec

from talk_tracks.moq import connect

results: dict[str, Any] = {}


def counting(track: Any) -> list[tuple[int, int]]:
    """FETCHes the relay forwards to this track's publisher: (start_group, end_group)."""
    seen: list[tuple[int, int]] = []
    orig = track._on_fetch

    async def on_fetch(session: Any, msg: Any) -> None:
        seen.append((msg.start_group, msg.end_group))
        await orig(session, msg)

    track._on_fetch = on_fetch
    return seen


async def collect(rdr: Any, into: list[Any]) -> None:
    while not rdr.done:
        objs = await rdr.read(1, timeout=0.05)
        objs += rdr.drain()
        into += objs
        if not objs:
            await asyncio.sleep(0.02)  # a closed reader returns at once: yield, or the loop starves


async def part_ab() -> None:
    ns, name = "spike/hist", "t"
    async with connect(RELAY, insecure=True) as pub, connect(RELAY, insecure=True) as sub:
        w = pub.agent.writer(writer_spec(ns, name))
        await w.start()
        upstream = counting(w._track)
        viewer = await subscribe(sub, ns, name)
        seen: list[Any] = []
        reading = asyncio.create_task(collect(viewer, seen))
        t0 = time.monotonic()
        while time.monotonic() - t0 < 45:  # 2 groups/s for 45 s
            await w.snapshot(json.dumps({"g": w.group + 1}).encode())
            await asyncio.sleep(0.5)
        log("A: published groups 0..", w.group, "viewer got", len(seen))

        before = len(upstream)
        old = await fetch(sub, ns, name, 4, 4)  # about 43 s old: past the 30 s idle window
        results["A_old_group_fetch"] = {**old, "forwarded_to_publisher": upstream[before:]}
        log("A: FETCH group 4 (old):", results["A_old_group_fetch"])

        before = len(upstream)
        recent = await fetch(sub, ns, name, w.group - 2, w.group - 2)
        results["A_recent_group_fetch"] = {**recent, "forwarded_to_publisher": upstream[before:]}
        log("A: FETCH a recent group:", results["A_recent_group_fetch"])

        # the same old group again: now cached by the relay?
        before = len(upstream)
        again = await fetch(sub, ns, name, 4, 4)
        results["A_old_group_again"] = {**again, "forwarded_to_publisher": upstream[before:]}
        log("A: FETCH group 4 again:", results["A_old_group_again"])

        unsubscribe(sub, ns, name, viewer)
        reading.cancel()
        await asyncio.sleep(1)
        before = len(upstream)
        none = await fetch(sub, ns, name, 6, 6, timeout=6)
        results["B_fetch_no_subscriber"] = {**none, "forwarded_to_publisher": upstream[before:]}
        log("B: FETCH group 6 with nobody subscribed:", results["B_fetch_no_subscriber"])


async def part_c() -> None:
    ns, name = "spike/quiet", "t"
    async with connect(RELAY, insecure=True) as pub, connect(RELAY, insecure=True) as warm:
        w = pub.agent.writer(writer_spec(ns, name))
        await w.start()
        keep = await subscribe(warm, ns, name)  # someone is subscribed, so the relay has the track
        await asyncio.sleep(0.5)
        await w.snapshot(b'{"state":"only object"}')
        await asyncio.sleep(10)
        async with connect(RELAY, insecure=True) as late:
            t = time.monotonic()
            rdr = await subscribe(late, ns, name)
            got = await rdr.read(1, timeout=3)
            results["C_late_join_quiet_10s_warm"] = {
                "got_groups": [o.group for o in got],
                "ms": round((time.monotonic() - t) * 1000),
            }
            log("C: late join after 10 s of silence (relay already subscribed):", results["C_late_join_quiet_10s_warm"])
        unsubscribe(warm, ns, name, keep)
        await asyncio.sleep(1)
        async with connect(RELAY, insecure=True) as cold:
            t = time.monotonic()
            rdr = await subscribe(cold, ns, name)
            got = await rdr.read(1, timeout=3)
            results["C_late_join_quiet_cold"] = {
                "got_groups": [o.group for o in got],
                "ms": round((time.monotonic() - t) * 1000),
            }
            log("C: join with no upstream subscription (the publisher must resend):", results["C_late_join_quiet_cold"])


async def part_d() -> None:
    ns, name = "spike/take", "t"
    p1_stack = contextlib.AsyncExitStack()
    p1 = await p1_stack.enter_async_context(connect(RELAY, insecure=True))
    w1 = p1.agent.writer(writer_spec(ns, name))
    await w1.start()
    stop = asyncio.Event()

    async def produce(w: Any, tag: str) -> None:
        while not stop.is_set():
            await w.snapshot(json.dumps({"pub": tag, "g": w.group + 1}).encode())
            await asyncio.sleep(0.2)

    t1 = asyncio.create_task(produce(w1, "p1"))
    async with connect(RELAY, insecure=True) as s1:
        r1 = await subscribe(s1, ns, name)
        seen1: list[Any] = []
        c1 = asyncio.create_task(collect(r1, seen1))
        await asyncio.sleep(3)

        async with connect(RELAY, insecure=True) as p2:
            w2 = p2.agent.writer(writer_spec(ns, name))
            w2._group = 1000 - 1  # continuing ids, as a restored agent would
            await w2.start()
            n_announce = len(seen1)
            t2 = asyncio.create_task(produce(w2, "p2"))
            await asyncio.sleep(3)
            async with connect(RELAY, insecure=True) as s2:
                r2 = await subscribe(s2, ns, name)
                got2 = await r2.read(3, timeout=3)
                results["D_new_subscriber_reads"] = [json.loads(o.payload)["pub"] for o in got2]
                log("D: a new subscriber after p2 announced reads:", results["D_new_subscriber_reads"])

            n_before = len(seen1)
            results["D_existing_subscriber_saw_while_both"] = sorted(
                {json.loads(o.payload)["pub"] for o in seen1[n_announce:n_before]}
            )
            log("D: existing subscriber while both publish:", results["D_existing_subscriber_saw_while_both"])
            t_close = time.monotonic()
            await p1_stack.aclose()  # clean leave of the first publisher
            t1.cancel()
            await asyncio.sleep(3)
            after = [json.loads(o.payload) for o in seen1[n_before:]]
            results["D_existing_after_p1_left"] = {
                "objects": len(after),
                "pubs": sorted({a["pub"] for a in after}),
                "groups": [a["g"] for a in after][:5],
                "reader_done": r1.done,
                "s_after_close": round(time.monotonic() - t_close, 2),
            }
            log("D: existing subscriber after p1 left:", results["D_existing_after_p1_left"])
            stop.set()
            t2.cancel()
        c1.cancel()


async def main() -> None:
    for part in (part_c, part_d, part_ab):
        try:
            await part()
        except Exception as exc:
            results[part.__name__ + "_error"] = f"{type(exc).__name__}: {exc}"
            log(part.__name__, "failed:", exc)
    print("RESULTS " + json.dumps(results, default=str))


asyncio.run(main())
