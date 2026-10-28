# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportAttributeAccessIssue=false
from fractions import Fraction
from pathlib import Path

import av
import numpy as np
import pytest

from talk_tracks.slideshow import Crop, find_slides

W, H, FPS = 320, 180, 4


def text(img: np.ndarray, x: int, y: int, w: int, h: int) -> None:
    """Text-like stripes: the detail a slide's content has."""
    img[y : y + h : 4, x : x + w] = 0
    img[y + 1 : y + h : 4, x : x + w] = 0


def slide(*blocks: tuple[int, int, int, int]) -> np.ndarray:
    img = np.full((H, W, 3), 250, dtype=np.uint8)
    for block in blocks:
        text(img, *block)
    return img


A = slide((20, 10, 200, 30), (20, 60, 120, 40))
A_BUILT = slide((20, 10, 200, 30), (20, 60, 120, 40), (150, 50, 165, 125))  # a big picture revealed in empty space
B = slide((40, 20, 240, 20), (40, 80, 240, 80))
B_ZOOMED = np.repeat(np.repeat(B[45:135, 80:240], 2, axis=0), 2, axis=1)
C = slide((10, 10, 300, 160))


def make_deck(path: Path, crop_right: bool = False) -> Path:
    """Keyframe every 1 s. A 0-6 s, its build 6-10, a video clip 10-14, B 14-20, zoomed in 20-24, B again 24-28,
    C 28-32. With ``crop_right`` a noisy "speaker" strip on the right changes all the time."""
    rng = np.random.default_rng(1)
    timeline = [(6, A), (4, A_BUILT), (4, None), (6, B), (4, B_ZOOMED), (4, B), (4, C)]
    with av.open(str(path), "w", format="mp4") as out:
        video = out.add_stream("libx264", rate=FPS)
        video.width, video.height, video.pix_fmt = W + (80 if crop_right else 0), H, "yuv420p"
        video.options = {"bf": "0", "g": str(FPS), "keyint_min": str(FPS), "sc_threshold": "0", "crf": "18"}
        n = 0
        for seconds, img in timeline:
            for _ in range(seconds * FPS):
                frame_img = rng.integers(0, 255, (H, W, 3), dtype=np.uint8) if img is None else img
                if crop_right:
                    frame_img = np.concatenate([frame_img, rng.integers(0, 255, (H, 80, 3), dtype=np.uint8)], axis=1)
                frame = av.VideoFrame.from_ndarray(np.ascontiguousarray(frame_img), format="rgb24")
                frame.pts, frame.time_base = n, Fraction(1, FPS)
                for packet in video.encode(frame):
                    out.mux(packet)
                n += 1
        for packet in video.encode(None):
            out.mux(packet)
    return path


def decode(jpeg: bytes) -> np.ndarray:
    packet = av.Packet(jpeg)
    codec = av.CodecContext.create("mjpeg", "r")
    return codec.decode(packet)[0].to_ndarray(format="rgb24")


def close_to(a: np.ndarray, b: np.ndarray) -> bool:
    return a.shape == b.shape and float(np.abs(a.astype(int) - b.astype(int)).mean()) < 6


def test_one_frame_per_slide_builds_collapsed_and_returns_skipped(tmp_path: Path) -> None:
    slides = find_slides(make_deck(tmp_path / "deck.mp4"))
    # A (first seen at 0 s, as built), B at 14, the zoomed view at 20, C at 28; the clip and the return to B are not
    # slides. A still screen is confirmed by the next keyframe, so a slide is stamped at its first still keyframe.
    assert [s.at_ms for s in slides] == [0, 14_000, 20_000, 28_000]
    assert close_to(decode(slides[0].jpeg), A_BUILT)  # described once, complete
    assert close_to(decode(slides[1].jpeg), B)
    assert close_to(decode(slides[3].jpeg), C)


def test_crop_keeps_out_a_changing_speaker(tmp_path: Path) -> None:
    deck = make_deck(tmp_path / "deck.mp4", crop_right=True)
    slides = find_slides(deck, Crop(0, 0, W / (W + 80), 1))
    assert [s.at_ms for s in slides] == [0, 14_000, 20_000, 28_000]
    assert decode(slides[0].jpeg).shape == (H, W, 3)


def test_crop_parse() -> None:
    assert Crop.parse("full") == Crop()
    assert Crop.parse("0,0,0.77,0.77") == Crop(0, 0, 0.77, 0.77)
    assert Crop(0, 0, 0.77, 0.77).box(1280, 720) == (0, 0, 984, 554)
    with pytest.raises(ValueError):
        Crop.parse("0.5,0,0.8,1")
