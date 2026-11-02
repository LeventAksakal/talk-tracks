from itertools import pairwise

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
from talk_tracks.resegment import MAX_CUE_CHARS, MAX_CUE_MS, resegment, translations_with_captions
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
    assert all(len(c.text) <= MAX_CUE_CHARS and c.end_ms - c.start_ms <= MAX_CUE_MS for c in cues)
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


def test_a_looped_room_shows_each_translated_cue_with_its_caption() -> None:
    late = Template.build(resegment(recording()), 40_000)
    looped = Template.build(translations_with_captions(resegment(recording())), 40_000)
    captions = _published(looped, CaptionItem)
    assert _published(late, TranslationItem).keys() == captions.keys()  # nothing lost
    assert min(_published(late, TranslationItem).values()) >= FINAL  # as recorded: once the whole line was final
    assert _published(looped, TranslationItem) == captions  # each with its caption, the early ones mid-line
    assert min(captions.values()) < FINAL - 20_000


def test_moving_translations_earlier_keeps_what_they_cost() -> None:
    caps, (info, tr) = recording()
    paid = Usage(requests=1, input_tokens=900, output_tokens=300, cost_usd=0.004)
    tr = [tr[0], tr[1].model_copy(update={"usage": paid})]
    looped = Template.build(translations_with_captions(resegment([caps, (info, tr)])), 40_000)
    translation = next(a for a in looped.agents if a.info.name == "translate-tr")
    assert translation.spend_usd() == paid.cost_usd
