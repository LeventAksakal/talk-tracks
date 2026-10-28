import itertools

from talk_tracks.asr.base import AsrFinal, AsrPartial
from talk_tracks.contracts import CaptionLine, ChapterData, Cue, RecapData, SlideFrame, TermData
from talk_tracks.cores.captions import LINE_CHARS, MAX_CUE_MS, CaptionsCore, fits
from talk_tracks.cores.outline import EVERY_LINES, EVERY_MS, OutlineCore
from talk_tracks.cores.slides import SlidesCore
from talk_tracks.cores.translate import TranslateCore
from talk_tracks.llm.base import OutlineDraft
from talk_tracks.records import latest

# One recogniser turn of 41 s, shaped like the real-agent run's (median 28-38 s, up to 139 s): Muse Voice sends the
# turn's whole transcript so far about every 300 ms and gives no word timings, only the turn's start and end.
LONG_TURN = (
    "So today we are going to talk about media over QUIC, which is a new protocol from the IETF. It lets one relay "
    "fan out many named tracks to thousands of viewers, and each viewer picks the tracks they want, whether that is "
    "captions, a translation or slide descriptions. The interesting part is what happens when a viewer rewinds: the "
    "past is a fetch, and the agent that made the track answers it from its archive, so nothing is paid twice and "
    "nothing is made that nobody asked for"
)


def cue(i: int, text: str = "hello", *, final: bool = True) -> Cue:
    return Cue(start=i * 1000, end=i * 1000 + 900, id=str(i * 1000), text=text, final=final)


def line(i: int, text: str = "hello") -> CaptionLine:
    return CaptionLine(id=i, start_ms=i * 1000, end_ms=i * 1000 + 900, text=text)


def speak(core: CaptionsCore, text: str, start: int, every_ms: int = 300) -> tuple[list[Cue], int]:
    """Partials word by word, then the turn's final: what the recogniser does, in room time."""
    words, t = text.split(), start
    out: list[Cue] = []
    for i in range(1, len(words) + 1):
        t += every_ms
        out += core.on_event(AsrPartial(" ".join(words[:i]), start), t)
    out += core.on_event(AsrFinal(text, start, t + 200), t + 200)
    return out, t + 200


def test_a_long_turn_becomes_subtitle_sized_cues() -> None:
    core = CaptionsCore("en")
    published, end = speak(core, LONG_TURN, 10_000)
    finals = [c for c in published if c.final]
    assert len(finals) >= 8
    assert " ".join(c.text for c in finals) == LONG_TURN  # every word, once, in order
    for c in finals:
        assert c.end - c.start <= MAX_CUE_MS, c
        assert fits(c.text.split()) and all(len(w) <= LINE_CHARS for w in c.text.split())
    assert finals[0].start == 10_000 and finals[-1].end == end
    assert all(a.end == b.start for a, b in itertools.pairwise(finals))  # back to back, no overlap
    assert sum(c.text.endswith((".", ",")) for c in finals) >= len(finals) - 2  # cut at sentence and clause ends
    assert [int(c.id) for c in finals] == sorted(int(c.id) for c in finals)
    assert len({c.id for c in finals}) == len(finals)


def test_a_cue_grows_as_interim_revisions_then_goes_final_with_the_same_id() -> None:
    core = CaptionsCore("en")
    first = core.on_event(AsrPartial("Media over", 100), 900)
    assert [(c.id, c.rev, c.final, c.text) for c in first] == [("100", 0, False, "Media over")]
    assert core.on_event(AsrPartial("Media over", 100), 950) == []  # nothing new heard
    grown = core.on_event(AsrPartial("Media over Quick", 100), 1200)
    assert [(c.id, c.rev, c.final) for c in grown] == [("100", 1, False)]
    made = core.on_event(AsrFinal(" Media over Quick. ", 100, 2000), 2000)
    assert [(c.id, c.rev, c.final, c.text, c.start, c.end) for c in made] == [
        ("100", 2, True, "Media over Quick.", 100, 2000)
    ]
    assert core.carry() == made
    assert latest([*first, *grown, *made]) == made  # a viewer merging by id keeps the final


def test_a_sentence_end_goes_final_as_soon_as_the_next_word_is_heard() -> None:
    core = CaptionsCore("en")
    core.on_event(AsrPartial("This is the first sentence.", 0), 2000)
    out = core.on_event(AsrPartial("This is the first sentence. And", 0), 2300)
    assert [(c.final, c.text) for c in out] == [(True, "This is the first sentence."), (False, "And")]
    assert out[0].end == 2000 and out[1].start == 2000  # the cut is when the words were first heard


def test_cue_ids_are_start_times_and_always_rise() -> None:
    core = CaptionsCore("en")
    assert core.on_event(AsrFinal("   ", 0, 10), 10) == []
    for i in range(5):
        core.on_event(AsrFinal(f"line {i}", 1000 * i, 1000 * i + 900), 1000 * i + 900)
    late = core.on_event(AsrFinal("same start", 4000, 5000), 5000)
    assert [c.id for c in late] == ["4900"]  # it starts when the last cue ended, and its id is its start
    assert [c.id for c in core.carry()] == ["4000", "4900"]


def test_captions_resume_after_a_predecessors_cues() -> None:
    core = CaptionsCore("en", cues=[cue(17)])
    made = core.on_event(AsrFinal("x", 0, 1), 1)  # a recogniser restarted at 0 still gets a later id
    assert [c.id for c in made] == ["17900"] and made[0].start == 17_900


def test_translate_asks_for_each_final_cue_once_and_keeps_its_id() -> None:
    core = TranslateCore("tr")
    assert [c.id for c in core.pending([cue(0), cue(1), cue(2, final=False)])] == ["0", "1000"]
    assert core.pending([cue(0), cue(1)]) == []
    assert [c.id for c in core.pending([cue(1), cue(2)])] == ["2000"]
    made = core.add(cue(2), "iki")
    assert (made.id, made.start, made.end, made.text, made.final) == ("2000", 2000, 2900, "iki", True)
    assert core.carry() == [made]
    again = TranslateCore("tr", done=[made])  # a restarted agent does not translate it again
    assert again.pending([cue(2), cue(3)]) == [cue(3)]
    joined = TranslateCore("tr")
    joined.skip_before(8000)  # a Joining FETCH of slice 2: only cues from its start on
    assert [c.id for c in joined.pending([cue(7), cue(8), cue(9)])] == ["8000", "9000"]


def frame(i: int) -> SlideFrame:
    return SlideFrame(id=i, at_ms=i, mime="image/png", data_b64="AA==")


def test_slides_repeat_frames_are_free_and_the_slide_on_screen_is_the_carry_in() -> None:
    core = SlidesCore("en")
    assert core.wants(frame(1)) is True
    assert core.wants(frame(1)) is False
    assert core.carry() == []
    made = core.add(frame(1), 4_500, "A title slide")
    assert (made.at, made.text) == (4_500, "A title slide") and core.carry() == [made]


def test_slides_identical_image_reuses_its_description() -> None:
    core = SlidesCore("en")
    assert core.known(frame(1)) is None
    core.add(frame(1), 1, "A title slide")
    assert core.known(frame(7)) == "A title slide"
    assert core.known(SlideFrame(id=8, at_ms=8, mime="image/png", data_b64="AQ==")) is None


def test_outline_due_by_lines_or_time_and_published_as_records() -> None:
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
    from talk_tracks.contracts import Chapter, GlossaryTerm

    core.apply(
        OutlineDraft(
            chapters=[Chapter(id=0, start_ms=2000, title="Intro", summary="Why")],
            glossary=[GlossaryTerm(term="MoQ", definition="Media over QUIC")],
            recap="r",
        )
    )
    records = core.records(9000)
    assert [(r.m, type(r.data)) for r in records] == [(2000, ChapterData), (9000, TermData), (9000, RecapData)]
    again = OutlineCore("en")
    again.seed(records)  # a restarted agent refines the newest revision
    assert again.records(9000) == records and again.state().recap == "r"
