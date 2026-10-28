# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportAttributeAccessIssue=false
"""Slide changes in a lecture video, for the describe agent when a demo room is generated from a recorded talk.

A recorded talk has no speaker console sending slide frames, so ``play --slides`` finds them in the video: one JPEG
per slide, at the media time it appeared, cropped to the slide area. Only keyframes are decoded (every 2 s in a
prepared lecture). A screen counts once it is *still* (the next keyframe looks the same), so transitions and video
clips are skipped. A still screen that only adds to the current slide (its content stays, empty space fills) is a
build, a bullet or a picture revealed: the slide keeps its first time but takes the new image, so each slide is
described once, as it looks when complete. One that changes the slide's content is a new slide, unless its content
matches a slide shown before (the speaker zoomed out again or went back): that one is not sent twice.

Transport-free (PyAV and NumPy); ``demo`` publishes the result on ``talk/<room>/slides``. The frames live in memory
for the run only: nothing is written to disk.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

import av
import numpy as np
from numpy.typing import NDArray

THUMB_W, THUMB_H = 160, 90  # grey thumbnail the comparison runs on
GRID_W, GRID_H = 16, 9  # cells of the thumbnail (10 x 10 pixels each)
CELL_DIFF = 6.0  # mean absolute difference (0-255) above which a cell has changed
STILL = 0.02  # at most this share of cells may change between two keyframes of a still screen
CONTENT_STD = 8.0  # a cell with this much detail (std dev, 0-255) shows content: text, a chart, a picture
KEPT = 0.1  # a build changes at most this share of the slide's content cells; a new slide replaces them
SAME = 0.05  # at most this share of either screen's content cells differs from an earlier slide: a return to it
JPEG_MAX_W = 1280


@dataclass(frozen=True)
class Crop:
    """The slide area, as fractions of the frame."""

    x: float = 0.0
    y: float = 0.0
    w: float = 1.0
    h: float = 1.0

    @classmethod
    def parse(cls, text: str) -> Crop:
        """``full`` or ``x,y,w,h`` in fractions of the frame, for example ``0,0,0.77,0.77``."""
        if text == "full":
            return cls()
        x, y, w, h = (float(v) for v in text.split(","))
        if not (0 <= x < 1 and 0 <= y < 1 and 0 < w <= 1 - x + 1e-9 and 0 < h <= 1 - y + 1e-9):
            raise ValueError(f"crop {text!r} must lie inside the frame")
        return cls(x, y, w, h)

    def box(self, width: int, height: int) -> tuple[int, int, int, int]:
        """Pixel box (x0, y0, x1, y1), with even sides for the JPEG encoder."""
        x0, y0 = int(self.x * width), int(self.y * height)
        x1 = x0 + (int(self.w * width) // 2) * 2
        y1 = y0 + (int(self.h * height) // 2) * 2
        return x0, y0, min(x1, width), min(y1, height)


@dataclass(frozen=True)
class Slide:
    at_ms: int  # lecture time when the slide appeared
    jpeg: bytes  # the slide as it looks after its last build


@dataclass
class _Screen:
    at_ms: int
    thumb: NDArray[np.float32]
    rgb: NDArray[np.uint8]


def _cells(thumb: NDArray[np.float32]) -> NDArray[np.float32]:
    return thumb.reshape(GRID_H, THUMB_H // GRID_H, GRID_W, THUMB_W // GRID_W).swapaxes(1, 2)


def _changed_cells(a: NDArray[np.float32], b: NDArray[np.float32]) -> NDArray[np.bool_]:
    return np.abs(_cells(a) - _cells(b)).mean(axis=(2, 3)) > CELL_DIFF


def changed(a: NDArray[np.float32], b: NDArray[np.float32]) -> float:
    """Share of grid cells whose mean absolute difference passes ``CELL_DIFF``."""
    return float(_changed_cells(a, b).mean())


def _content(thumb: NDArray[np.float32]) -> NDArray[np.bool_]:
    return _cells(thumb).std(axis=(2, 3)) > CONTENT_STD


def added(old: NDArray[np.float32], new: NDArray[np.float32]) -> bool:
    """True when ``new`` keeps what ``old`` showed and only fills empty space: a build of the same slide."""
    content = _content(old)
    if not content.any():
        return True
    return float(_changed_cells(old, new)[content].mean()) <= KEPT


def same(a: NDArray[np.float32], b: NDArray[np.float32]) -> bool:
    """True when ``a`` and ``b`` show the same content (two title slides of one template do not)."""
    content = _content(a) | _content(b)
    if not content.any():
        return changed(a, b) <= STILL
    return float(_changed_cells(a, b)[content].mean()) <= SAME


def _thumb(rgb: NDArray[np.uint8]) -> NDArray[np.float32]:
    grey = rgb.astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    h, w = grey.shape
    rows = (np.arange(THUMB_H + 1) * h) // THUMB_H
    cols = (np.arange(THUMB_W + 1) * w) // THUMB_W
    sums = np.add.reduceat(np.add.reduceat(grey, rows[:-1], axis=0), cols[:-1], axis=1)
    counts = np.outer(np.diff(rows), np.diff(cols))
    return (sums / counts).astype(np.float32)


def _screens(path: Path, crop: Crop) -> Iterator[_Screen]:
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        stream.codec_context.skip_frame = "NONKEY"
        for frame in container.decode(stream):
            if frame.pts is None:
                continue
            full = frame.to_ndarray(format="rgb24").astype(np.uint8, copy=False)
            x0, y0, x1, y1 = crop.box(full.shape[1], full.shape[0])
            rgb = np.ascontiguousarray(full[y0:y1, x0:x1])
            yield _Screen(int(frame.pts * frame.time_base * 1000), _thumb(rgb), rgb)


def jpeg(rgb: NDArray[np.uint8]) -> bytes:
    frame = av.VideoFrame.from_ndarray(rgb, format="rgb24")
    h, w = rgb.shape[:2]
    if w > JPEG_MAX_W:
        w, h = JPEG_MAX_W, (h * JPEG_MAX_W // w) // 2 * 2
    codec = av.CodecContext.create("mjpeg", "w")
    codec.width, codec.height, codec.pix_fmt = w, h, "yuvj420p"
    codec.time_base = Fraction(1, 25)
    codec.qscale = True  # fixed quality: sharp text, not a bitrate target
    out = frame.reformat(width=w, height=h, format="yuvj420p")
    packets = [*codec.encode(out), *codec.encode(None)]
    return b"".join(bytes(p) for p in packets)


def find_slides(path: Path, crop: Crop | None = None) -> list[Slide]:
    """The lecture's slides in order, builds collapsed (see the module doc). ``crop``: the slide area (default the
    whole frame)."""
    crop = crop or Crop()
    slides: list[Slide] = []
    seen: list[NDArray[np.float32]] = []  # every slide's first and last look, to spot a return to one
    current: _Current | None = None
    previous: _Screen | None = None

    def close(slide: _Current) -> None:
        seen.append(slide.screen.thumb)
        if slide.new:
            slides.append(Slide(slide.at_ms, jpeg(slide.screen.rgb)))

    for screen in _screens(path, crop):
        if previous is not None and changed(previous.thumb, screen.thumb) <= STILL:
            if current is None:
                current = _Current(previous.at_ms, previous, new=True)
                seen.append(previous.thumb)
            elif changed(current.screen.thumb, previous.thumb) <= STILL:
                pass  # the same screen
            elif added(current.screen.thumb, previous.thumb):
                current.screen = previous  # a build: same slide, fuller image
            else:
                close(current)
                back = any(same(thumb, previous.thumb) for thumb in seen)
                current = _Current(previous.at_ms, previous, new=not back)  # back: a zoom ended, a slide revisited
                seen.append(previous.thumb)
        previous = screen
    if current is not None:
        close(current)
    return slides


@dataclass
class _Current:
    at_ms: int
    screen: _Screen  # its latest still look, encoded once the slide is over
    new: bool
