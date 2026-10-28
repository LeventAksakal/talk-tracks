"""Command line: ``python -m talk_tracks.archive --relay URL [--out DIR] [--insecure]``.

Follows every room under ``talk/**`` and writes the archive (``wiki/howto/archive.md``). Settings also come from the
environment: TT_RELAY, TT_TOKEN (watching is open, so usually unset), TT_ARCHIVE_DIR (default data/archive),
TT_ARCHIVE_ROOMS (glob patterns to keep, comma-separated, default all), TT_ARCHIVE_SKIP (patterns to skip, such as a
looped demo room), TT_ARCHIVE_SPOOL (the agents' spool to read, default ``archive-spool`` beside the archive),
TT_ARCHIVE_SUBSCRIBE_AGENTS (1: read agent tracks off the relay instead, which keeps lazy agents awake) and
TT_ARCHIVE_BUCKET (the Cloud Storage bucket to copy to, ``gs://name[/folder]``, folder
default ``archive``; unset: no copy).
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import os
import signal
from pathlib import Path

log = logging.getLogger("talk_tracks.archive")


def parse(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="talk_tracks.archive", description=__doc__.splitlines()[0] if __doc__ else None)
    p.add_argument("--relay", default=os.environ.get("TT_RELAY"), help="moqt://host:port or https://host:port/path")
    p.add_argument("--token", default=os.environ.get("TT_TOKEN") or None, help="signed relay token, if needed")
    p.add_argument("--out", type=Path, default=Path(os.environ.get("TT_ARCHIVE_DIR", "data/archive")))
    p.add_argument("--rooms", default=os.environ.get("TT_ARCHIVE_ROOMS", "*"), help="room patterns to archive")
    p.add_argument("--skip", default=os.environ.get("TT_ARCHIVE_SKIP", ""), help="room patterns not to archive")
    p.add_argument("--bucket", default=os.environ.get("TT_ARCHIVE_BUCKET") or None, help="Cloud Storage bucket")
    p.add_argument("--spool", type=Path, default=None, help="the agents' spool (default: archive-spool beside --out)")
    p.add_argument(
        "--subscribe-agents",
        action="store_true",
        default=os.environ.get("TT_ARCHIVE_SUBSCRIBE_AGENTS", "") == "1",
        help="read agent tracks off the relay (demand: keeps lazy agents awake) instead of from the spool",
    )
    p.add_argument("--insecure", action="store_true", help="skip TLS verification (local relay, self-signed cert)")
    args = p.parse_args(argv)
    if args.spool is None:
        configured = os.environ.get("TT_ARCHIVE_SPOOL")
        args.spool = Path(configured) if configured else args.out.parent / "archive-spool"
    if not args.relay:
        p.error("--relay is required (or TT_RELAY)")
    return args


async def main_async(args: argparse.Namespace) -> None:
    from ..moq import connect, until_closed
    from .bucket import GcsBucket, Uploader
    from .relay import archive_rooms
    from .spool import SpoolReader
    from .store import Archive, RoomFilter

    bucket = GcsBucket(args.bucket) if args.bucket else None
    uploader = Uploader(args.out, bucket)
    archive = Archive(args.out, on_file=uploader.notify)
    log.info(
        "archiving into %s, %s",
        args.out,
        f"copying to gs://{bucket.name}/{bucket.folder}" if bucket else "no bucket copy",
    )
    background = [asyncio.create_task(uploader.run()), asyncio.create_task(uploader.sync())]
    try:
        async with connect(args.relay, token=args.token, insecure=args.insecure) as relay:
            spool = None if args.subscribe_agents else SpoolReader(args.spool)
            rooms = RoomFilter(args.rooms, args.skip)
            await until_closed(
                relay, archive_rooms(relay, archive, rooms, spool=spool, subscribe_agents=args.subscribe_agents)
            )
    finally:
        archive.close()
        for task in background:
            task.cancel()
        await uploader.drain(5.0)
        if bucket is not None:
            await bucket.aclose()


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    args = parse(argv)

    async def run() -> None:
        task = asyncio.ensure_future(main_async(args))
        # SIGTERM (docker stop) closes the open segments and chunks before the process ends.
        with contextlib.suppress(NotImplementedError):
            asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
        with contextlib.suppress(asyncio.CancelledError):
            await task

    asyncio.run(run())


if __name__ == "__main__":
    main()
