from talk_tracks.asr.base import AsrFinal, AsrPartial
from talk_tracks.contracts import CaptionLine, SlideFrame
from talk_tracks.cores.captions import WINDOW, CaptionsCore
from talk_tracks.cores.outline import EVERY_LINES, EVERY_MS, OutlineCore
from talk_tracks.cores.slides import SlidesCore
from talk_tracks.cores.translate import TranslateCore
from talk_tracks.llm.base import OutlineDraft


def line(i: int, text: str = "hello") -> CaptionLine:
    return CaptionLine(id=i, start_ms=i * 1000, end_ms=i * 1000 + 900, text=text)


def test_captions_partial_then_final() -> None:
    core = CaptionsCore("en")
    assert core.on_event(AsrPartial("Media over")) is None
    assert core.state().interim == "Media over"
    made = core.on_event(AsrFinal(" Media over Quick. ", 100, 2000))
    assert made is not None and made.id == 0 and made.text == "Media over Quick."
    assert core.state().interim == "" and len(core.state().lines) == 1


def test_captions_ignore_empty_final_and_window() -> None:
    core = CaptionsCore("en")
    assert core.on_event(AsrFinal("   ", 0, 10)) is None
    for i in range(WINDOW + 5):
        core.on_event(AsrFinal(f"line {i}", i, i + 1))
    ids = [x.id for x in core.state().lines]
    assert len(ids) == WINDOW and ids[-1] == WINDOW + 4 and core.next_id == WINDOW + 5


def test_captions_resume_ids() -> None:
    core = CaptionsCore("en", next_id=17)
    made = core.on_event(AsrFinal("x", 0, 1))
    assert made is not None and made.id == 17


def test_translate_asks_for_each_line_once() -> None:
    core = TranslateCore("tr")
    assert [x.id for x in core.pending([line(0), line(1)])] == [0, 1]
    assert core.pending([line(0), line(1)]) == []
    assert [x.id for x in core.pending([line(1), line(2)])] == [2]
    core.add(2, "iki")
    assert core.state().lines[0].text == "iki"


def frame(i: int) -> SlideFrame:
    return SlideFrame(id=i, at_ms=i, mime="image/png", data_b64="AA==")


def test_slides_repeat_frames_are_free() -> None:
    core = SlidesCore("en")
    assert core.wants(frame(1)) is True
    assert core.wants(frame(1)) is False
    core.add(frame(1), "A title slide")
    assert core.state().slides[0].description == "A title slide"


def test_slides_identical_image_reuses_its_description() -> None:
    core = SlidesCore("en")
    assert core.known(frame(1)) is None
    core.add(frame(1), "A title slide")
    assert core.known(frame(7)) == "A title slide"
    assert core.known(SlideFrame(id=8, at_ms=8, mime="image/png", data_b64="AQ==")) is None


def test_outline_due_by_lines_or_time() -> None:
    core = OutlineCore("en")
    core.add_lines([line(i) for i in range(EVERY_LINES - 1)])
    assert core.due(0) is False
    core.add_lines([line(EVERY_LINES - 1)])
    assert core.due(0) is True
    window, previous = core.request(1000)
    assert len(window) == EVERY_LINES and previous is None
    assert core.due(1000) is False
    core.add_lines([line(EVERY_LINES)])
    assert core.due(1000 + EVERY_MS - 1) is False
    assert core.due(1000 + EVERY_MS) is True
    core.apply(OutlineDraft(recap="r"))
    assert core.state().recap == "r"
