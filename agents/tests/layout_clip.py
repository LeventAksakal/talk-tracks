# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportAttributeAccessIssue=false
"""A synthetic conference recording for tests: the slides as the main area, the speaker's webcam as an inset.

H.264 (no B-frames, a keyframe a second), no audio. A static dark backdrop with a logo; a new slide every 10 s in
``SLIDES``, some with content at their very edges (the margins a fixed crop cut); a webcam in ``CAMERA``: a textured
wall with sensor noise and a speaker who sways and nods. With ``move_at_s`` the inset jumps to ``CAMERA_MOVED``.
With ``full_frame``, no layout: the slides fill the frame and the video cuts to the stage camera for ``cut_s`` (the
``qrcode`` lecture), some slides with a photo out to the frame's left edge.
"""

from __future__ import annotations

from fractions import Fraction
from pathlib import Path

import av
import numpy as np
from numpy.typing import NDArray

W, H = 640, 360
SLIDES = (16, 12, 464, 261)  # x, y, w, h in pixels: the slide area
CAMERA = (496, 196, 128, 144)  # the webcam inset
CAMERA_MOVED = (496, 24, 128, 144)  # where the inset sits after ``move_at_s``


def fractions(box: tuple[int, int, int, int]) -> tuple[float, float, float, float]:
    x, y, w, h = box
    return x / W, y / H, w / W, h / H


def _slide(rng: np.random.Generator, n: int, w: int, h: int) -> NDArray[np.uint8]:
    img = np.full((h, w, 3), 248, dtype=np.uint8)
    mx, my = (2, 2) if n % 3 == 0 else (w // 12, h // 10)
    img[my : my + h // 9, mx : w - mx] = (40, 60, 120)  # the title bar
    for row in range(5):
        y = my + h // 5 + row * (h // 8)
        length = int(rng.integers(w // 3, w - 2 * mx))
        img[y : y + 3, mx : mx + length] = 20
        img[y + 5 : y + 7, mx : mx + length // 2] = 20
    if n % 4 == 1:
        img[h // 2 : h - my, w // 2 : w - mx] = rng.integers(0, 255, 3).astype(np.uint8)
    img[h - 6 : h - 2, w - 22 : w - 4] = 20 + 9 * n  # the slide number, bottom right
    return img


def make_layout_lecture(
    path: Path,
    *,
    seconds: int = 120,
    fps: int = 5,
    move_at_s: float | None = None,
    bars: int = 0,
    cut_s: tuple[float, float] | None = None,
    full_frame: bool = False,
) -> Path:
    rng = np.random.default_rng(7)
    backdrop = np.zeros((H, W, 3), dtype=np.uint8)
    backdrop[:] = (28, 18, 46)
    backdrop[300:340, 24:110] = (230, 200, 40)  # the logo
    sx, sy, sw, sh = (0, 0, W, H) if full_frame else SLIDES
    slides = [np.zeros((sh, sw, 3), dtype=np.uint8) for _ in range(seconds // 10 + 1)]
    for n, picture in enumerate(slides):
        picture[:, bars : sw - bars] = _slide(rng, n, sw - 2 * bars, sh)
        if full_frame and n % 5 == 2:  # a photo to the frame's edge: rare, so a content extent misses it
            picture[sh // 4 : sh - 4, 0 : sw // 3] = rng.integers(0, 255, (sh - 4 - sh // 4, sw // 3, 3))
    stage = rng.integers(0, 255, (H // 8, W // 8, 3)).astype(np.uint8).repeat(8, axis=0).repeat(8, axis=1)
    cw, ch = CAMERA[2], CAMERA[3]
    wall = (rng.integers(90, 140, (ch, cw, 1)) * np.ones((1, 1, 3))).astype(np.int16)
    yy, xx = np.mgrid[0:ch, 0:cw]
    with av.open(str(path), "w", format="mp4") as out:
        video = out.add_stream("libx264", rate=fps)
        video.width, video.height, video.pix_fmt = W, H, "yuv420p"
        video.options = {"bf": "0", "g": str(fps), "keyint_min": str(fps), "sc_threshold": "0", "crf": "20"}
        for i in range(seconds * fps):
            t = i / fps
            img = backdrop.copy()
            img[sy : sy + sh, sx : sx + sw] = slides[int(t // 10)]
            cam = wall + rng.normal(0, 6, (ch, cw, 1)).astype(np.int16)
            hx = cw / 2 + cw / 4 * np.sin(t * 1.3) + rng.normal(0, 3)
            hy = ch * 0.38 + ch / 10 * np.sin(t * 2.1)
            head = (xx - hx) ** 2 / (cw / 7) ** 2 + (yy - hy) ** 2 / (ch / 6) ** 2 < 1
            body = (abs(xx - hx) < cw / 4) & (yy > hy + ch / 7)
            cam[head] = (210, 160, 130)
            cam[body] = (40, 70, 160)
            x, y, _, _ = CAMERA_MOVED if move_at_s is not None and t >= move_at_s else CAMERA
            if not full_frame:
                img[y : y + ch, x : x + cw] = np.clip(cam, 0, 255).astype(np.uint8)
            if cut_s is not None and cut_s[0] <= t < cut_s[1]:
                img = np.roll(stage, i, axis=1)
            frame = av.VideoFrame.from_ndarray(img, format="rgb24")
            frame.pts, frame.time_base = i, Fraction(1, fps)
            for packet in video.encode(frame):
                out.mux(packet)
        for packet in video.encode(None):
            out.mux(packet)
    return path
