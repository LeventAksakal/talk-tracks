"""Slide description core: one note per slide frame."""

from __future__ import annotations

import hashlib

from talk_tracks.contracts import SlideFrame, SlideNote, SlidesState

KEEP = 60


class SlidesCore:
    def __init__(self, lang: str) -> None:
        self._lang = lang
        self._notes: dict[int, SlideNote] = {}
        self._asked: set[int] = set()
        self._by_image: dict[str, str] = {}

    def wants(self, frame: SlideFrame) -> bool:
        """True once per frame id: a repeated frame (a heartbeat, a resubscribe) costs nothing."""
        if frame.id in self._asked:
            return False
        self._asked.add(frame.id)
        return True

    def known(self, frame: SlideFrame) -> str | None:
        """The description of an identical image seen before (the speaker went back a slide, a looped talk)."""
        return self._by_image.get(_digest(frame))

    def add(self, frame: SlideFrame, description: str) -> None:
        self._by_image[_digest(frame)] = description
        self._notes[frame.id] = SlideNote(id=frame.id, at_ms=frame.at_ms, description=description)
        for old in sorted(self._notes)[:-KEEP]:
            del self._notes[old]

    def state(self) -> SlidesState:
        return SlidesState(lang=self._lang, slides=[self._notes[i] for i in sorted(self._notes)])


def _digest(frame: SlideFrame) -> str:
    return hashlib.sha256(frame.data_b64.encode()).hexdigest()
