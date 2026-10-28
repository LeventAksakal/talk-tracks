"""Spike 1: what moq-relay 0.17.8 does with SUBSCRIBE, FETCH and TRACK_STATUS from an IETF draft-18 client.

One aiomoqt publisher writes one object per group at 10 groups/s; aiomoqt subscribers on a second session ask the
relay for live and past objects. Hooks on the publisher's track show which requests the relay forwards upstream.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from typing import Any

from aiomoqt.agent import StartAt
from aiomoqt.agent.reader import Reader
from aiomoqt.agent.spec import FetchSpec
from aiomoqt.messages.fetch import FetchType
from common import RELAY, fetch, log, payload, ref, span, subscribe, unsubscribe, writer_spec

from talk_tracks.moq import connect

NS, NAME = "spike/fetch", "t"
RATE = 10
results: dict[str, Any] = {}
upstream: list[str] = []


def hook(track: Any) -> None:
    """Log every SUBSCRIBE, FETCH and TRACK_STATUS the relay sends to the publisher."""
    for name in ("_on_subscribe", "_on_fetch", "_on_track_status"):
        orig = getattr(track, name)

        async def wrapped(session: Any, msg: Any, orig: Any = orig, name: str = name) -> None:
            detail = {k: getattr(msg, k, None) for k in ("fetch_type", "start_group", "end_group", "filter_type")}
            upstream.append(f"{time.monotonic():.2f} {name} {detail}")
            log("PUBLISHER got", name, detail)
            await orig(session, msg)

        setattr(track, name, wrapped)


async def collect(rdr: Any, into: list[int]) -> None:
    while not rdr.done:
        objs = await rdr.read(1, timeout=0.05)
        objs += rdr.drain()
        into += [o.group for o in objs]


async def track_status(relay: Any) -> str:
    try:
        reply = await asyncio.wait_for(relay.session.track_status(NS, NAME, wait_response=True), 5)
    except Exception as exc:
        return f"{type(exc).__name__}: {exc}"
    return repr(reply)[:300]


async def main() -> None:
    pub_stack = contextlib.AsyncExitStack()
    pub = await pub_stack.enter_async_context(connect(RELAY, insecure=True))
    writer = pub.agent.writer(writer_spec(NS, NAME))
    await writer.start()
    hook(writer._track)
    stop = asyncio.Event()

    async def produce() -> None:
        while not stop.is_set():
            await writer.snapshot(payload(writer.group + 1))
            await asyncio.sleep(1 / RATE)

    producer = asyncio.create_task(produce())
    async with connect(RELAY, insecure=True) as sub:
        await asyncio.sleep(0.5)
        a = await subscribe(sub, NS, NAME)
        seen_a: list[int] = []
        task_a = asyncio.create_task(collect(a, seen_a))

        await asyncio.sleep(2.5)
        results["track_status_live"] = await track_status(sub)
        log("TRACK_STATUS live:", results["track_status_live"])

        await asyncio.sleep(2)
        at = writer.group
        # draft-18 refuses a second subscription to the same track on one session (DUPLICATE_SUBSCRIPTION), so
        # late join and past start each use their own session.
        async with connect(RELAY, insecure=True) as sub_b, connect(RELAY, insecure=True) as sub_c:
            b = await subscribe(sub_b, NS, NAME)
            first_b = await b.read(1, timeout=2)
            results["late_join"] = {"publisher_group": at, "first_group": first_b[0].group if first_b else None}
            log("late join (Largest Object filter):", results["late_join"])

            at = writer.group
            c = await subscribe(sub_c, NS, NAME, StartAt.at(10))
            first_c = await c.read(3, timeout=2)
            results["absolute_start_past"] = {"asked": 10, "publisher_group": at, "got": [o.group for o in first_c]}
            log("SUBSCRIBE AbsoluteStart group 10:", results["absolute_start_past"])

            for lo, hi in ((0, 9), (40, 45), (60, 60)):
                r = await fetch(sub, NS, NAME, lo, hi)
                results[f"fetch_{lo}_{hi}_young"] = {**r, "groups": span(r.get("groups", []))}
                log(f"FETCH {lo}..{hi} at group {writer.group}:", results[f"fetch_{lo}_{hi}_young"])

            # Joining FETCH (relative, 5 groups back) against sub_b's subscription.
            msg = sub_b.session.joining_fetch(b.request_id, joining_start=5, fetch_type=FetchType.RELATIVE_JOINING)
            jr = Reader(FetchSpec(track=ref(NS, NAME), start_at=StartAt.range(0, 0)), "join")
            sub_b.session.register_fetch_object_handler(msg.request_id, jr.on_fetched)
            clean = await sub_b.session.await_fetch_done(msg.request_id, 5)
            got = [o.group for o in jr.drain()]
            results["joining_fetch_rel5"] = {"clean": clean, "groups": got, "subscribed_from": first_b[0].group}
            log("joining FETCH relative 5:", results["joining_fetch_rel5"])

            unsubscribe(sub_b, NS, NAME, b)
            unsubscribe(sub_c, NS, NAME, c)

        await asyncio.sleep(max(0, 40 - (time.monotonic() - T_START)))
        for lo, hi in ((0, 9), (300, 305)):
            r = await fetch(sub, NS, NAME, lo, hi)
            results[f"fetch_{lo}_{hi}_at40s"] = {**r, "groups": span(r.get("groups", []))}
            log(f"FETCH {lo}..{hi} at group {writer.group}:", results[f"fetch_{lo}_{hi}_at40s"])

        # The last viewer leaves: how long until the publisher stops producing?
        t = time.monotonic()
        unsubscribe(sub, NS, NAME, a)
        while writer._track.producing and time.monotonic() - t < 15:
            await asyncio.sleep(0.005)
        results["idle_after_last_unsubscribe_ms"] = round((time.monotonic() - t) * 1000)
        log("publisher idle after", results["idle_after_last_unsubscribe_ms"], "ms")
        task_a.cancel()

        await asyncio.sleep(1)
        g = writer.group
        r = await fetch(sub, NS, NAME, g - 30, g - 25)
        results["fetch_no_subscribers"] = {**r, "groups": span(r.get("groups", [])), "asked": [g - 30, g - 25]}
        log("FETCH with publisher live, no subscribers:", results["fetch_no_subscribers"])

        stop.set()
        producer.cancel()
        last = writer.group
        await pub_stack.aclose()
        log("publisher session closed at group", last)
        await asyncio.sleep(2)
        r = await fetch(sub, NS, NAME, last - 5, last)
        results["fetch_after_publisher_gone"] = {**r, "groups": span(r.get("groups", [])), "asked": [last - 5, last]}
        log("FETCH after publisher gone:", results["fetch_after_publisher_gone"])
        results["track_status_gone"] = await track_status(sub)
        log("TRACK_STATUS after publisher gone:", results["track_status_gone"])

    results["upstream_requests"] = upstream
    print("RESULTS " + json.dumps(results, default=str))


T_START = time.monotonic()
asyncio.run(main())
