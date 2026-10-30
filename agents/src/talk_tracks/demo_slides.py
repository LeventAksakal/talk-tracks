"""A looped demo room's slides as the speaker's ``deck`` and ``slide`` tracks (decisions 0018 and 0022). Transport-free.

A recorded lecture has no speaker console, so the looper sends what one would: the slides ``slideshow.find_slides``
finds in the video become one deck, and each slide's first appearance a ``show`` record on the room clock. The
frames stay in memory, as for the describe agent (ticket 0001: the slides hold third-party images).

* **deck:** one group for the room's life, group ``DECK_GROUP`` (room slice 0, when a looped room's clock starts).
  Object 0 is the ``DeckInfo``, then one object per ``DeckImage``.
* **slide:** cut in 4 s slices like every sliced track. Object 0 of slice g is the carry-in, the last ``show`` before
  the slice (the previous loop's last slide at the start of a loop), then one object per ``show`` in the slice.
  Loop k plays slide i at room time ``k * period + at_ms``, so every group is a pure function of its number: the
  looper writes it live and answers a FETCH of it from the same function, byte for byte.

``with_slides`` adds the two tracks and the slides source to the room catalog. A return to an earlier slide is not
shown again (``find_slides`` drops it), and nothing is drawn: a recorded talk has no ink or laser.
"""

from __future__ import annotations

import base64
import functools
from collections.abc import Sequence
from dataclasses import dataclass, replace

from .contracts import (
    DECK_TRACK,
    SLICE_MS,
    SLIDE_TRACK,
    CurrentSlideRecord,
    DeckImage,
    DeckInfo,
    DeckRecord,
    ShowSlide,
    Source,
    slides_path,
)
from .records import encode
from .room_catalog import RoomCatalog, speaker_sources, speaker_tracks
from .slicing import Placed
from .slideshow import Slide

DECK_GROUP = 0
TRACKS = (DECK_TRACK, SLIDE_TRACK)  # what a looped room sends of the speaker's slides tracks


def jpeg_size(data: bytes) -> tuple[int, int]:
    """(width, height) of a JPEG, from its start-of-frame segment."""
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            raise ValueError("not a JPEG segment")
        marker = data[i + 1]
        if marker == 0xFF:  # fill byte
            i += 1
            continue
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        length = int.from_bytes(data[i + 2 : i + 4])
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            return int.from_bytes(data[i + 7 : i + 9]), int.from_bytes(data[i + 5 : i + 7])
        i += 2 + length
    raise ValueError("no JPEG start of frame")


@dataclass(frozen=True)
class LectureSlides:
    """The slides of one loop (lecture time) and the loop's period on the room clock (a whole number of slices)."""

    slides: tuple[Slide, ...]
    period_ms: int

    def __post_init__(self) -> None:
        if not self.slides:
            raise ValueError("a deck needs at least one slide")
        if self.period_ms <= 0 or self.period_ms % SLICE_MS:
            raise ValueError("the period is whole slices")

    @classmethod
    def of(cls, slides: Sequence[Slide], period_ms: int) -> LectureSlides:
        return cls(tuple(sorted(slides, key=lambda s: s.at_ms)), period_ms)

    @functools.cached_property
    def deck(self) -> tuple[Placed, ...]:
        """Every object of the deck group, in object order (built once: a FETCH of the deck reads it again)."""
        width, height = jpeg_size(self.slides[0].jpeg)
        info = DeckInfo(count=len(self.slides), aspect=round(width / height, 4))
        out = [Placed(0, encode([DeckRecord(m=0, data=info)]))]
        for i, slide in enumerate(self.slides):
            w, h = jpeg_size(slide.jpeg)
            image = DeckImage(
                index=i, mime="image/jpeg", width=w, height=h, data_b64=base64.b64encode(slide.jpeg).decode()
            )
            out.append(Placed(0, encode([DeckRecord(m=0, data=image)])))
        return tuple(out)

    def deck_group(self, group: int) -> tuple[Placed, ...]:
        return self.deck if group == DECK_GROUP else ()

    def _show(self, loop: int, index: int) -> CurrentSlideRecord:
        m = loop * self.period_ms + self.slides[index].at_ms
        return CurrentSlideRecord(m=m, data=ShowSlide(deck=DECK_GROUP, index=index))

    def carry(self, start_ms: int) -> list[CurrentSlideRecord]:
        """The last ``show`` before room time ``start_ms``: the slide on screen then (none before the first)."""
        loop, offset = divmod(start_ms, self.period_ms)
        shown = [i for i, s in enumerate(self.slides) if s.at_ms < offset]
        if shown:
            return [self._show(loop, shown[-1])]
        return [self._show(loop - 1, len(self.slides) - 1)] if loop > 0 else []

    def slide_group(self, group: int) -> tuple[Placed, ...]:
        """Every object of group ``group`` of the slide track: the carry-in, then each slide shown in the slice."""
        if group < 0:
            return ()
        start = group * SLICE_MS
        loop, offset = divmod(start, self.period_ms)  # a slice never straddles two loops
        out = [Placed(start, encode(self.carry(start)))]
        for i, slide in enumerate(self.slides):
            if offset <= slide.at_ms < offset + SLICE_MS:
                record = self._show(loop, i)
                out.append(Placed(record.m, encode([record])))
        return tuple(out)


def with_slides(catalog: RoomCatalog, room: str) -> RoomCatalog:
    """A looped room's catalog with its deck and slide tracks, and the slides among the speaker's sources."""
    tracks = tuple(t for t in speaker_tracks(room) if t.name in TRACKS)
    slides = Source(kind="slides", namespace=slides_path(room), tracks=list(TRACKS))
    sources = (*speaker_sources(room, audio=True, camera=True), slides)
    return replace(catalog, tracks=(*catalog.tracks, *tracks), sources=sources)
