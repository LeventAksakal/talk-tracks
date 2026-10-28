"""Slide description core: one record per slide frame; the slide on screen is the carry-in."""

from __future__ import annotations

import hashlib

from talk_tracks.contracts import Slide, SlideFrame

KEEP = 60


class SlidesCore:
    def __init__(self, lang: str) -> None:
        self._lang = lang
        self._slides: dict[int, Slide] = {}
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

    def add(self, frame: SlideFrame, at_ms: int, description: str) -> Slide:
        """``at_ms``: when the slide appeared, in room time."""
        self._by_image[_digest(frame)] = description
        slide = Slide(id=frame.id, at=at_ms, text=description)
        self._slides[frame.id] = slide
        for old in sorted(self._slides)[:-KEEP]:
            del self._slides[old]
        return slide

    def seed(self, slides: list[Slide]) -> None:
        """A predecessor's slides (its newest slice): known again, so they are not described twice."""
        for slide in slides:
            self._slides[slide.id] = slide
            self._asked.add(slide.id)

    def carry(self) -> list[Slide]:
        on_screen = max(self._slides.values(), key=lambda s: (s.at, s.id), default=None)
        return [] if on_screen is None else [on_screen]


def _digest(frame: SlideFrame) -> str:
    return hashlib.sha256(frame.data_b64.encode()).hexdigest()
