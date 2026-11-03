"""Targeted fixes to a finished recording, kept beside it so the recording itself is never rewritten.

* ``redescribe``: the slides the recording has no description for, found again in the lecture (the same slide ids
  ``generate`` sent, with the same crop) and described once each. Saved as ``agents/<agent>.patch.json`` and merged
  by ``with_slide_notes`` as if the agent had answered ``NOTE_DELAY_MS`` after the slide appeared.

``repunctuate`` (``repunctuate.py``) adds punctuation to the caption lines; ``read_recording`` merges it, so every
fix here and a session see the punctuated lines.

``redescribe`` spends through the ledger of a room, so a cap batch scopes it. The slide frames stay in memory.
Recorded translations are no longer replayed (decision 0035: every language is made on demand), so the
``retranslate`` and ``resplit`` fixes for them are gone.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from pathlib import Path
from typing import Protocol

from .contracts import AgentInfo, SlideNote, SlidesState, Usage, Wire
from .recording import RecordedSnapshot, load_manifest, read_snapshots
from .repunctuate import with_punctuation
from .resegment import Recorded
from .slideshow import Crop, find_slides

log = logging.getLogger("talk_tracks.revise")

NOTE_DELAY_MS = 4000  # a re-described slide's note goes out this long after the slide, about what live took


class SlidePatch(Wire):
    lang: str
    model: str
    usage: Usage
    notes: list[SlideNote]


def patch_path(recording: Path, agent: str) -> Path:
    return recording / "agents" / f"{agent}.patch.json"


class SlideDescriber(Protocol):
    @property
    def model(self) -> str: ...

    @property
    def usage(self) -> Usage: ...

    async def describe_slide(self, image: bytes, mime: str, *, lang: str) -> str: ...


def read_recording(recording: Path) -> list[tuple[AgentInfo, list[RecordedSnapshot]]]:
    """The recording's tracks, with the caption punctuation ``repunctuate`` saved merged in."""
    raw = [(agent.info, list(read_snapshots(recording, agent))) for agent in load_manifest(recording).agents]
    return with_punctuation(recording, raw)


def described(snapshots: Sequence[RecordedSnapshot]) -> set[int]:
    found: set[int] = set()
    for snap in snapshots:
        if isinstance(snap.state, SlidesState):
            found |= {note.id for note in snap.state.slides if note.description.strip()}
    return found


async def redescribe(
    recording: Path, media: Path, crop: Crop, describer: SlideDescriber, *, agent: str = "describe"
) -> SlidePatch:
    """Describe the slides of ``media`` that ``agent`` left without a note, and save them as a patch."""
    recorded = read_recording(recording)
    snapshots = next((s for info, s in recorded if info.name == agent), None)
    if snapshots is None:
        raise SystemExit(f"the recording has no {agent} track")
    first = snapshots[0].state
    assert isinstance(first, SlidesState)
    slides = find_slides(media, crop)
    have = described(snapshots)
    missing = [i for i in range(len(slides)) if i not in have]
    log.info("%d slides, %d described, missing %s", len(slides), len(have), missing)
    notes: list[SlideNote] = []
    for i in missing:
        text = await describer.describe_slide(slides[i].jpeg, "image/jpeg", lang=first.lang)
        notes.append(SlideNote(id=i, at_ms=slides[i].at_ms, description=text))
        log.info("slide %d at %.1f s described (%s so far)", i, slides[i].at_ms / 1000, describer.usage.cost_usd)
    patch = SlidePatch(lang=first.lang, model=describer.model, usage=describer.usage, notes=notes)
    patch_path(recording, agent).write_text(patch.model_dump_json(indent=1), encoding="utf-8")
    return patch


def with_slide_notes(
    snapshots: Sequence[RecordedSnapshot], notes: Sequence[SlideNote], *, delay_ms: int = NOTE_DELAY_MS
) -> list[RecordedSnapshot]:
    """The slides track as if each patched note had arrived ``delay_ms`` after its slide (a demo session passes the
    describe agent's measured delay, ``session.describe_delay_ms``): one snapshot more per note, and the note in
    every later state."""
    out: list[RecordedSnapshot] = []
    pending = sorted(notes, key=lambda n: n.at_ms)
    added: list[SlideNote] = []

    def merged(state: SlidesState) -> SlidesState:
        slides = {s.id: s for s in state.slides} | {n.id: n for n in added}
        return state.model_copy(update={"slides": [slides[i] for i in sorted(slides)]})

    for snap in snapshots:
        state = snap.state
        assert isinstance(state, SlidesState)
        while pending and pending[0].at_ms + delay_ms <= snap.media_ms:
            note = pending.pop(0)
            added.append(note)
            prior = out[-1] if out else snap
            assert isinstance(prior.state, SlidesState)
            at = note.at_ms + delay_ms
            out.append(prior.model_copy(update={"media_ms": at, "state": merged(prior.state)}))
        out.append(snap.model_copy(update={"state": merged(state)}))
    for note in pending:  # after the last recorded snapshot
        added.append(note)
        last = out[-1]
        assert isinstance(last.state, SlidesState)
        out.append(last.model_copy(update={"media_ms": note.at_ms + delay_ms, "state": merged(last.state)}))
    return out


def with_patches(
    recording: Path, recorded: Recorded, *, delay_ms: int = NOTE_DELAY_MS
) -> list[tuple[AgentInfo, list[RecordedSnapshot]]]:
    """The recording with any saved slide patch merged in, each note ``delay_ms`` after its slide."""
    out: list[tuple[AgentInfo, list[RecordedSnapshot]]] = []
    for info, snapshots in recorded:
        path = patch_path(recording, info.name)
        if path.exists() and snapshots and isinstance(snapshots[0].state, SlidesState):
            patch = SlidePatch.model_validate_json(path.read_text(encoding="utf-8"))
            log.info("%s: %d notes from %s", info.name, len(patch.notes), path.name)
            out.append((info, with_slide_notes(snapshots, patch.notes, delay_ms=delay_ms)))
        else:
            out.append((info, list(snapshots)))
    return out
