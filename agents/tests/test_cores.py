from talk_tracks.asr.base import AsrFinal, AsrPartial
from talk_tracks.contracts import CaptionLine, SlideFrame
from talk_tracks.cores.captions import WINDOW, CaptionsCore
from talk_tracks.cores.outline import EVERY_LINES, EVERY_MS, OutlineCore
from talk_tracks.cores.slides import SlidesCore
from talk_tracks.cores.translate import TranslateCore
from talk_tracks.llm.base import OutlineDraft


def line(i: int, text: str = "hello") -> CaptionLine:
    return CaptionLine(id=i, start_ms=i * 1000, end_ms=i * 1000 + 900, text=text)


def test_captions_interim_items_then_the_final_line() -> None:
    core = CaptionsCore("en")
    interim = core.on_event(AsrPartial("Media over"), 900)
    assert interim is not None and not interim.final and interim.line.text == "Media over"
    assert core.on_event(AsrPartial("Media over"), 950) is None  # nothing new heard
    made = core.on_event(AsrFinal(" Media over Quick. ", 100, 2000), 2000)
    assert made is not None and made.final and made.line.id == 100 and made.line.text == "Media over Quick."
    assert core.state().interim == "" and len(core.lines) == 1
    assert core.carry().lines == [made.line]


def test_caption_ids_are_start_times_and_always_rise() -> None:
    core = CaptionsCore("en")
    assert core.on_event(AsrFinal("   ", 0, 10), 10) is None
    for i in range(WINDOW + 5):
        core.on_event(AsrFinal(f"line {i}", 1000 * i, 1000 * i + 900), 1000 * i + 900)
    ids = [x.id for x in core.lines]
    assert len(ids) == WINDOW and ids[-1] == 1000 * (WINDOW + 4)
    late = core.on_event(AsrFinal("same start", 1000 * (WINDOW + 4), 1000 * (WINDOW + 5)), 0)
    assert late is not None and late.line.id == 1000 * (WINDOW + 4) + 1
    assert [x.id for x in core.carry().lines] == [*ids[-1:], late.line.id]


def test_captions_resume_after_a_predecessors_lines() -> None:
    core = CaptionsCore("en", lines=[line(17)])
    made = core.on_event(AsrFinal("x", 0, 1), 1)  # a recogniser restarted at 0 still gets a later id
    assert made is not None and made.line.id == 18


def test_translate_asks_for_each_line_once() -> None:
    core = TranslateCore("tr")
    assert [x.id for x in core.pending([line(0), line(1)])] == [0, 1]
    assert core.pending([line(0), line(1)]) == []
    assert [x.id for x in core.pending([line(1), line(2)])] == [2]
    item = core.add(line(2), "iki")
    assert item.line.text == "iki" and item.line.start_ms == 2000 and core.carry().lines == [item.line]
    again = TranslateCore("tr", done=[item.line])  # a restarted agent does not translate it again
    assert again.pending([line(2), line(3)]) == [line(3)]


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
