"""The slice store: each agent writes every object it publishes, and reads a slice back to answer a FETCH.

Decision 0012: every AI track cuts group k as media time [k·S, (k+1)·S), S = 4 s. Its publisher is the origin of the
track's history, so it records what it sends and serves FETCH misses from the record (disk, then the bucket). Nothing
here touches the transport: the agents' publish path calls ``write`` beside each object it sends, ``end_group`` when
a slice is over, and ``read`` in its FETCH handler.

Layout under the archive (``TT_ARCHIVE_DIR``, by default ``archive/`` beside ``TT_STATE_DIR``)::

    <room>/agents/<agent>/<track>/<k:08d>.part    the open slice, appended object by object
    <room>/agents/<agent>/<track>/<k:08d>.slice   a finished slice (renamed from .part at End of Group); immutable
    <room>/agents/<agent>/<track>/track.json      what the room catalog lists: kind, lang, depends, status

A slice file holds one JSON line per object, in object order, byte-identical payloads::

    {"o": 0, "t": "{\\"kind\\": \\"carry\\", ...}"}   payload as text when it is UTF-8 ("b": base64 otherwise)
    {"o": 1, "t": "...", "p": 224}                    publisher priority, subgroup ("sg"), extensions ("x") and
    {"o": 2, "st": 3}                                 status ("st") only when not the default; 3 = End of Group

The last line of a finished slice is the End of Group object (status 3), or End of Track (status 4) for the last
slice of a talk. One process writes a track at a time (stable names, decision 0012), so writers never contend; a
reader of an open slice sees its complete lines. The archiver copies finished slices to the bucket (decision 0011).
"""

from __future__ import annotations

import base64
import json
import os
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Protocol, TextIO

from ..contracts import parse_room
from .bucket import GcsBucket
from .store import write_atomic

SLICE_MS = 4000
NORMAL, DOES_NOT_EXIST, END_OF_GROUP, END_OF_TRACK = 0, 1, 3, 4  # MoQT object status (aiomoqt ObjectStatus)
DEFAULT_PRIORITY = 128
PART, FINISHED, TRACK_INFO = ".part", ".slice", "track.json"

Status = Literal["idle", "live", "capped"]


def slice_of(media_ms: int) -> int:
    """The group that holds media time ``media_ms``."""
    return max(0, media_ms) // SLICE_MS


def archive_bucket() -> GcsBucket | None:
    """The bucket to read missing slices from: ``TT_ARCHIVE_BUCKET``, unset means none. One per process."""
    global _bucket
    name = os.environ.get("TT_ARCHIVE_BUCKET")
    if name and _bucket is None:
        _bucket = GcsBucket(name)
    return _bucket


_bucket: GcsBucket | None = None


def default_root() -> Path:
    configured = os.environ.get("TT_ARCHIVE_DIR")
    if configured:
        return Path(configured)
    return Path(os.environ.get("TT_STATE_DIR", "data/state")).parent / "archive"


@dataclass(frozen=True, slots=True)
class SliceObject:
    """One MoQT object. The field names are aiomoqt's (``FetchObject(group_id=k, **obj.fields())``)."""

    object_id: int
    payload: bytes = b""
    status: int = NORMAL
    subgroup_id: int = 0
    publisher_priority: int = DEFAULT_PRIORITY
    extensions: dict[int, bytes] | None = None

    def fields(self) -> dict[str, Any]:
        return {
            "object_id": self.object_id,
            "payload": self.payload,
            "status": self.status,
            "subgroup_id": self.subgroup_id,
            "publisher_priority": self.publisher_priority,
            "extensions": self.extensions,
        }


@dataclass(frozen=True, slots=True)
class Slice:
    group: int
    objects: tuple[SliceObject, ...]  # in object order; a finished slice ends with its End of Group object

    @property
    def complete(self) -> bool:
        return bool(self.objects) and self.objects[-1].status in (END_OF_GROUP, END_OF_TRACK)

    @property
    def end_of_track(self) -> bool:
        return bool(self.objects) and self.objects[-1].status == END_OF_TRACK

    @property
    def last_object_id(self) -> int | None:
        """The FETCH_OK End Location's object (with ``group``): the last object stored, End of Group included."""
        return self.objects[-1].object_id if self.objects else None


@dataclass
class TrackInfo:
    """What the room catalog says about a track (decision 0012, design §5.10). Written to ``track.json``."""

    kind: str  # captions, translation, slides, outline, ...
    label: str = ""
    lang: str | None = None
    packaging: Literal["slices", "snapshot"] = "slices"
    depends: list[str] = field(default_factory=list[str])  # tracks this one reads, as "<agent>/<track>"
    cost: Literal["paid", "free"] = "paid"


class SliceExists(Exception):
    """The slice was finished, or another process left it open: objects are immutable, so it is not rewritten."""


class ReadBucket(Protocol):
    async def get(self, name: str) -> bytes | None: ...


class TrackArchive:
    """The record of one agent track in one room: ``talk/<room>/agents/<agent>``, track ``track``."""

    def __init__(
        self,
        room: str,
        agent: str,
        track: str,
        *,
        root: Path | None = None,
        bucket: ReadBucket | None = None,
        info: TrackInfo | None = None,
    ) -> None:
        parse_room(room)
        for part in (agent, track):
            if not part or not all(c.isalnum() or c in "-_" for c in part):
                raise ValueError(f"not usable as an archive name: {part!r}")
        self.room, self.agent, self.track = room, agent, track
        self.root = root or default_root()
        self.relpath = f"{room}/agents/{agent}/{track}"
        self.dir = self.root / self.relpath
        self.bucket = bucket
        self._open: dict[int, tuple[TextIO, int]] = {}  # group -> (file, last object id)
        self._info: dict[str, Any] | None = None
        if info is not None:
            self._info = {"name": track, "agent": agent, **info.__dict__, "status": "idle"}
            if info.packaging == "slices":
                self._info["sliceMs"] = SLICE_MS
            self._save_info()

    def path(self, group: int, suffix: str = FINISHED) -> Path:
        return self.dir / f"{group:08d}{suffix}"

    # --- writing --------------------------------------------------------------------------------------------------

    def write(self, group: int, obj: SliceObject) -> None:
        """Record an object as it is published. Object ids rise within a group; several groups may be open (a
        back-fill beside the live slice)."""
        if group < 0:
            raise ValueError(f"no group {group}")
        held = self._open.get(group)
        if held is None:
            f = self._begin(group)
            last = -1
        else:
            f, last = held
        if obj.object_id <= last:
            raise ValueError(f"object {obj.object_id} after {last} in group {group}")
        f.write(_encode(obj) + "\n")
        f.flush()
        self._open[group] = (f, obj.object_id)

    def end_group(self, group: int, *, end_of_track: bool = False) -> Slice:
        """Close a slice with End of Group (or End of Track) and make it final. An empty slice is allowed: it holds
        only the end marker (``object_id`` 0)."""
        held = self._open.get(group)
        f = self._begin(group) if held is None else held[0]
        last = -1 if held is None else held[1]
        end = SliceObject(object_id=last + 1, status=END_OF_TRACK if end_of_track else END_OF_GROUP)
        f.write(_encode(end) + "\n")
        f.close()
        self._open.pop(group, None)
        os.replace(self.path(group, PART), self.path(group))
        done = self.read_local(group)
        assert done is not None
        return done

    def discard(self, group: int) -> bool:
        """Remove an open slice another process left behind (it died mid-slice), so the group can be written anew,
        as a back-fill does. A finished slice is never removed."""
        if group in self._open:
            return False
        try:
            self.path(group, PART).unlink()
            return True
        except FileNotFoundError:
            return False

    def set_status(self, status: Status) -> None:
        """Tell the room catalog whether the track is idle, live or capped (needs ``info``)."""
        if self._info is not None and self._info.get("status") != status:
            self._info["status"] = status
            self._save_info()

    def close(self) -> None:
        """Close open files. Their slices stay ``.part``: a replacement publisher starts at the next slice."""
        for f, _ in self._open.values():
            f.close()
        self._open.clear()

    def _begin(self, group: int) -> TextIO:
        if self.path(group).exists() or self.path(group, PART).exists():
            raise SliceExists(f"{self.relpath} group {group}")
        self.dir.mkdir(parents=True, exist_ok=True)
        return self.path(group, PART).open("x", encoding="utf-8", newline="\n")

    def _save_info(self) -> None:
        assert self._info is not None
        self._info["updated_ms"] = int(time.time() * 1000)
        write_atomic(self.dir / TRACK_INFO, (json.dumps(self._info, indent=1) + "\n").encode())

    # --- reading --------------------------------------------------------------------------------------------------

    def read_local(self, group: int) -> Slice | None:
        """The slice from disk: finished, or open (its complete lines). None when this disk never had it."""
        for suffix in (FINISHED, PART):
            try:
                data = self.path(group, suffix).read_bytes()
            except FileNotFoundError:
                continue
            return Slice(group, tuple(_decode_lines(data)))
        return None

    async def read(self, group: int) -> Slice | None:
        """The slice from disk, else from the bucket (then kept on disk). None when it was never produced."""
        found = self.read_local(group)
        if found is not None or self.bucket is None or group < 0:
            return found
        data = await self.bucket.get(f"{self.relpath}/{group:08d}{FINISHED}")
        if data is None:
            return None
        write_atomic(self.path(group), data)
        return Slice(group, tuple(_decode_lines(data)))

    def groups(self) -> list[int]:
        """Every slice on disk, finished or open, in order."""
        found: set[int] = set()
        for p in listdir(self.dir):
            stem, dot, suffix = p.partition(".")
            if dot and "." + suffix in (FINISHED, PART) and stem.isdigit():
                found.add(int(stem))
        return sorted(found)

    def latest_group(self) -> int | None:
        """The newest slice on disk: where a restarted agent seeds itself (it continues at the next one)."""
        groups = self.groups()
        return groups[-1] if groups else None


def _encode(obj: SliceObject) -> str:
    line: dict[str, Any] = {"o": obj.object_id}
    if obj.status != NORMAL:
        line["st"] = obj.status
    if obj.subgroup_id:
        line["sg"] = obj.subgroup_id
    if obj.publisher_priority != DEFAULT_PRIORITY:
        line["p"] = obj.publisher_priority
    if obj.extensions:
        line["x"] = {str(k): base64.b64encode(v).decode() for k, v in obj.extensions.items()}
    if obj.payload:
        try:
            line["t"] = obj.payload.decode("utf-8")
        except UnicodeDecodeError:
            line["b"] = base64.b64encode(obj.payload).decode()
    return json.dumps(line, ensure_ascii=False, separators=(",", ":"))


def _decode_lines(data: bytes) -> Iterator[SliceObject]:
    end = data.rfind(b"\n") + 1  # a line still being written is not an object yet
    for raw in data[:end].splitlines():
        if not raw.strip():
            continue
        line: dict[str, Any] = json.loads(raw)
        payload = line["t"].encode("utf-8") if "t" in line else base64.b64decode(line.get("b", ""))
        ext: dict[str, str] | None = line.get("x")
        yield SliceObject(
            object_id=int(line["o"]),
            payload=payload,
            status=int(line.get("st", NORMAL)),
            subgroup_id=int(line.get("sg", 0)),
            publisher_priority=int(line.get("p", DEFAULT_PRIORITY)),
            extensions={int(k): base64.b64decode(v) for k, v in ext.items()} if ext else None,
        )


def listdir(path: Path) -> list[str]:
    try:
        return os.listdir(path)
    except FileNotFoundError:
        return []


# --- the archiver's side: finding finished slices to copy, and the tracks to list in the catalog -----------------


class SliceWatcher:
    """Finds slices agents finished since the last poll, by the track folders' modification times (a rename into
    ``.slice`` changes them), so the archiver copies them to the bucket without rescanning the archive."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._seen: dict[str, tuple[float, set[str]]] = {}  # track folder -> (mtime, finished names)
        self.poll()  # what is there at start is the bucket sync's job

    def poll(self) -> list[tuple[str, bool]]:
        """(relpath, mutable) for each new finished slice and each changed ``track.json``."""
        out: list[tuple[str, bool]] = []
        for room in listdir(self.root):
            agents = self.root / room / "agents"
            for agent in listdir(agents):
                for track in listdir(agents / agent):
                    folder = agents / agent / track
                    key = f"{room}/agents/{agent}/{track}"
                    try:
                        mtime = folder.stat().st_mtime
                    except (FileNotFoundError, NotADirectoryError):
                        continue
                    before = self._seen.get(key)
                    if before is not None and before[0] == mtime:
                        continue
                    names = {n for n in listdir(folder) if n.endswith(FINISHED)}
                    new = names - (before[1] if before else set())
                    out += [(f"{key}/{n}", False) for n in sorted(new)]
                    if TRACK_INFO in listdir(folder):
                        out.append((f"{key}/{TRACK_INFO}", True))
                    self._seen[key] = (mtime, names)
        return out
