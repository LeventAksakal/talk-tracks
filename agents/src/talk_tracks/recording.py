"""A recording of a room's agent tracks, lined up with the speaker's media time. Transport-free.

A recording is a directory::

    recording.json          the manifest (``Recording``): which agents, how many snapshots, the lecture file
    agents/<agent>.jsonl    one ``RecordedSnapshot`` per line, in media-time order
    lecture.mp4             the lecture media, when the recording was made from a file (``Recording.media``)

Media time is the speaker's clock, read from the teacher broadcast's audio track (the timestamp every audio object
carries), not wall time. Each snapshot is stamped with the newest teacher media time the recorder had seen when the
snapshot arrived, so the agents' processing delay is part of the recording and a replay shows each track exactly as
late as it was live. Snapshots that arrive before any teacher audio are stamped 0. Media times inside the states
(caption ``start_ms``/``end_ms``, slide ``at_ms``, chapter ``start_ms``) are on the same clock.

The JSON Schemas of both files are committed in ``contracts/`` (``recording.schema.json``,
``recorded-snapshot.schema.json``).
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Literal

from pydantic import Field

from .contracts import AgentInfo, Envelope, State, Usage, Wire

FORMAT = "talk-tracks-recording"
MANIFEST = "recording.json"
AGENTS_DIR = "agents"


class RecordedSnapshot(Wire):
    """One state change of one agent, as a line of ``agents/<agent>.jsonl``."""

    media_ms: int = Field(ge=0, description="Speaker media time when the snapshot arrived at the recorder")
    wall_ms: int = Field(ge=0, description="Wall-clock time when the snapshot arrived at the recorder")
    instance: str = Field(description="The agent instance that published it")
    seq: int = Field(ge=0, description="Its sequence number within that instance")
    usage: Usage = Field(description="The instance's cumulative model usage at that moment")
    state: State


class RecordedAgent(Wire):
    info: AgentInfo
    file: str = Field(description="Path of the agent's snapshot lines, relative to the recording directory")
    snapshots: int = Field(ge=0)
    first_media_ms: int = Field(ge=0)
    last_media_ms: int = Field(ge=0)


class Recording(Wire):
    """The manifest, ``recording.json``."""

    format: Literal["talk-tracks-recording"] = FORMAT
    v: Literal[1] = 1
    room: str = Field(description="The room it was recorded in")
    started_wall_ms: int = Field(ge=0)
    ended_wall_ms: int | None = Field(default=None, ge=0, description="Unset while recording")
    media: str | None = Field(
        default=None, description="The lecture file, relative to the recording directory; its time 0 is media time 0"
    )
    media_first_ms: int | None = Field(default=None, ge=0, description="First teacher media time seen")
    media_last_ms: int | None = Field(default=None, ge=0, description="Last teacher media time seen")
    agents: list[RecordedAgent] = Field(default_factory=list[RecordedAgent])


def agent_file(name: str) -> str:
    if not name or not all(c.isalnum() or c in "-_" for c in name):
        raise ValueError(f"agent name not usable as a file name: {name!r}")
    return f"{AGENTS_DIR}/{name}.jsonl"


class RecordingWriter:
    """Appends snapshots as they arrive. The manifest is rewritten when an agent first appears and on close, so a
    killed recorder still leaves a playable recording (only the manifest's counts are stale).

    Media time never goes backwards within an agent's lines: a snapshot stamped earlier than the one before it (the
    speaker's clock restarted) gets the previous stamp.
    """

    def __init__(self, directory: Path, room: str, *, wall_ms: int, media: str | None = None) -> None:
        self.directory = directory
        (directory / AGENTS_DIR).mkdir(parents=True, exist_ok=True)
        self._manifest = Recording(room=room, started_wall_ms=wall_ms, media=media)
        self._agents: dict[str, RecordedAgent] = {}
        for stale in (directory / AGENTS_DIR).glob("*.jsonl"):
            stale.unlink()
        self._write_manifest()

    @property
    def manifest(self) -> Recording:
        return self._manifest.model_copy(update={"agents": list(self._agents.values())})

    def media_seen(self, media_ms: int) -> None:
        first = self._manifest.media_first_ms
        self._manifest = self._manifest.model_copy(
            update={
                "media_first_ms": media_ms if first is None else min(first, media_ms),
                "media_last_ms": max(self._manifest.media_last_ms or 0, media_ms),
            }
        )

    def add(self, envelope: Envelope, *, media_ms: int, wall_ms: int) -> RecordedSnapshot:
        name = envelope.agent.name
        known = self._agents.get(name)
        if known is not None:
            media_ms = max(media_ms, known.last_media_ms)
        snapshot = RecordedSnapshot(
            media_ms=media_ms,
            wall_ms=wall_ms,
            instance=envelope.instance,
            seq=envelope.seq,
            usage=envelope.usage,
            state=envelope.state,
        )
        file = agent_file(name)
        with (self.directory / file).open("a", encoding="utf-8", newline="\n") as f:
            f.write(snapshot.model_dump_json() + "\n")
        self._agents[name] = RecordedAgent(
            info=envelope.agent,  # the newest label and model win
            file=file,
            snapshots=(known.snapshots if known else 0) + 1,
            first_media_ms=known.first_media_ms if known else media_ms,
            last_media_ms=media_ms,
        )
        if known is None or known.info != envelope.agent:
            self._write_manifest()
        return snapshot

    def close(self, *, wall_ms: int) -> Recording:
        self._manifest = self._manifest.model_copy(update={"ended_wall_ms": wall_ms})
        self._write_manifest()
        return self.manifest

    def _write_manifest(self) -> None:
        tmp = self.directory / (MANIFEST + ".tmp")
        tmp.write_text(self.manifest.model_dump_json(indent=2) + "\n", encoding="utf-8", newline="\n")
        tmp.replace(self.directory / MANIFEST)


def load_manifest(directory: Path) -> Recording:
    return Recording.model_validate_json((directory / MANIFEST).read_text(encoding="utf-8"))


def read_snapshots(directory: Path, agent: RecordedAgent) -> Iterator[RecordedSnapshot]:
    """An agent's snapshots in file order (media-time order), read lazily: a long lecture's captions are large."""
    with (directory / agent.file).open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                yield RecordedSnapshot.model_validate_json(line)


__all__ = [
    "FORMAT",
    "MANIFEST",
    "RecordedAgent",
    "RecordedSnapshot",
    "Recording",
    "RecordingWriter",
    "load_manifest",
    "read_snapshots",
]
