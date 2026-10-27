# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportAttributeAccessIssue=false
"""A tiny synthetic lecture for tests: H.264 (no B-frames, a keyframe a second) and a 48 kHz Opus tone, in MP4."""

from __future__ import annotations

from fractions import Fraction
from pathlib import Path

import av
import numpy as np


def make_clip(path: Path, *, seconds: float = 2.0, fps: int = 10) -> Path:
    with av.open(str(path), "w", format="mp4") as out:
        video = out.add_stream("libx264", rate=fps)
        video.width, video.height, video.pix_fmt = 64, 48, "yuv420p"
        video.options = {"bf": "0", "g": str(fps), "keyint_min": str(fps), "sc_threshold": "0"}
        audio = out.add_stream("libopus", rate=48_000)
        audio.layout = "mono"
        for i in range(int(seconds * fps)):
            img = np.full((48, 64, 3), (i * 12) % 256, dtype=np.uint8)
            frame = av.VideoFrame.from_ndarray(img, format="rgb24")
            frame.pts, frame.time_base = i, Fraction(1, fps)
            for packet in video.encode(frame):
                out.mux(packet)
        t = np.arange(int(48_000 * seconds)) / 48_000
        pcm = (np.sin(2 * np.pi * 440 * t) * 3000).astype(np.int16)
        for n, start in enumerate(range(0, len(pcm) - 959, 960)):
            frame = av.AudioFrame.from_ndarray(pcm[start : start + 960].reshape(1, -1), format="s16", layout="mono")
            frame.sample_rate, frame.pts, frame.time_base = 48_000, n * 960, Fraction(1, 48_000)
            for packet in audio.encode(frame):
                out.mux(packet)
        for stream in (video, audio):
            for packet in stream.encode(None):
                out.mux(packet)
    return path
