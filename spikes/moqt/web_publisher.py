"""The publisher side of spike 3: one JSON object per group at 2 groups/s for 60 s, then a clean leave.

Logs every FETCH the relay forwards to it, so web_fetch.mjs's results can be matched to what reached the origin.
With SPIKE_FIX_END=1 the track reports a whole group's true End Location (spike 4c), so forwarded FETCHes are served.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any

from common import RELAY, fix_end, log, writer_spec

from talk_tracks.moq import connect


async def main() -> None:
    async with connect(RELAY, insecure=True) as pub:
        w = pub.agent.writer(writer_spec("spike/web", "t"))
        await w.start()
        if os.environ.get("SPIKE_FIX_END") == "1":
            fix_end(w._track)
        orig = w._track._on_fetch

        async def on_fetch(session: Any, msg: Any) -> None:
            log("ORIGIN got FETCH", msg.start_group, "..", msg.end_group)
            await orig(session, msg)

        w._track._on_fetch = on_fetch
        t0 = time.monotonic()
        while time.monotonic() - t0 < 60:
            await w.snapshot(json.dumps({"g": w.group + 1, "wall_ms": time.time_ns() // 1_000_000}).encode())
            await asyncio.sleep(0.5)
        log("leaving at group", w.group, "producing", w._track.producing)


asyncio.run(main())
