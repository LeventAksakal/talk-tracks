"""Spike 6: two measurements the design review asked for.

`induced`: how long the upstream SUBSCRIBE that moq-relay opens to forward a FETCH lives when the origin is slow
(0, 1.5 and 3 s), with nobody subscribed. If it lives until the FETCH completes, a slow back-fill would pass the
agents' 1 s wake debounce and start paid live work.

`quiet-pub`: the publisher side of web_quiet.mjs. One group, then silence, so a browser can late-join a track that has
been quiet for longer than the relay's 5 s max age for IETF-sourced tracks.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from typing import Any

from common import RELAY, fetch, fix_end, log, writer_spec

from talk_tracks.moq import connect


async def induced() -> None:
    results: dict[str, Any] = {}
    for delay in (0.0, 1.5, 3.0):
        ns, name = f"spike/induced{int(delay * 10)}", "t"
        async with connect(RELAY, insecure=True) as pub, connect(RELAY, insecure=True) as sub:
            w = pub.agent.writer(writer_spec(ns, name))
            await w.start()
            w._track.group_size = 3
            w._track.prefill(40)
            w._group = 39
            fix_end(w._track)
            track, events = w._track, []
            orig_sub, orig_fetch, orig_cancel = track._on_subscribe, track._on_fetch, track._on_request_cancelled

            async def on_sub(session: Any, msg: Any) -> None:
                events.append(("subscribe", time.monotonic()))
                await orig_sub(session, msg)

            async def on_fetch(session: Any, msg: Any, delay: float = delay) -> None:
                joining = msg.start_group is None
                events.append(("joining fetch" if joining else "fetch", time.monotonic()))
                if not joining:
                    await asyncio.sleep(delay)
                await orig_fetch(session, msg)
                if not joining:
                    events.append(("fetch answered", time.monotonic()))

            def on_cancel(request_id: int, s: Any = None) -> None:
                events.append(("subscribe cancelled", time.monotonic()))
                orig_cancel(request_id, s)

            track._on_subscribe, track._on_fetch, track._on_request_cancelled = on_sub, on_fetch, on_cancel
            await asyncio.sleep(0.3)
            t = time.monotonic()
            r = await fetch(sub, ns, name, 12, 12, timeout=8)
            await asyncio.sleep(1.0)
            ev = [(e, round((at - t) * 1000)) for e, at in events]
            sub_at = next((at for e, at in ev if e == "subscribe"), None)
            cancel_at = next((at for e, at in ev if e == "subscribe cancelled"), None)
            results[f"origin_{delay}s"] = {
                "fetch": r,
                "events_ms": ev,
                "induced_subscribe_lived_ms": None if sub_at is None or cancel_at is None else cancel_at - sub_at,
            }
            log(f"origin delay {delay} s:", results[f"origin_{delay}s"])
    print("RESULTS " + json.dumps(results, default=str))


async def quiet_pub(seconds: float) -> None:
    async with connect(RELAY, insecure=True) as pub:
        w = pub.agent.writer(writer_spec("spike/quiet", "t"))
        await w.start()
        await w.snapshot(json.dumps({"g": 0}).encode())
        log("published group", w.group, "then silence")
        await asyncio.sleep(seconds)


if sys.argv[1] == "induced":
    asyncio.run(induced())
else:
    asyncio.run(quiet_pub(float(sys.argv[2])))
