"""Command line: ``python -m talk_tracks.archive --relay URL [--out DIR] [--insecure]``.

The room service: follows every room under ``talk/**``, records the speaker's media and slides, publishes each
room's ``catalog`` and copies the archive to the bucket, the agents' slices included (``wiki/howto/archive.md``).
Settings also come from the environment: TT_RELAY, TT_TOKEN (needs publish rights on ``talk/*/catalog``),
TT_ARCHIVE_DIR (default data/archive), TT_ARCHIVE_ROOMS (glob patterns to keep, comma-separated, default all),
TT_ARCHIVE_SKIP (patterns to skip, such as a looped demo room, whose looper publishes its own catalog) and
TT_ARCHIVE_BUCKET (the Cloud Storage bucket to copy to, ``gs://name[/folder]``, folder default ``archive``; unset: no
copy). The catalog marks paid agents ``capped`` from the agents' spend ledger: TT_LEDGER (default data/ledger.jsonl),
TT_CAPS_DIR (default data/caps), TT_ROOM_CAP_USD (default 2) and TT_SPEND_CEILING_USD (default 100).
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
    p.add_argument("--no-catalog", action="store_true", help="record only; do not publish the room catalogs")
    p.add_argument("--insecure", action="store_true", help="skip TLS verification (local relay, self-signed cert)")
    args = p.parse_args(argv)
    if not args.relay:
        p.error("--relay is required (or TT_RELAY)")
    return args


async def main_async(args: argparse.Namespace) -> None:
    from ..moq import connect, until_closed
    from .bucket import GcsBucket, Uploader
    from .catalog import Budget
    from .relay import archive_rooms
    from .slices import SliceWatcher
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
            slices = SliceWatcher(args.out)

            def copy_slices() -> None:  # the agents write them; the archiver copies them
                for path, mutable in slices.poll():
                    uploader.notify(path, mutable)

            rooms = RoomFilter(args.rooms, args.skip)
            budget = Budget(
                Path(os.environ.get("TT_LEDGER", "data/ledger.jsonl")),
                Path(os.environ.get("TT_CAPS_DIR", "data/caps")),
                float(os.environ.get("TT_SPEND_CEILING_USD", "100")),
                float(os.environ.get("TT_ROOM_CAP_USD", "2")),
            )
            work = archive_rooms(
                relay,
                archive,
                rooms,
                on_tick=copy_slices,
                publish_catalog=not args.no_catalog,
                capped=budget.capped,
            )
            await until_closed(relay, work)
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
        # SIGTERM (docker stop) closes the open segments before the process ends.
        with contextlib.suppress(NotImplementedError):
            asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
        with contextlib.suppress(asyncio.CancelledError):
            await task

    asyncio.run(run())


if __name__ == "__main__":
    main()
