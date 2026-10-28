"""The benchmark's history track: an AI track as decision 0012 shapes it, live and past on one track.

Broadcast `bench/history`, track `items`. Group k is a 4 s time slice: object 0 is a carry-in state, then one item
every 250 ms, and End of Group: about 2.4 KB per slice, near the 1-2 KB of a captions slice (wiki/design/moq-track-system.md §4). The publisher is
also the origin of the track's past: a FETCH that misses the relay's cache comes here and is answered from the
track's history, which holds BENCH_ARCHIVE_SLICES slices "from before the benchmark" (an archive restored at start)
followed by the live ones.

Two pieces come from the MoQT spikes (spikes/moqt/): the publisher settings and `fix_end` (common.py), without which
aiomoqt reports an End Location the relay cannot use, so every forwarded FETCH of a whole group fails as "not found"
(spike S4b). The viewer reads the slice numbers it may fetch from the carry-in object (`archive`, `live_from`).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any

from aiomoqt.agent import PublishSpec, TrackRef

from talk_tracks.moq import connect, until_closed

log = logging.getLogger("bench.historypub")

SLICE_S = 4.0
ITEMS_PER_SLICE = 16


def fix_end(track: Any) -> None:
    """Report the last object of a whole-group FETCH from the history (spikes/moqt/common.py, spike S4c)."""
    orig = track._fetch_range

    def fixed(session: Any, msg: Any) -> tuple:
        start, last, end = orig(session, msg)
        if last[1] >= 1 << 62:
            held = track._history.last_object(last[0])
            last = (last[0], 0 if held is None else held)
            end = (last[0], last[1] + 1)
        return start, last, end

    track._fetch_range = fixed


def carry_in(slice_id: int, archive: int, live_from: int) -> bytes:
    return json.dumps({"kind": "carry", "slice": slice_id, "archive": archive, "live_from": live_from}).encode()


def item(slice_id: int, n: int) -> bytes:
    # A caption line's size: an id, times, and about 80 characters of text.
    text = f"slice {slice_id} line {n} " + "lorem ipsum dolor sit amet " * 2
    return json.dumps({"kind": "item", "slice": slice_id, "n": n, "t": time.time() * 1000, "text": text}).encode()


async def publish(relay_url: str, archive: int) -> None:
    async with connect(relay_url, insecure=True) as relay:
        w = relay.agent.writer(
            PublishSpec(track=TrackRef(namespace="bench/history", name="items"), buffer=64, on_full="drop_oldest")
        )
        await w.start()
        track = w._track
        # The archive: slices 0 .. archive-1 in the FETCH history, never published live, so the relay has never
        # seen them and the first FETCH of each goes to this origin.
        for k in range(archive):
            track._remember(k, 0, carry_in(k, archive, archive))
            for n in range(ITEMS_PER_SLICE):
                track._remember(k, n + 1, item(k, n))
        w._group = archive - 1  # live slices continue the numbering
        fix_end(track)
        served = 0
        orig_handle = getattr(track, "_fetch_range")

        def counted(session: Any, msg: Any) -> tuple:
            nonlocal served
            served += 1
            log.info("FETCH from the origin (%d so far): %s", served, repr(msg)[:240])
            return orig_handle(session, msg)

        track._fetch_range = counted
        log.info("publishing bench/history/items: archive slices 0..%d, live from %d", archive - 1, archive)

        async def loop() -> None:
            start = time.monotonic()
            k = archive
            while True:
                await w.snapshot(carry_in(k, archive, archive))
                for n in range(ITEMS_PER_SLICE):
                    await asyncio.sleep(max(0.0, start + (k - archive) * SLICE_S + (n + 1) * SLICE_S / 17 - time.monotonic()))
                    await w.write(item(k, n))
                # End of Group when the slice is over (design §4.1): a fetch of a just-closed slice then completes
                # at once instead of waiting for objects that never come.
                w.end_group()
                k += 1
                await asyncio.sleep(max(0.0, start + (k - archive) * SLICE_S - time.monotonic()))

        await until_closed(relay, loop())


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    asyncio.run(publish(os.environ.get("BENCH_RELAY", "moqt://relay:4443"), int(os.environ.get("BENCH_ARCHIVE_SLICES", "300"))))


if __name__ == "__main__":
    main()
