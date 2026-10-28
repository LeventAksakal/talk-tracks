"""Spike 4c: an origin that reports the true End Location serves groups the relay never saw.

Spike 4b got "not found" for every forwarded FETCH of a group only the publisher's history held. At draft-18 the
relay asks for a whole group as End {g, 0}; aiomoqt's PublishedTrack answers End Object 2^62 + 1 for a group below
the Largest Object, past the QUIC varint limit, and moq-net rejects an End at or before the start as NotFound.

A: the stock track again, logging the FETCH_OK the origin sends.
B: the same track with the End Location set from the history's last object in the group.
C: an "archive" origin for a track name nobody published: SUBSCRIBE and FETCH both go to session handlers
   (register_handler), and FETCH is answered from a dict, as an archive on disk would be.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from aiomoqt.messages.data import FetchObject
from aiomoqt.types import MOQTMessageType
from common import RELAY, fetch, fix_end, log, subscribe, unsubscribe, writer_spec

from talk_tracks.moq import connect

logging.basicConfig(level=logging.WARNING, format="%(name)s %(message)s")
results: dict[str, Any] = {}
fetch_oks: list[str] = []


class FetchOkLog(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        msg = record.getMessage()
        if "FetchOk" in msg or "FETCH" in msg and "refused" in msg:
            fetch_oks.append(msg[:240])


aio = logging.getLogger("aiomoqt")
aio.setLevel(logging.INFO)
aio.addHandler(FetchOkLog())
aio.propagate = False


async def run_track(label: str, fixed: bool) -> None:
    ns, name = f"spike/end-{label}", "t"
    async with connect(RELAY, insecure=True) as pub, connect(RELAY, insecure=True) as sub:
        w = pub.agent.writer(writer_spec(ns, name))
        await w.start()
        w._track.group_size = 3
        w._track.prefill(40)
        w._group = 39
        if fixed:
            fix_end(w._track)
        viewer = await subscribe(sub, ns, name)
        for _ in range(4):
            await w.snapshot(json.dumps({"g": w.group + 1}).encode())
            await asyncio.sleep(0.2)
        n = len(fetch_oks)
        for g in (12, 13, 12):
            r = await fetch(sub, ns, name, g, g)
            results[f"{label}_fetch_{g}_{len(results)}"] = r
            log(label, f"FETCH unseen group {g}:", r)
        results[f"{label}_origin_said"] = fetch_oks[n:]
        for line in fetch_oks[n:]:
            log(label, "origin:", line)
        unsubscribe(sub, ns, name, viewer)


ARCHIVE = {g: [json.dumps({"slice": g, "o": o}).encode() for o in range(3)] for g in range(50)}


async def run_archive() -> None:
    """A track the origin never published: the relay forwards SUBSCRIBE and FETCH to the session's handlers."""
    ns = "spike/archive"
    seen: list[str] = []

    async def on_subscribe(session: Any, msg: Any) -> None:
        seen.append(f"SUBSCRIBE {msg.track_name!r}")
        session.subscribe_ok(msg, content_exists=1, largest_group_id=49, largest_object_id=2)

    async def on_fetch(session: Any, msg: Any) -> None:
        g = msg.start_group
        seen.append(f"FETCH {msg.track_name!r} {g}/{msg.start_object}..{msg.end_group}/{msg.end_object}")
        objs = ARCHIVE.get(g)
        if g is None or objs is None:
            session.fetch_error(request_id=msg.request_id, error_code=0x10, reason="no such slice")
            return
        session.fetch_ok(request_id=msg.request_id, largest_group_id=g, largest_object_id=len(objs))
        await session.serve_fetch(
            msg.request_id, [FetchObject(group_id=g, object_id=o, payload=p) for o, p in enumerate(objs)]
        )

    async with connect(RELAY, insecure=True) as pub, connect(RELAY, insecure=True) as sub:
        pub.session.register_handler(MOQTMessageType.SUBSCRIBE, on_subscribe)
        pub.session.register_handler(MOQTMessageType.FETCH, on_fetch)
        w = pub.agent.writer(writer_spec(ns, "live"))  # announces the namespace
        await w.start()
        await asyncio.sleep(0.3)
        t = time.monotonic()
        r = await fetch(sub, ns, "history-m0042", 7, 7)
        results["archive_fetch_no_subscriber"] = r
        log("archive: FETCH made-up name, nobody subscribed:", r)
        viewer = await subscribe(sub, ns, "history-m0042")
        log("archive: SUBSCRIBE made-up name:", "ok" if viewer is not None else "none")
        for g in (8, 9, 8, 60):
            r = await fetch(sub, ns, "history-m0042", g, g)
            results[f"archive_fetch_{g}_{len(results)}"] = r
            log(f"archive: FETCH slice {g} with a subscriber:", r)
        unsubscribe(sub, ns, "history-m0042", viewer)
        results["archive_origin_saw"] = seen
        for line in seen:
            log("archive origin saw:", line)
        log("archive total", round(time.monotonic() - t, 2), "s")


async def main() -> None:
    await run_track("stock", fixed=False)
    await run_track("fixed", fixed=True)
    await run_archive()
    print("RESULTS " + json.dumps(results, default=str))


asyncio.run(main())
