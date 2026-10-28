"""Slide description core: one note per slide frame, published as an item; the slide on screen is the carry-in."""

from __future__ import annotations

import hashlib

from talk_tracks.contracts import SlideFrame, SlideItem, SlideNote, SlidesCarry, SlidesState

KEEP = 60


class SlidesCore:
    def __init__(self, lang: str) -> None:
        self._lang = lang
        self._notes: dict[int, SlideNote] = {}
        self._asked: set[int] = set()
        self._by_image: dict[str, str] = {}

    @property
    def lang(self) -> str:
        return self._lang

    def wants(self, frame: SlideFrame) -> bool:
        """True once per frame id: a repeated frame (a heartbeat, a resubscribe) costs nothing."""
        if frame.id in self._asked:
            return False
        self._asked.add(frame.id)
        return True

    def known(self, frame: SlideFrame) -> str | None:
        """The description of an identical image seen before (the speaker went back a slide, a looped talk)."""
        return self._by_image.get(_digest(frame))

    def add(self, frame: SlideFrame, description: str) -> SlideItem:
        self._by_image[_digest(frame)] = description
        note = SlideNote(id=frame.id, at_ms=frame.at_ms, description=description)
        self._notes[frame.id] = note
        for old in sorted(self._notes)[:-KEEP]:
            del self._notes[old]
        return SlideItem(lang=self._lang, slide=note)

    def seed(self, notes: list[SlideNote]) -> None:
        """A predecessor's slides (its newest slice): known again, so they are not described twice."""
        for note in notes:
            self._notes[note.id] = note
            self._asked.add(note.id)

    def carry(self) -> SlidesCarry:
        on_screen = max(self._notes.values(), key=lambda n: (n.at_ms, n.id), default=None)
        return SlidesCarry(lang=self._lang, slide=on_screen)

    def state(self) -> SlidesState:
        return SlidesState(lang=self._lang, slides=[self._notes[i] for i in sorted(self._notes)])


def _digest(frame: SlideFrame) -> str:
    return hashlib.sha256(frame.data_b64.encode()).hexdigest()
