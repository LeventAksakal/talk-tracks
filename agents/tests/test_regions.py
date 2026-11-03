"""find-regions on synthetic conference recordings (tests/layout_clip.py): the slide area and the webcam inset."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from talk_tracks.contracts import RoomCatalog as MsfRoomCatalog
from talk_tracks.regions import (
    AUTO,
    FILE,
    LectureRegions,
    beside,
    contact_sheet,
    decode_jpeg,
    find_regions,
    load,
    resolve,
    slides_spec,
)
from talk_tracks.room_catalog import RoomCatalog, speaker_sources
from talk_tracks.slideshow import Crop, find_slides

from .layout_clip import CAMERA, CAMERA_MOVED, SLIDES, H, W, make_layout_lecture

TOLERANCE_PX = 4  # a found side lies within this many pixels of the true one (2 of them are the safety margin)

Box = tuple[int, int, int, int]


def pixels(crop: Crop) -> Box:
    return round(crop.x * W), round(crop.y * H), round((crop.x + crop.w) * W), round((crop.y + crop.h) * H)


def edges(box: tuple[int, int, int, int]) -> Box:
    x, y, w, h = box
    return x, y, x + w, y + h


def assert_near(found: Crop, truth: Box) -> None:
    got = pixels(found)
    assert all(abs(a - b) <= TOLERANCE_PX for a, b in zip(got, truth, strict=True)), (got, truth)
    # inside the truth, never beyond it: no sliver of backdrop or border
    assert got[0] >= truth[0] and got[1] >= truth[1] and got[2] <= truth[2] and got[3] <= truth[3], (got, truth)


@pytest.fixture(scope="module")
def lectures(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    root = tmp_path_factory.mktemp("layouts")
    return {
        "still": make_layout_lecture(root / "still.mp4"),
        "moved": make_layout_lecture(root / "moved.mp4", move_at_s=60),
        "boxed": make_layout_lecture(root / "boxed.mp4", seconds=80, bars=40, cut_s=(30, 40)),
    }


def test_finds_the_slide_area_and_the_webcam_inset(lectures: dict[str, Path]) -> None:
    found = find_regions(lectures["still"]).regions
    assert_near(found.slides, edges(SLIDES))
    assert found.camera is not None
    assert_near(found.camera, edges(CAMERA))
    assert found.camera_spans == ()
    assert found.frame == (W, H)


def test_a_moving_inset_keeps_each_place_and_their_union(lectures: dict[str, Path]) -> None:
    found = find_regions(lectures["moved"]).regions
    first, second = found.camera_spans
    assert_near(first.camera, edges(CAMERA))
    assert_near(second.camera, edges(CAMERA_MOVED))
    assert first.from_ms == 0 and abs(first.to_ms - 60_000) <= 2_000 and second.from_ms == first.to_ms
    assert found.camera is not None
    union = (CAMERA_MOVED[0], CAMERA_MOVED[1], CAMERA[0] + CAMERA[2], CAMERA[1] + CAMERA[3])
    assert_near(found.camera, union)
    assert_near(found.slides, edges(SLIDES))


def test_a_letterboxed_slide_loses_its_bars_and_a_stage_cut_is_left_out(lectures: dict[str, Path]) -> None:
    found = find_regions(lectures["boxed"]).regions
    x, y, w, h = SLIDES
    assert_near(found.slides, (x + 40, y, x + w - 40, y + h))
    assert found.found["off_layout"] == 10  # the keyframes of the 10 s stage shot, one a second
    assert found.camera is not None
    assert_near(found.camera, edges(CAMERA))


def test_every_slide_is_cut_whole_from_the_found_area(lectures: dict[str, Path]) -> None:
    media = lectures["still"]
    result = find_regions(media)
    slides = find_slides(media, result.regions.slides)
    assert len(slides) == 12  # one every 10 s over 120 s
    sheet = decode_jpeg(contact_sheet(media, result.regions, slides, result.sample_ms))
    assert sheet.shape[1] == 4 * (480 + 8) + 8
    assert sheet.shape[0] > 3 * 270  # the sample rows and three rows of slides


def test_regions_json_round_trips_and_feeds_the_catalog(tmp_path: Path) -> None:
    regions = LectureRegions(slides=Crop(0.01, 0.02, 0.75, 0.75), camera=Crop(0.78, 0.55, 0.2, 0.4), frame=(W, H))
    media = tmp_path / "lecture.mp4"
    assert load(beside(media)) is None
    regions.write(beside(media))
    assert beside(media).name == FILE
    again = load(beside(media))
    assert again is not None and again.slides == regions.slides and again.camera == regions.camera

    catalog = RoomCatalog(0, (), sources=speaker_sources("virus", camera=True), regions=regions.wire()).to_json()
    tt = catalog["tt"]
    assert isinstance(tt, dict)
    assert tt["regions"] == {"slides": [0.01, 0.02, 0.75, 0.75], "camera": [0.78, 0.55, 0.2, 0.4]}
    MsfRoomCatalog.model_validate(json.loads(json.dumps(catalog)))
    assert "regions" not in RoomCatalog(0, ()).to_json()["tt"]  # type: ignore[operator]


def test_slides_auto_takes_the_slide_region(tmp_path: Path) -> None:
    regions = LectureRegions(slides=Crop(0.01, 0.02, 0.75, 0.75), camera=None)
    assert slides_spec(None) is None
    assert slides_spec("auto") == AUTO
    assert slides_spec("0,0,0.77,0.77") == Crop(0, 0, 0.77, 0.77)
    assert resolve(AUTO, regions) == regions.slides
    assert resolve(AUTO, None) == Crop()  # no regions.json yet: the whole frame
    assert resolve(Crop(0, 0, 0.5, 0.5), regions) == Crop(0, 0, 0.5, 0.5)  # an explicit crop wins
    assert resolve(None, regions) is None
