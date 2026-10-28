"""Copying the archive off the VM: every finished file goes to a Cloud Storage bucket within seconds.

The bucket comes from ``TT_ARCHIVE_BUCKET`` (never from the repo); unset, nothing is copied. Credentials are the VM's
service account through the metadata server (Application Default Credentials on Compute Engine), so no key file
exists anywhere. Needs ``roles/storage.objectUser`` on that one bucket (indexes and the open chunks are overwritten).

* A finished file that never changes (a media segment, a closed chunk, an image) is uploaded once, at once.
* A file that keeps changing (an index, an open chunk, ``latest/``) is uploaded at most every ``MUTABLE_EVERY_S``.
* At start, everything on disk that the bucket lacks (or holds at another size) is uploaded: nothing is lost when
  the archiver restarts with uploads still queued.
* Failures are retried with backoff and never stop the archiver.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import mimetypes
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote

import httpx

log = logging.getLogger("talk_tracks.archive.bucket")

METADATA = "http://169.254.169.254"  # the Compute Engine metadata server (metadata.google.internal)
STORAGE = "https://storage.googleapis.com"
DEFAULT_FOLDER = "archive"
MUTABLE_EVERY_S = 2.0
RETRY_S = (1.0, 2.0, 5.0, 10.0, 30.0)
CONTENT_TYPES = {".m4s": "video/iso.segment", ".mp4": "video/mp4", ".jsonl": "application/x-ndjson"}


class Bucket(Protocol):
    async def put(self, name: str, data: bytes, content_type: str) -> None: ...

    def sizes(self, prefix: str = "") -> AsyncIterator[tuple[str, int]]: ...


class GcsBucket:
    """The Cloud Storage JSON API with a token from the metadata server.

    ``bucket`` is ``name`` or ``gs://name[/folder]``: the archive goes under ``folder/`` (default ``archive/``), so
    the same bucket can hold other copies (demo recordings, the spend ledger) beside it.
    """

    def __init__(
        self,
        bucket: str,
        *,
        metadata: str = METADATA,
        storage: str = STORAGE,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        name, _, folder = bucket.removeprefix("gs://").strip("/").partition("/")
        self.name = name
        self.folder = (folder.strip("/") or DEFAULT_FOLDER) + "/"
        self._metadata, self._storage = metadata, storage
        self._client = httpx.AsyncClient(timeout=30, transport=transport)
        self._token: str | None = None
        self._expires = 0.0

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _auth(self) -> dict[str, str]:
        if self._token is None or time.monotonic() > self._expires:
            r = await self._client.get(
                f"{self._metadata}/computeMetadata/v1/instance/service-accounts/default/token",
                headers={"Metadata-Flavor": "Google"},
            )
            r.raise_for_status()
            body: dict[str, Any] = r.json()
            self._token = str(body["access_token"])
            self._expires = time.monotonic() + float(body.get("expires_in", 300)) - 60
        return {"Authorization": f"Bearer {self._token}"}

    async def put(self, name: str, data: bytes, content_type: str) -> None:
        r = await self._client.post(
            f"{self._storage}/upload/storage/v1/b/{quote(self.name, safe='')}/o",
            params={"uploadType": "media", "name": self.folder + name},
            content=data,
            headers={**await self._auth(), "Content-Type": content_type},
        )
        r.raise_for_status()

    async def sizes(self, prefix: str = "") -> AsyncIterator[tuple[str, int]]:
        token: str | None = None
        while True:
            params = {"prefix": self.folder + prefix, "fields": "items(name,size),nextPageToken"}
            if token:
                params["pageToken"] = token
            r = await self._client.get(
                f"{self._storage}/storage/v1/b/{quote(self.name, safe='')}/o", params=params, headers=await self._auth()
            )
            r.raise_for_status()
            body: dict[str, Any] = r.json()
            for item in body.get("items", []):
                yield str(item["name"]).removeprefix(self.folder), int(item["size"])
            token = body.get("nextPageToken")
            if not token:
                return


def content_type(name: str) -> str:
    suffix = Path(name).suffix
    return CONTENT_TYPES.get(suffix) or mimetypes.guess_type(name)[0] or "application/octet-stream"


class Uploader:
    """Follows the archive's finished files (``notify``) and copies them to the bucket in the background."""

    def __init__(self, root: Path, bucket: Bucket | None, *, mutable_every_s: float = MUTABLE_EVERY_S) -> None:
        self.root, self.bucket = root, bucket
        self._every = mutable_every_s
        self._now: list[str] = []  # immutable files, in order
        self._later: dict[str, float] = {}  # mutable file -> when it may next go
        self._sent: dict[str, float] = {}  # mutable file -> when it last went
        self._wake = asyncio.Event()
        self.uploaded = 0
        self.failed = 0

    def notify(self, path: str, mutable: bool) -> None:
        if self.bucket is None:
            return
        if mutable:
            if path not in self._later:
                self._later[path] = self._sent.get(path, 0.0) + self._every
        else:
            self._later.pop(path, None)
            self._now.append(path)
        self._wake.set()

    @property
    def pending(self) -> int:
        return len(self._now) + len(self._later)

    async def sync(self) -> None:
        """Upload what the bucket lacks: files queued before a restart, or written while the bucket was away."""
        if self.bucket is None:
            return
        remote = {name: size async for name, size in self.bucket.sizes()}
        missing = [
            p.relative_to(self.root).as_posix()
            for p in sorted(self.root.rglob("*"))
            if p.is_file()
            and not p.name.endswith(".tmp")
            and remote.get(p.relative_to(self.root).as_posix()) != p.stat().st_size
        ]
        log.info("bucket copy: %d files to catch up", len(missing))
        self._now.extend(missing)
        self._wake.set()

    async def run(self) -> None:
        """Upload forever. Start ``sync`` alongside."""
        if self.bucket is None:
            return
        while True:
            path = self._next()
            if path is None:
                self._wake.clear()
                due = min(self._later.values(), default=None)
                timeout = None if due is None else max(0.0, due - time.monotonic())
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._wake.wait(), timeout)
                continue
            await self._upload(path)

    def _next(self) -> str | None:
        if self._now:
            return self._now.pop(0)
        now = time.monotonic()
        for path, due in self._later.items():
            if due <= now:
                del self._later[path]
                self._sent[path] = now
                return path
        return None

    async def _upload(self, path: str) -> None:
        assert self.bucket is not None
        for attempt, wait in enumerate((0.0, *RETRY_S)):
            await asyncio.sleep(wait)
            try:
                data = (self.root / path).read_bytes()
            except FileNotFoundError:
                return
            try:
                await self.bucket.put(path, data, content_type(path))
                self.uploaded += 1
                return
            except Exception as exc:
                log.warning("upload of %s failed (attempt %d): %s", path, attempt + 1, exc)
        self.failed += 1
        log.error("giving up on %s for now; the next start's sync copies it", path)

    async def drain(self, timeout_s: float) -> None:
        """Send what is queued, mutable files too, for up to ``timeout_s`` (a clean stop)."""
        if self.bucket is None:
            return
        self._now.extend(self._later)
        self._later.clear()
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout(timeout_s):
                while self._now:
                    await self._upload(self._now.pop(0))
