"""Spike 4b: why does a FETCH of a group the relay never saw come back "not found"?

The publisher's history holds groups 0..39 (prefilled, never sent), and the publisher then produces live groups
40.. to a subscriber. FETCH an unseen old group before and after the relay has seen live groups, with the
publisher's FETCH handling logged. Variant: groups of one object (prefill writes 60 objects per group by default).
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from common import RELAY, fetch, log, subscribe, unsubscribe, writer_spec

from talk_tracks.moq import connect

logging.basicConfig(level=logging.WARNING, format="%(name)s %(message)s")
logging.getLogger("aiomoqt").setLevel(logging.INFO)
results: dict[str, Any] = {}


async def run(label: str, group_size: int) -> None:
    ns, name = f"spike/unseen{group_size}", "t"
    async with connect(RELAY, insecure=True) as pub, connect(RELAY, insecure=True) as sub:
        w = pub.agent.writer(writer_spec(ns, name))
        await w.start()
        w._track.group_size = group_size
        w._track.prefill(40)
        w._group = 39
        viewer = await subscribe(sub, ns, name)
        await asyncio.sleep(0.5)
        results[f"{label}_before_live"] = await fetch(sub, ns, name, 12, 12)
        log(label, "before any live group:", results[f"{label}_before_live"])
        for _ in range(6):
            await w.snapshot(json.dumps({"g": w.group + 1}).encode())
            await asyncio.sleep(0.2)
        results[f"{label}_after_live"] = await fetch(sub, ns, name, 13, 13)
        log(label, "after live groups 40..45:", results[f"{label}_after_live"])
        results[f"{label}_live_group"] = await fetch(sub, ns, name, 41, 41)
        log(label, "a live group (cached):", results[f"{label}_live_group"])
        unsubscribe(sub, ns, name, viewer)


async def main() -> None:
    await run("one_object_groups", 1)
    await run("sixty_object_groups", 60)
    print("RESULTS " + json.dumps(results, default=str))


asyncio.run(main())
