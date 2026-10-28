"""Spike 5: a publisher is killed (not closed) and a replacement announces the same stable name.

`pub <label> <first_group> [delay_s]`: wait, then publish 2 groups/s on spike/restart/t, each payload naming its publisher.
`watch <seconds>`: keep one subscription open and log every object; every second also open a fresh subscription on a second session,
log which publisher its first object came from and how long it took, and close it.

The shell starts both publishers together, the second with a delay, and kills the first with `docker kill` just
before the second connects (container start-up alone took ~10 s on the loaded host).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
import time

from common import RELAY, log, subscribe, unsubscribe, writer_spec

from talk_tracks.moq import connect

IDLE_S = float(os.environ.get("SPIKE_IDLE_S", "0"))  # S5b: the publisher advertises a short QUIC idle timeout


@contextlib.asynccontextmanager
async def connect_pub():
    """Like talk_tracks.moq.connect, with an optional QUIC idle timeout and keep-alive for the publisher."""
    if not IDLE_S:
        async with connect(RELAY, insecure=True) as s:
            yield s
        return
    from aiomoqt.client import MOQTClient
    from aiopquic.quic.configuration import QuicConfiguration

    from talk_tracks.moq import DRAFT, Relay

    cfg = QuicConfiguration(is_client=True, alpn_protocols=None)
    cfg.idle_timeout = IDLE_S
    cfg.keep_alive_interval = IDLE_S / 3
    host, port = RELAY.removeprefix("moqt://").split(":")
    client = MOQTClient(host, int(port), use_quic=True, verify_tls=False, supported_drafts=DRAFT,
                        configuration=cfg, keep_alive_interval=IDLE_S / 3)
    async with client.connect() as session:
        await session.client_session_init()
        yield Relay(session)

NS, NAME = "spike/restart", "t"


async def pub(label: str, first: int, delay: float) -> None:
    await asyncio.sleep(delay)
    log(label, "connecting")
    async with connect_pub() as s:
        log(label, "idle timeout", IDLE_S or "default")
        w = s.agent.writer(writer_spec(NS, NAME))
        await w.start()
        w._group = first - 1
        log(label, "announced")
        while True:
            await w.snapshot(json.dumps({"p": label, "g": w.group + 1}).encode())
            await asyncio.sleep(0.5)


async def first_object(s, timeout: float) -> str:
    t = time.monotonic()
    rdr = await subscribe(s, NS, NAME)
    try:
        while time.monotonic() - t < timeout:
            objs = rdr.drain()
            if objs:
                p = json.loads(objs[0].payload)
                return f"{p['p']} g{objs[0].group} in {round((time.monotonic() - t) * 1000)} ms"
            await asyncio.sleep(0.02)
        return f"nothing in {timeout} s"
    finally:
        unsubscribe(s, NS, NAME, rdr)


async def watch(seconds: float) -> None:
    async with connect(RELAY, insecure=True) as s, connect(RELAY, insecure=True) as probe_s:
        held = await subscribe(s, NS, NAME)
        t0, last, probe = time.monotonic(), None, time.monotonic()
        while time.monotonic() - t0 < seconds:
            for o in held.drain():
                p = json.loads(o.payload)
                if last is None or p["p"] != last[0] or time.monotonic() - last[1] > 1.5:
                    log("held subscription:", p["p"], "g", o.group)
                last = (p["p"], time.monotonic())
            if held.done:
                log("held subscription ended:", held.ended)
                unsubscribe(s, NS, NAME, held)
                held = await subscribe(s, NS, NAME)
                log("held subscription reopened")
            if time.monotonic() - probe >= 1:
                probe = time.monotonic()
                log("fresh subscription:", await first_object(probe_s, 1.5))
            await asyncio.sleep(0.05)


if sys.argv[1] == "pub":
    asyncio.run(pub(sys.argv[2], int(sys.argv[3]), float(sys.argv[4]) if len(sys.argv) > 4 else 0))
else:
    asyncio.run(watch(float(sys.argv[2])))
