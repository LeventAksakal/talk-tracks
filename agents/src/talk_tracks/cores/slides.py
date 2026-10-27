"""Slide description core: one note per slide frame."""

from __future__ import annotations

from talk_tracks.contracts import SlideFrame, SlideNote, SlidesState

KEEP = 60


class SlidesCore:
    def __init__(self, lang: str) -> None:
        self._lang = lang
        self._notes: dict[int, SlideNote] = {}
        self._asked: set[int] = set()

    def wants(self, frame: SlideFrame) -> bool:
        """True once per frame id: a repeated frame (a heartbeat, a resubscribe) costs nothing."""
        if frame.id in self._asked:
            return False
        self._asked.add(frame.id)
        return True

    def add(self, frame: SlideFrame, description: str) -> None:
        self._notes[frame.id] = SlideNote(id=frame.id, at_ms=frame.at_ms, description=description)
        for old in sorted(self._notes)[:-KEEP]:
            del self._notes[old]

    def state(self) -> SlidesState:
        return SlidesState(lang=self._lang, slides=[self._notes[i] for i in sorted(self._notes)])
