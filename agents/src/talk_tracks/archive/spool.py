"""Agents record their own output: a spool of envelopes on the shared disk, which the archiver reads. Transport-free.

The archiver must not subscribe to agent tracks: a subscription is demand, and a lazy agent (decision 0010) would
never go idle. So each agent writes every envelope it publishes to its own spool file as well, and the archiver
tails the spool and archives the snapshots, stamped with the teacher media time when it reads them (as it did when
it read them off the relay).

* Agent side: ``spool_sink(sink, room)`` wraps the ``ObjectSink`` a ``SnapshotPublisher`` writes to. The agent's
  publish path changes by one call; publishing never fails because of the spool (an error is logged once).
* Archiver side: ``SpoolReader.poll()`` returns the new envelopes of every file, newest instance per agent, each
  state change once (heartbeats repeat a seq and are dropped).

Layout: ``<spool>/<room>/<agent>/<instance>.jsonl``, one envelope (``contracts/envelope.schema.json``) per line. One
process owns each file, so writers never contend. The spool is ``TT_ARCHIVE_SPOOL``, by default ``archive-spool/``
beside the agents' state folder (``/data/archive-spool`` on the VM). The archiver keeps its read offsets in
``<spool>/offsets.json`` and removes a replaced instance's file once it is read and has been quiet for a while.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from pydantic import ValidationError

from ..contracts import Envelope, agent_path, parse_room
from ..follow import NewestInstance, SnapshotFilter
from ..publisher import ObjectSink

log = logging.getLogger("talk_tracks.archive.spool")

OFFSETS = "offsets.json"
STALE_S = 120.0  # a replaced instance's file is removed this long after its last line


def spool_dir(state_dir: Path | None = None) -> Path:
    configured = os.environ.get("TT_ARCHIVE_SPOOL")
    if configured:
        return Path(configured)
    state = state_dir or Path(os.environ.get("TT_STATE_DIR", "data/state"))
    return state.parent / "archive-spool"


def spool_file(root: Path, room: str, agent: str, instance: str) -> Path:
    agent_path(room, agent, instance)  # the same names as on the relay
    if not all(part and all(c.isalnum() or c in "-_" for c in part) for part in (room, agent, instance)):
        raise ValueError(f"not usable as spool names: {room!r}, {agent!r}, {instance!r}")
    return root / room / agent / f"{instance}.jsonl"


class SpoolSink:
    """An ``ObjectSink`` that writes each envelope to the agent's spool file, then publishes it."""

    def __init__(self, sink: ObjectSink, room: str, root: Path) -> None:
        self._sink, self._room, self._root = sink, room, root
        self._file: BinaryIO | None = None
        self._failed = False

    def __getattr__(self, name: str) -> object:
        return getattr(self._sink, name)  # anything else the publish path asks of its sink (``subscribed``)

    def close(self) -> None:
        if self._file is not None:
            self._file.close()
            self._file = None

    async def write(self, data: bytes) -> None:
        self._record(data)
        await self._sink.write(data)

    def _record(self, data: bytes) -> None:
        if self._failed:
            return
        try:
            if self._file is None:
                envelope = Envelope.model_validate_json(data)
                path = spool_file(self._root, self._room, envelope.agent.name, envelope.instance)
                path.parent.mkdir(parents=True, exist_ok=True)
                self._file = path.open("ab")
            self._file.write(data.rstrip(b"\n") + b"\n")
            self._file.flush()
        except (OSError, ValueError) as exc:
            self._failed = True
            log.warning("not recording this track for the archive: %s", exc)


def spool_sink(sink: ObjectSink, room: str, root: Path | None = None) -> ObjectSink:
    """The agents' hook: ``SnapshotPublisher(info, spool_sink(sink, room), ...)``. ``TT_ARCHIVE_SPOOL=off`` disables
    it."""
    if os.environ.get("TT_ARCHIVE_SPOOL", "").lower() == "off":
        return sink
    return SpoolSink(sink, room, root or spool_dir())


# --- the archiver's side -------------------------------------------------------------------------------------------


@dataclass
class _Agent:
    newest: NewestInstance
    filter: SnapshotFilter


class SpoolReader:
    def __init__(self, root: Path, *, clock_s: float | None = None) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self._offsets: dict[str, int] = {}
        self._agents: dict[tuple[str, str], _Agent] = {}
        self._dirty = False
        try:
            loaded = json.loads((root / OFFSETS).read_text(encoding="utf-8"))
            self._offsets = {str(k): int(v) for k, v in loaded.items()}
        except (OSError, ValueError, AttributeError):
            pass

    def poll(self, *, now_s: float | None = None) -> list[tuple[str, Envelope]]:
        """(room, envelope) for every new state change since the last poll, in file order per instance."""
        now = time.time() if now_s is None else now_s
        out: list[tuple[str, Envelope]] = []
        files = sorted(self.root.glob("*/*/*.jsonl"), key=lambda p: (p.parent.parent.name, p.parent.name, _num(p.stem)))
        found: list[tuple[Path, str, str, _Agent]] = []
        for path in files:  # every instance first, so a replaced one's late lines are not taken
            room, agent, instance = path.parent.parent.name, path.parent.name, path.stem
            try:
                parse_room(room)
            except ValueError:
                continue
            state = self._agents.setdefault((room, agent), _Agent(NewestInstance(), SnapshotFilter()))
            state.newest.offer(instance)
            found.append((path, room, instance, state))
        for path, room, instance, state in found:
            key = path.relative_to(self.root).as_posix()
            out += [(room, e) for e in self._read(path, key, state)]
            if instance != state.newest.current and self._quiet(path, key, now):
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    continue  # still open by a process that has not exited: next time
                self._offsets.pop(key, None)
                self._dirty = True
        return out

    def _read(self, path: Path, key: str, state: _Agent) -> list[Envelope]:
        offset = self._offsets.get(key, 0)
        try:
            with path.open("rb") as f:
                f.seek(offset)
                data = f.read()
        except OSError:
            return []
        end = data.rfind(b"\n") + 1  # a line still being written waits for the next poll
        if end == 0:
            return []
        self._offsets[key] = offset + end
        self._dirty = True
        out: list[Envelope] = []
        for line in data[:end].splitlines():
            if not line.strip():
                continue
            try:
                envelope = state.filter.accept(line, state.newest.current)
            except ValidationError:
                log.warning("skipping a spool line in %s that does not match the contract", key)
                continue
            if envelope is not None:
                out.append(envelope)
        return out

    def _quiet(self, path: Path, key: str, now: float) -> bool:
        try:
            stat = path.stat()
        except OSError:
            return False
        return self._offsets.get(key, 0) >= stat.st_size and now - stat.st_mtime > STALE_S

    def save(self) -> None:
        if self._dirty:
            tmp = self.root / (OFFSETS + ".tmp")
            tmp.write_text(json.dumps(self._offsets), encoding="utf-8")
            os.replace(tmp, self.root / OFFSETS)
            self._dirty = False


def _num(stem: str) -> int:
    return int(stem) if stem.isdigit() else -1
