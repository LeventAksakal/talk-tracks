import os
from itertools import pairwise
from pathlib import Path

import pytest

from talk_tracks.contracts import (
    AgentInfo,
    CaptionLine,
    CaptionsState,
    State,
    TranslatedLine,
    TranslationState,
    Usage,
)
from talk_tracks.recording import RecordedSnapshot
from talk_tracks.resegment import (
    MAX_CUE_CHARS,
    MAX_CUE_MS,
    MAX_CUE_MS_HARD,
    breaks,
    clause_end,
    cue_report,
    cut,
    resegment,
    strong_end,
)
from talk_tracks.revise import read_recording
from talk_tracks.slicing import CaptionItem, Template, TranslationItem

CAPTIONS = AgentInfo(name="captions", label="Captions", model="fake")
TRANSLATE = AgentInfo(name="translate-tr", label="Turkish", model="fake")

LINE = (
    "Viruses are not alive in the way that cells are, but they hijack the machinery of the cell to copy themselves. "
    "Every one of us carries the remains of ancient infections in our genome, and some of those remains still do "
    "useful work today, because evolution reuses whatever it finds lying around in the cell."
)
TURKISH = (
    "Virusler hucreler gibi canli degildir, ama kendilerini kopyalamak icin hucrenin mekanizmasini ele gecirirler. "
    "Her birimiz genomumuzda eski enfeksiyonlarin kalintilarini tasiriz ve bu kalintilarin bazilari bugun hala "
    "yararli is yapar, cunku evrim hucrede buldugu her seyi yeniden kullanir."
)
START, END, FINAL = 2_000, 32_000, 33_500


def snap(media_ms: int, state: State) -> RecordedSnapshot:
    return RecordedSnapshot(media_ms=media_ms, wall_ms=0, instance="1", seq=0, usage=Usage(), state=state)


def recording() -> list[tuple[AgentInfo, list[RecordedSnapshot]]]:
    words = LINE.split()
    line = CaptionLine(id=0, start_ms=START, end_ms=END, text=LINE)
    caps = [snap(0, CaptionsState(lang="en", lines=[]))]
    for t in range(2_500, 32_500, 500):  # the interim grows at an even pace, a little behind the speaker
        heard = len(words) * (t - 2_500) // 30_000 + 1
        caps.append(snap(t, CaptionsState(lang="en", lines=[], interim=" ".join(words[:heard]))))
    caps.append(snap(FINAL, CaptionsState(lang="en", lines=[line])))
    tr = [
        snap(0, TranslationState(lang="tr", lines=[])),
        snap(35_000, TranslationState(lang="tr", lines=[TranslatedLine(id=0, text=TURKISH)])),
    ]
    return [(CAPTIONS, caps), (TRANSLATE, tr)]


def final_lines(snapshots: list[RecordedSnapshot]) -> list[CaptionLine]:
    state = snapshots[-1].state
    assert isinstance(state, CaptionsState)
    return state.lines


def test_a_long_line_becomes_subtitle_cues_over_its_own_time() -> None:
    (info, caps), _ = resegment(recording())
    assert info == CAPTIONS
    cues = final_lines(caps)
    assert len(cues) >= 4
    assert [c.id for c in cues] == list(range(len(cues)))
    assert " ".join(c.text for c in cues) == LINE
    assert all(len(c.text) <= MAX_CUE_CHARS and c.end_ms - c.start_ms <= MAX_CUE_MS_HARD for c in cues)
    assert cues[0].start_ms == START and cues[-1].end_ms == END
    assert all(a.end_ms == b.start_ms for a, b in pairwise(cues))
    assert any(c.text.endswith("themselves.") for c in cues)  # the sentence end is a cue end


def test_early_cues_go_out_while_the_line_is_still_being_heard() -> None:
    (_, caps), _ = resegment(recording())
    both = 0
    for snapshot in caps[:-1]:
        state = snapshot.state
        assert isinstance(state, CaptionsState)
        shown = " ".join([c.text for c in state.lines] + ([state.interim] if state.interim else []))
        assert LINE.startswith(shown)  # final cues, then the rest heard so far as the interim
        both += bool(state.lines and state.interim)
    assert both > 10
    assert len(final_lines(caps[:-1])) == len(final_lines(caps)) - 1  # the last cue goes out with the line


def test_the_translation_is_split_over_the_cues_sentence_by_sentence() -> None:
    (_, caps), (info, tr) = resegment(recording())
    assert info == TRANSLATE
    cues = {c.id: c for c in final_lines(caps)}
    state = tr[-1].state
    assert isinstance(state, TranslationState)
    assert " ".join(line.text for line in state.lines) == TURKISH
    assert {line.id for line in state.lines} <= set(cues)
    second = next(line for line in state.lines if line.text.startswith("Her birimiz"))  # the second sentence
    assert cues[second.id].text.startswith("Every one of us")


def test_a_resegmented_recording_slices() -> None:
    template = Template.build(resegment(recording()), 40_000)
    assert [a.info.name for a in template.agents] == ["captions", "translate-tr"]


def _published(template: Template, kind: type[CaptionItem] | type[TranslationItem]) -> dict[int, int]:
    """When each cue id first went out on the looped room's track of ``kind`` (final captions only)."""
    out: dict[int, int] = {}
    for agent in template.agents:
        for group in agent.groups:
            for s in group:
                body = s.body
                if isinstance(body, kind) and (not isinstance(body, CaptionItem) or body.final):
                    out.setdefault(body.line.id, s.at_ms)
    return out


def test_a_translation_goes_out_when_the_agent_published_it_never_with_its_caption() -> None:
    template = Template.build(resegment(recording()), 40_000)
    captions, translations = _published(template, CaptionItem), _published(template, TranslationItem)
    assert translations.keys() == captions.keys()  # every cue has its part of the translation
    assert min(captions.values()) < FINAL - 20_000  # captions cue by cue while the line is heard
    assert min(translations.values()) >= 35_000  # the translation as the agent published it: after the whole line


CLAUSES = (
    "So what we found in the samples was that the virus had changed, and in a way nobody had "
    "predicted at the time we started. That surprised us, and we spent a year on it."
)
LONG_SENTENCE = "one two three four five six seven eight nine ten eleven twelve thirteen. Fourteen fifteen."


def test_a_cue_ends_at_a_sentence_or_a_clause_rather_than_mid_phrase() -> None:
    words = CLAUSES.split()
    spoken = [i * 300 for i in range(len(words) + 1)]  # 0.3 s a word: 7 s is about 23 words
    cues = cut(words, spoken)
    assert [(i, j) for i, j, _ in cues] == breaks(words, spoken)
    for i, j, forced in cues[:-1]:
        assert not forced and (strong_end(words[j - 1]) or clause_end(words[j - 1])), words[i:j]
    assert all(spoken[j] - spoken[i] <= MAX_CUE_MS_HARD for i, j, _ in cues)


def test_a_cue_runs_a_little_over_seven_seconds_to_reach_a_sentence_end() -> None:
    words = LONG_SENTENCE.split()
    spoken = [i * 580 for i in range(len(words) + 1)]  # 13 words is 7.5 s
    (i, j, forced), *_ = cut(words, spoken)
    assert (i, j, forced) == (0, 13, False)
    assert MAX_CUE_MS < spoken[j] - spoken[i] <= MAX_CUE_MS_HARD


def test_a_forced_break_says_so_and_does_not_end_on_a_function_word() -> None:
    words = ("word " * 30 + "of the matter").split()
    spoken = [i * 400 for i in range(len(words) + 1)]
    cues = cut(words, spoken)
    assert cues[0][2]  # no mark anywhere: forced
    assert all(words[j - 1] not in ("of", "the") for _, j, _ in cues)


DEMO_LECTURES = ("virus", "dataviz", "rsa", "qrcode")
DEMO_DIR = Path(os.environ.get("TT_DEMO_DIR", Path(__file__).resolve().parents[2] / "data" / "demo"))


@pytest.mark.parametrize("lecture", DEMO_LECTURES)
def test_the_demo_recordings_break_at_sentences_and_clauses(lecture: str) -> None:
    """Over each demo recording (``data/demo/<lecture>/``, or ``TT_DEMO_DIR``; not in git, so skipped where it is
    missing): no cue ends without a sentence end or clause mark unless its break was forced. ``-s`` prints the
    counts; ``python -m talk_tracks cue-report --recording DIR`` prints the same."""
    folder = DEMO_DIR / lecture
    if not (folder / "recording.json").exists():
        pytest.skip(f"no recording in {folder}")
    report = cue_report(read_recording(folder))  # the recorded ASR lines, as a session cuts them
    print(f"{lecture}: {report}")
    assert report.cues > 0
    assert report.mid_phrase == 0
    assert report.longest_chars <= MAX_CUE_CHARS
