"""The benchmark's text track: a small JSON object with its publish time, BENCH_TEXT_HZ times a second, on broadcast
`bench/text` track `state`, one object per group. It runs in the agents' image and publishes through the agents' own
MoQ code (talk_tracks.moq: aiomoqt over raw QUIC), so it measures what a caption line goes through.

The viewer subtracts `t` (Unix ms, this host's clock) from its own clock when the object arrives."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time

from talk_tracks.moq import connect, until_closed

log = logging.getLogger("bench.textpub")


async def publish(relay_url: str, hz: float) -> None:
    async with connect(relay_url, insecure=True) as relay:
        sink = await relay.publish("bench/text", "state")
        log.info("publishing bench/text track state at %s Hz", hz)

        async def loop() -> None:
            seq = 0
            start = time.monotonic()
            while True:
                seq += 1
                # Padded to the size of a typical caption snapshot, so the object is not unrealistically small.
                line = {"seq": seq, "t": time.time() * 1000, "text": "x" * 160}
                await sink.write(json.dumps(line).encode())
                await asyncio.sleep(max(0.0, start + seq / hz - time.monotonic()))

        await until_closed(relay, loop())


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    relay_url = os.environ.get("BENCH_RELAY", "moqt://relay:4443")
    text_hz = float(os.environ.get("BENCH_TEXT_HZ", "4"))
    asyncio.run(publish(relay_url, text_hz))


if __name__ == "__main__":
    main()
