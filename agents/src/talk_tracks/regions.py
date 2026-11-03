# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportAttributeAccessIssue=false
"""Where the slides and the speaker's webcam sit in a conference recording's frame (``find-regions``). Offline, free.

A demo lecture's video is one composed frame: the slides as the main area and the speaker's webcam as a small
picture-in-picture inset, over a static backdrop with a logo. The player shows the slides whole in the main area and
only the inset in the camera tile, so it needs both rectangles. ``find_regions`` measures them from the video, and
``regions.json`` beside ``lecture.mp4`` keeps them for ``session``, ``serve-recording`` and ``record-archive``, which
put them in the room catalog (``tt.regions``) and cut the deck's slides from the slide region.

How they are found, on the keyframes (every 2 s in a prepared lecture), shrunk to ``ANALYSIS_W`` wide and grey:

* **Off-layout frames** (a cut to the stage camera, a full-frame clip) differ from the lecture's median frame almost
  everywhere; they are left out.
* **The webcam** is where the picture changes between nearly every two keyframes: the speaker moves. The largest such
  patch, no bigger than ``CAMERA_MAX_AREA`` of the frame, seeds it; each side then moves out to the inset's border, a
  straight edge that persists in most frames with static backdrop beyond it. Found per stretch of the lecture: when
  the inset moves, each stretch's rectangle is kept (``camera_spans``) and ``camera`` is their union, so the tile
  never cuts the speaker.
* **The slides** are the largest stable rectangle: the extent of everything that ever changed outside the webcam
  (the slides' content over the whole lecture) grown out to the slide image's border, a persistent straight edge,
  and trimmed of flat dark bars (a 4:3 slide letterboxed in a 16:9 area). With no border in reach, the content
  extent itself, rounded outwards, so nothing is cut.
* Each side found on an edge is placed on it to the pixel on full-size frames, then moved ``SAFE_PX`` inside, so no
  sliver of border shows.

``contact_sheet`` draws a check image: sample frames with both rectangles outlined and the webcam crop beside them,
then every slide the deck would have, cut from the found slide region, each outlined so a stray border or a cut
shows. It holds the lecture's slides (third-party images, ticket 0001): it is for checking by eye on the machine that
has the lecture, never committed, served or kept.
"""

from __future__ import annotations

import io
import json
import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import av
import numpy as np
from numpy.typing import NDArray

from .contracts import Regions
from .slideshow import Crop, Slide

log = logging.getLogger("talk_tracks.regions")

FILE = "regions.json"
FORMAT = "talk-tracks-regions"
ANALYSIS_W = 480  # analysis width in pixels (a 1080p frame: 4 x 4 pixels each)
CELL = 6  # analysis pixels per side of a grid cell
OFF_LAYOUT = 0.75  # a frame differing from the median in this share of pixels is not the layout
DIFF = 10  # grey levels: a pixel that changed between two keyframes
EDGE = 12  # grey levels between neighbours: an edge
PERSIST = 0.4  # an edge in this share of frames persists
SUPPORT = 0.5  # a side's line is an edge along this share of its length
RIDGE = 0.3  # and along this much more of it than the lines a few pixels either side
BUSY = 0.25  # a webcam cell changes between this share of keyframe pairs, at least
CONTENT = 25  # grey levels between a pixel's 5th and 95th percentile over the lecture: content came and went there
STATIC = 12  # the same range, at most, beyond a border: static backdrop
CAMERA_MIN_AREA, CAMERA_MAX_AREA = 0.003, 0.3  # of the frame
DARK, FLAT = 40, 5  # a letterbox bar: darker than this, and flatter (std dev) along and across frames
SAFE_PX = 2  # full-size pixels inside a found edge
WINDOWS = 6  # the webcam is found in this many stretches of the lecture, to see it move
MIN_WINDOW = 20  # keyframes, at least, per stretch
SAME_PLACE = 0.6  # two stretches' webcams overlapping this much (intersection over union) are one place
FULL_KEPT = 12  # full-size frames read again, to place the edges to the pixel and draw the sheet

Box = tuple[int, int, int, int]  # x0, y0, x1, y1 in pixels, x1 and y1 exclusive
Side = Literal["left", "top", "right", "bottom"]
SIDES: tuple[Side, ...] = ("left", "top", "right", "bottom")


@dataclass(frozen=True)
class CameraSpan:
    """Where the webcam sat from lecture ms ``from_ms`` to ``to_ms``."""

    from_ms: int
    to_ms: int
    camera: Crop


@dataclass(frozen=True)
class LectureRegions:
    """What ``regions.json`` holds: the slide region and the webcam region of a lecture's frame, in fractions."""

    slides: Crop
    camera: Crop | None
    frame: tuple[int, int] = (0, 0)  # the video's width and height
    camera_spans: tuple[CameraSpan, ...] = ()  # only when the inset moves; ``camera`` is then their union
    found: dict[str, object] = field(default_factory=dict[str, object])  # how they were found, for the reader

    def wire(self) -> Regions:
        """The regions as the room catalog carries them (``tt.regions``)."""
        return Regions(slides=_list(self.slides), camera=_list(self.camera) if self.camera else None)

    def to_json(self) -> dict[str, object]:
        doc: dict[str, object] = {
            "format": FORMAT,
            "v": 1,
            "frame": list(self.frame),
            "slides": _list(self.slides),
            "camera": _list(self.camera) if self.camera else None,
        }
        if self.camera_spans:
            doc["camera_spans"] = [
                {"from_ms": s.from_ms, "to_ms": s.to_ms, "camera": _list(s.camera)} for s in self.camera_spans
            ]
        if self.found:
            doc["found"] = self.found
        return doc

    @classmethod
    def from_json(cls, doc: dict[str, object]) -> LectureRegions:
        if doc.get("format") != FORMAT:
            raise ValueError(f"not a {FORMAT} file")
        camera = doc.get("camera")
        spans = doc.get("camera_spans") or []
        frame = doc.get("frame") or (0, 0)
        assert isinstance(spans, list) and isinstance(frame, list | tuple)
        return cls(
            slides=_crop(doc["slides"]),
            camera=_crop(camera) if camera is not None else None,
            frame=(int(frame[0]), int(frame[1])),
            camera_spans=tuple(
                CameraSpan(int(s["from_ms"]), int(s["to_ms"]), _crop(s["camera"])) for s in spans if isinstance(s, dict)
            ),
        )

    def write(self, path: Path) -> None:
        path.write_text(json.dumps(self.to_json(), indent=2) + "\n", encoding="utf-8")


def _list(crop: Crop) -> list[float]:
    return [round(v, 5) for v in (crop.x, crop.y, crop.w, crop.h)]


def _crop(value: object) -> Crop:
    if not isinstance(value, list | tuple) or len(value) != 4:
        raise ValueError(f"a region is [x, y, w, h], not {value!r}")
    return Crop.parse(",".join(str(float(v)) for v in value))


def beside(media: Path) -> Path:
    return media.parent / FILE


def load(path: Path) -> LectureRegions | None:
    """The regions in ``path`` (a ``regions.json``), None when there is none."""
    if not path.is_file():
        return None
    return LectureRegions.from_json(json.loads(path.read_text(encoding="utf-8")))


AUTO = "auto"
SlidesSpec = Crop | Literal["auto"] | None


def slides_spec(text: str | None) -> SlidesSpec:
    """``--slides``: None (no slides), ``auto`` (the slide region of ``regions.json``), ``full`` or ``x,y,w,h``."""
    if text is None:
        return None
    return AUTO if text == AUTO else Crop.parse(text)


def resolve(spec: SlidesSpec, regions: LectureRegions | None) -> Crop | None:
    """The slide crop ``--slides`` asks for: ``auto`` is the lecture's slide region, the whole frame (and a warning)
    when the lecture has no ``regions.json`` yet."""
    if spec != AUTO:
        return spec
    if regions is None:
        log.warning("--slides auto: no %s beside the lecture (run find-regions); the slides are the whole frame", FILE)
        return Crop()
    return regions.slides


# --- finding them -------------------------------------------------------------------------------------------------


@dataclass
class _Video:
    frames: NDArray[np.uint8]  # T x h x w grey keyframes at the analysis size
    times_ms: list[int]
    size: tuple[int, int]  # full width, height


def _sample(path: Path) -> _Video:
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        stream.codec_context.skip_frame = "NONKEY"
        width, height = stream.codec_context.width, stream.codec_context.height
        aw = min(ANALYSIS_W, width)
        ah = max(CELL, round(aw * height / width))
        grey: list[NDArray[np.uint8]] = []
        times: list[int] = []
        for frame in container.decode(stream):
            if frame.pts is None:
                continue
            grey.append(frame.reformat(width=aw, height=ah, format="gray").to_ndarray().astype(np.uint8, copy=False))
            times.append(int(frame.pts * frame.time_base * 1000))
    if len(grey) < 3:
        raise ValueError(f"{path.name}: {len(grey)} keyframes, too few to find the regions")
    return _Video(np.stack(grey), times, (width, height))


def _full_frames(path: Path, times_ms: Sequence[int]) -> list[tuple[int, NDArray[np.uint8]]]:
    """The keyframes at ``times_ms`` at full size, RGB (one more pass over the keyframes, keeping only those)."""
    wanted = set(times_ms)
    out: list[tuple[int, NDArray[np.uint8]]] = []
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        stream.codec_context.skip_frame = "NONKEY"
        for frame in container.decode(stream):
            if frame.pts is None:
                continue
            t = int(frame.pts * frame.time_base * 1000)
            if t in wanted:
                out.append((t, frame.to_ndarray(format="rgb24").astype(np.uint8, copy=False)))
    return out


def _per_pixel(
    frames: NDArray[np.uint8], fn: Callable[[NDArray[np.uint8]], NDArray[np.float64]]
) -> NDArray[np.float64]:
    """``fn`` over the time axis, a band of rows at a time (a whole lecture's floats would not fit in memory)."""
    band = max(1, 2_000_000 // max(1, frames.shape[0] * frames.shape[2]))
    rows = [fn(frames[:, y : y + band]) for y in range(0, frames.shape[1], band)]
    return np.concatenate(rows, axis=0)


def _median(frames: NDArray[np.uint8]) -> NDArray[np.float64]:
    return _per_pixel(frames, lambda f: np.median(f, axis=0))


def _range(frames: NDArray[np.uint8]) -> NDArray[np.float64]:
    def spread(f: NDArray[np.uint8]) -> NDArray[np.float64]:
        lo, hi = np.percentile(f, [5, 95], axis=0)
        return hi - lo

    return _per_pixel(frames, spread)


def _in_layout(frames: NDArray[np.uint8]) -> NDArray[np.bool_]:
    median = _median(frames)
    return np.array([(np.abs(f.astype(np.float64) - median) > DIFF).mean() <= OFF_LAYOUT for f in frames])


@dataclass
class _Stats:
    """Per analysis pixel, over a run of layout keyframes."""

    busy: NDArray[np.float64]  # share of consecutive pairs where it changed by more than DIFF
    spread: NDArray[np.float64]  # 95th minus 5th percentile
    vertical: NDArray[np.float64]  # h x (w-1): share of frames with an edge between columns x and x+1
    horizontal: NDArray[np.float64]  # (h-1) x w: between rows y and y+1


def _stats(frames: NDArray[np.uint8]) -> _Stats:
    t, h, w = frames.shape
    busy = np.zeros((h, w))
    vertical = np.zeros((h, w - 1))
    horizontal = np.zeros((h - 1, w))
    previous: NDArray[np.int16] | None = None
    for f in frames:
        g = f.astype(np.int16)
        vertical += np.abs(np.diff(g, axis=1)) > EDGE
        horizontal += np.abs(np.diff(g, axis=0)) > EDGE
        if previous is not None:
            busy += np.abs(g - previous) > DIFF
        previous = g
    return _Stats(busy / max(1, t - 1), _range(frames), vertical / t, horizontal / t)


def _cells(values: NDArray[np.float64]) -> NDArray[np.float64]:
    h, w = values.shape[0] // CELL * CELL, values.shape[1] // CELL * CELL
    v = values[:h, :w]
    return v.reshape(h // CELL, CELL, w // CELL, CELL).mean(axis=(1, 3))


def _components(mask: NDArray[np.bool_]) -> list[tuple[int, Box]]:
    """4-connected components of a cell mask: (cells, bounding box in cells), largest first."""
    seen = np.zeros_like(mask)
    rows, cols = mask.shape
    found: list[tuple[int, Box]] = []
    for r0 in range(rows):
        for c0 in range(cols):
            if not mask[r0, c0] or seen[r0, c0]:
                continue
            stack = [(r0, c0)]
            seen[r0, c0] = True
            n, box = 0, [c0, r0, c0 + 1, r0 + 1]
            while stack:
                r, c = stack.pop()
                n += 1
                box = [min(box[0], c), min(box[1], r), max(box[2], c + 1), max(box[3], r + 1)]
                for rr, cc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
                    if 0 <= rr < rows and 0 <= cc < cols and mask[rr, cc] and not seen[rr, cc]:
                        seen[rr, cc] = True
                        stack.append((rr, cc))
            found.append((n, (box[0], box[1], box[2], box[3])))
    return sorted(found, key=lambda f: -f[0])


def _support(stats: _Stats, side: Side, at: int, span: tuple[int, int]) -> float:
    """Share of a side's length along which a persistent edge runs at boundary ``at`` (within a pixel)."""
    lo, hi = span
    if side in ("left", "right"):
        cols = stats.vertical[lo:hi, max(0, at - 2) : max(0, min(stats.vertical.shape[1], at + 1))]
    else:
        cols = stats.horizontal[max(0, at - 2) : max(0, min(stats.horizontal.shape[0], at + 1)), lo:hi].T
    if cols.size == 0:
        return 0.0
    return float((cols.max(axis=1) > PERSIST).mean())


def _strip(stats: _Stats, side: Side, at: int, span: tuple[int, int], *, outside: bool, depth: int = 3) -> float:
    """How much the strip just outside (or inside) boundary ``at`` changed over the lecture: the median spread."""
    lo, hi = span
    h, w = stats.spread.shape
    before = (side in ("left", "top")) == outside  # the strip lies before ``at`` along its axis
    size = w if side in ("left", "right") else h
    a, b = (max(0, at - depth), at) if before else (at, min(size, at + depth))
    strip = stats.spread[lo:hi, a:b] if side in ("left", "right") else stats.spread[a:b, lo:hi]
    return float(np.median(strip)) if strip.size else 0.0


def _border(stats: _Stats, side: Side, at: int, span: tuple[int, int]) -> bool:
    """True when boundary ``at`` is a region's border: a persistent edge with stillness beyond it, or the frame's own
    edge with content running up to it."""
    size = stats.spread.shape[1 if side in ("left", "right") else 0]
    if at in (0, size):
        return _strip(stats, side, at, span, outside=False) > STATIC
    support = _support(stats, side, at, span)
    if support < SUPPORT or _strip(stats, side, at, span, outside=True) > STATIC:
        return False
    # a line, not texture: a wall or a pattern has edges everywhere, a border stands out from its neighbours
    around = [_support(stats, side, at + d, span) for d in (-5, -4, 4, 5) if 0 < at + d < size]
    return support - (sum(around) / len(around) if around else 0.0) >= RIDGE


def _snap(stats: _Stats, box: Box, reach: tuple[int, int], limit: Box, *, outermost: bool) -> tuple[Box, set[Side]]:
    """Move each side of ``box`` out, up to ``reach`` (x, y) pixels and never past ``limit``, to a border
    (``_border``): the outermost one in reach, or the first one met. Sides that find none stay. Returns the box and
    the sides that found a border."""
    x0, y0, x1, y1 = box
    snapped: set[Side] = set()
    for _ in range(2):  # a side's span depends on the other sides
        for side in SIDES:
            if side == "left":
                options = range(max(limit[0], x0 - reach[0]), x0 + 1)
                span = (y0, y1)
            elif side == "right":
                options = range(min(limit[2], x1 + reach[0]), x1 - 1, -1)
                span = (y0, y1)
            elif side == "top":
                options = range(max(limit[1], y0 - reach[1]), y0 + 1)
                span = (x0, x1)
            else:
                options = range(min(limit[3], y1 + reach[1]), y1 - 1, -1)
                span = (x0, x1)
            for at in options if outermost else reversed(options):
                if _border(stats, side, at, span):
                    if side == "left":
                        x0 = at
                    elif side == "right":
                        x1 = at
                    elif side == "top":
                        y0 = at
                    else:
                        y1 = at
                    snapped.add(side)
                    break
    return (x0, y0, x1, y1), snapped


def _cell_box(cells: Box, shape: tuple[int, int]) -> Box:
    h, w = shape
    return cells[0] * CELL, cells[1] * CELL, min(w, cells[2] * CELL), min(h, cells[3] * CELL)


def _camera_in(stats: _Stats) -> Box | None:
    """The webcam inset in one run of keyframes, in analysis pixels, None when no patch moves."""
    h, w = stats.busy.shape
    busy = _cells(stats.busy) > BUSY
    total = busy.size
    for n, cells in _components(busy):
        if n / total > CAMERA_MAX_AREA:
            continue
        if n / total < CAMERA_MIN_AREA:
            return None
        seed = _cell_box(cells, (h, w))
        sw, sh = seed[2] - seed[0], seed[3] - seed[1]
        box, _ = _snap(stats, seed, (max(sw, w // 10), max(sh, h // 10)), (0, 0, w, h), outermost=False)
        return box
    return None


def _iou(a: Box, b: Box) -> float:
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union else 0.0


def _union(boxes: Sequence[Box]) -> Box:
    return min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)


def _camera_spans(frames: NDArray[np.uint8]) -> list[tuple[int, int, Box]]:
    """The webcam per stretch of the lecture, neighbouring stretches in one place merged and found again on all their
    frames: (first index, end index, box)."""
    n = len(frames)
    size = max(MIN_WINDOW, -(-n // WINDOWS))
    starts = list(range(0, n, size))
    if len(starts) > 1 and n - starts[-1] < size // 2:
        starts.pop()  # a short last stretch joins the one before
    bounds = [(s, starts[i + 1] if i + 1 < len(starts) else n) for i, s in enumerate(starts)]
    found = [(a, b, _camera_in(_stats(frames[a:b]))) for a, b in bounds]
    groups: list[list[tuple[int, int, Box | None]]] = []
    for item in found:
        last = groups[-1][-1][2] if groups else None
        if groups and (
            (last is None and item[2] is None)
            or (last is not None and item[2] is not None and _iou(last, item[2]) >= SAME_PLACE)
        ):
            groups[-1].append(item)
        else:
            groups.append([item])
    spans: list[tuple[int, int, Box]] = []
    for group in groups:
        a, b = group[0][0], group[-1][1]
        if all(g[2] is None for g in group):
            continue
        box = _camera_in(_stats(frames[a:b])) if len(group) > 1 else group[0][2]
        if box is not None:
            spans.append((a, b, box))
    return spans


def _slides_in(stats: _Stats, camera: Box | None) -> tuple[Box, set[Side]]:
    """The slide region in analysis pixels: the extent of the content outside the webcam, grown to the border."""
    h, w = stats.spread.shape
    content = _cells(stats.spread) > CONTENT
    if camera is not None:
        c0, r0 = max(0, camera[0] // CELL - 1), max(0, camera[1] // CELL - 1)
        c1, r1 = -(-camera[2] // CELL) + 1, -(-camera[3] // CELL) + 1
        content[r0:r1, c0:c1] = False
    parts = [p for p in _components(content) if p[0] >= max(2, content.size // 500)]
    if not parts:
        return (0, 0, w, h), set()
    cells = parts[0][1]
    near = max(content.shape) // 12  # pieces of the same slides (a title, a footer) within a few cells
    for _, other in parts[1:]:
        gap_x = max(0, max(cells[0], other[0]) - min(cells[2], other[2]))
        gap_y = max(0, max(cells[1], other[1]) - min(cells[3], other[3]))
        if gap_x <= near and gap_y <= near:
            cells = _union([cells, other])
    extent = _cell_box(cells, (h, w))
    limit = (0, 0, w, h)
    if camera is not None:  # never grow into the webcam
        x0, y0, x1, y1 = limit
        if camera[0] >= extent[2]:
            x1 = camera[0]
        elif camera[2] <= extent[0]:
            x0 = camera[2]
        elif camera[1] >= extent[3]:
            y1 = camera[1]
        elif camera[3] <= extent[1]:
            y0 = camera[3]
        limit = (x0, y0, x1, y1)
    return _snap(stats, extent, (w, h), limit, outermost=True)


def _refine(grey: Sequence[NDArray[np.float32]], box: Box, scale: tuple[float, float], snapped: set[Side]) -> Box:
    """``box`` (analysis pixels) at full size: each side that sits on an edge placed on the strongest edge within a
    cell of it, then ``SAFE_PX`` inside."""
    sx, sy = scale
    full_h, full_w = grey[0].shape
    x0, y0, x1, y1 = round(box[0] * sx), round(box[1] * sy), round(box[2] * sx), round(box[3] * sy)
    out = {"left": x0, "top": y0, "right": x1, "bottom": y1}
    for side in snapped:
        vertical = side in ("left", "right")
        at = out[side]
        size = full_w if vertical else full_h
        if at in (0, size):
            continue  # the frame's own edge
        reach = int(np.ceil(sx if vertical else sy)) + 2
        lo_span, hi_span = (y0, y1) if vertical else (x0, x1)
        best, best_at = -1.0, at
        for b in range(max(1, at - reach), min(size - 1, at + reach) + 1):
            if vertical:
                step = np.mean([np.abs(g[lo_span:hi_span, b] - g[lo_span:hi_span, b - 1]).mean() for g in grey])
            else:
                step = np.mean([np.abs(g[b, lo_span:hi_span] - g[b - 1, lo_span:hi_span]).mean() for g in grey])
            if step > best:
                best, best_at = float(step), b
        out[side] = best_at + (SAFE_PX if side in ("left", "top") else -SAFE_PX)
    return out["left"], out["top"], out["right"], out["bottom"]


def _trim_bars(grey: Sequence[NDArray[np.float32]], box: Box) -> Box:
    """Walk each side in past flat dark rows or columns: the bars of a slide letterboxed in a wider slide area."""
    x0, y0, x1, y1 = box
    stack = np.stack([g[y0:y1, x0:x1] for g in grey])  # K x h x w

    def flat(line: NDArray[np.float32]) -> bool:  # K x n: one row or column in every frame
        means = line.mean(axis=1)
        return bool(means.max() < DARK and line.std(axis=1).max() < FLAT and np.ptp(means) < FLAT * 2)

    h, w = stack.shape[1:]
    left, right, top, bottom = 0, w, 0, h
    while left < w * 0.2 and flat(stack[:, :, left]):
        left += 1
    while w - right < w * 0.2 and flat(stack[:, :, right - 1]):
        right -= 1
    while top < h * 0.2 and flat(stack[:, top, :]):
        top += 1
    while h - bottom < h * 0.2 and flat(stack[:, bottom - 1, :]):
        bottom -= 1
    return x0 + left, y0 + top, x0 + right, y0 + bottom


def _fractions(box: Box, size: tuple[int, int]) -> Crop:
    w, h = size
    x0, y0 = max(0, box[0]), max(0, box[1])
    x1, y1 = min(w, box[2]), min(h, box[3])
    return Crop(x0 / w, y0 / h, (x1 - x0) / w, (y1 - y0) / h)


@dataclass(frozen=True)
class Found:
    regions: LectureRegions
    sample_ms: tuple[int, ...]  # layout keyframes spread over the lecture, for the contact sheet


def find_regions(path: Path) -> Found:
    """The slide and webcam regions of the lecture at ``path`` (see the module doc). About as long as the slide scan."""
    video = _sample(path)
    layout = _in_layout(video.frames)
    frames = video.frames[layout]
    times = [t for t, keep in zip(video.times_ms, layout, strict=True) if keep]
    if len(frames) < 3:
        raise ValueError(f"{path.name}: almost no keyframe shows the usual layout")
    ah, aw = frames.shape[1:]
    scale = (video.size[0] / aw, video.size[1] / ah)
    picks = sorted({times[round(i * (len(times) - 1) / (FULL_KEPT - 1))] for i in range(FULL_KEPT)})
    full = _full_frames(path, picks)
    grey = [(rgb.astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32)) for _, rgb in full]

    spans = _camera_spans(frames)
    end_ms = video.times_ms[-1] + 1
    camera_boxes = [_refine(grey, box, scale, set(SIDES)) for _, _, box in spans]
    camera_box = _union(camera_boxes) if camera_boxes else None
    analysis_camera = _union([box for _, _, box in spans]) if spans else None
    slides_box, snapped = _slides_in(_stats(frames), analysis_camera)
    slides_full = _trim_bars(grey, _refine(grey, slides_box, scale, snapped))
    camera_spans = (
        tuple(
            CameraSpan(
                times[a] if i else 0,
                times[b] if b < len(times) else end_ms,
                _fractions(box, video.size),
            )
            for i, ((a, b, _), box) in enumerate(zip(spans, camera_boxes, strict=True))
        )
        if len(spans) > 1
        else ()
    )
    regions = LectureRegions(
        slides=_fractions(slides_full, video.size),
        camera=_fractions(camera_box, video.size) if camera_box else None,
        frame=video.size,
        camera_spans=camera_spans,
        found={
            "keyframes": len(video.frames),
            "off_layout": int((~layout).sum()),
            "slide_sides_on_an_edge": sorted(snapped, key=SIDES.index),
        },
    )
    return Found(regions, tuple(t for t, _ in full))


# --- the contact sheet --------------------------------------------------------------------------------------------

SHEET_COLUMNS = 4
SHEET_CELL = (480, 270)
SHEET_GAP = 8
SHEET_BG = (96, 96, 96)
SLIDES_LINE = (40, 220, 90)
CAMERA_LINE = (255, 140, 0)
CROP_LINE = (255, 0, 200)


def _fit(rgb: NDArray[np.uint8], width: int, height: int) -> NDArray[np.uint8]:
    h, w = rgb.shape[:2]
    k = min(width / w, height / h)
    tw, th = max(2, int(w * k) // 2 * 2), max(2, int(h * k) // 2 * 2)
    frame = av.VideoFrame.from_ndarray(np.ascontiguousarray(rgb), format="rgb24")
    return frame.reformat(width=tw, height=th, format="rgb24").to_ndarray().astype(np.uint8, copy=False)


def _outline(img: NDArray[np.uint8], box: Box, colour: tuple[int, int, int], width: int = 2) -> None:
    x0, y0, x1, y1 = box
    h, w = img.shape[:2]
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
    img[y0 : y0 + width, x0:x1] = colour
    img[max(y0, y1 - width) : y1, x0:x1] = colour
    img[y0:y1, x0 : x0 + width] = colour
    img[y0:y1, max(x0, x1 - width) : x1] = colour


def _paste(sheet: NDArray[np.uint8], img: NDArray[np.uint8], x: int, y: int, outline: bool) -> None:
    h, w = img.shape[:2]
    if outline:  # one pixel outside the picture, so its own edge shows against the line
        _outline(sheet, (x - 1, y - 1, x + w + 1, y + h + 1), CROP_LINE, 1)
    sheet[y : y + h, x : x + w] = img


def decode_jpeg(data: bytes) -> NDArray[np.uint8]:
    with av.open(io.BytesIO(data), format="image2pipe") as container:
        for frame in container.decode(video=0):
            return frame.to_ndarray(format="rgb24").astype(np.uint8, copy=False)
    raise ValueError("no picture in the JPEG")


def contact_sheet(media: Path, regions: LectureRegions, slides: Sequence[Slide], sample_ms: Sequence[int]) -> bytes:
    """A JPEG to check the regions by eye: rows of sample frames (slide region green, webcam orange) each with its
    webcam crop, then every slide in ``slides`` (cut from the slide region), each outlined in magenta one pixel
    outside it, so a stray border or a cut shows."""
    from .slideshow import jpeg

    cw, ch = SHEET_CELL
    full = _full_frames(media, sample_ms[:: max(1, len(sample_ms) // 4)][:4])
    rows_frames = -(-len(full) // 2)
    rows_slides = -(-len(slides) // SHEET_COLUMNS)
    width = SHEET_COLUMNS * (cw + SHEET_GAP) + SHEET_GAP
    height = (rows_frames + rows_slides) * (ch + SHEET_GAP) + SHEET_GAP
    sheet = np.empty((height, width, 3), dtype=np.uint8)
    sheet[:] = SHEET_BG
    for i, (t, rgb) in enumerate(full):
        fh, fw = rgb.shape[:2]
        shown = _fit(rgb, cw, ch)
        k = shown.shape[1] / fw
        camera = regions.camera
        for span in regions.camera_spans:
            if span.from_ms <= t < span.to_ms:
                camera = span.camera
        boxes: list[tuple[Crop, tuple[int, int, int]]] = [(regions.slides, SLIDES_LINE)]
        if camera is not None:
            boxes.append((camera, CAMERA_LINE))
        for crop, colour in boxes:
            x0, y0, x1, y1 = crop.box(fw, fh)
            _outline(shown, (int(x0 * k), int(y0 * k), int(x1 * k), int(y1 * k)), colour)
        x = SHEET_GAP + (i % 2) * 2 * (cw + SHEET_GAP)
        y = SHEET_GAP + (i // 2) * (ch + SHEET_GAP)
        _paste(sheet, shown, x, y, outline=False)
        if camera is not None:
            x0, y0, x1, y1 = camera.box(fw, fh)
            _paste(sheet, _fit(rgb[y0:y1, x0:x1], cw, ch), x + cw + SHEET_GAP, y, outline=True)
    top = SHEET_GAP + rows_frames * (ch + SHEET_GAP)
    for i, slide in enumerate(slides):
        shown = _fit(decode_jpeg(slide.jpeg), cw - 2, ch - 2)
        x = SHEET_GAP + (i % SHEET_COLUMNS) * (cw + SHEET_GAP) + 1
        y = top + (i // SHEET_COLUMNS) * (ch + SHEET_GAP) + 1
        _paste(sheet, shown, x, y, outline=True)
    return jpeg(sheet, max_w=width)
