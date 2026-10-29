# ruff: noqa: RUF001, RUF003  (Turkish text: the dotless i is meant)
import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from talk_tracks import revise
from talk_tracks.contracts import AgentInfo, CaptionsState, SlideNote, SlidesState, TranslationState, Usage
from talk_tracks.llm.fake import FakeLlm
from talk_tracks.llm.ledger import SpendLedger
from talk_tracks.recording import RecordedSnapshot, RecordingWriter
from talk_tracks.resegment import MAX_CUE_CHARS, cue_texts, resegment
from talk_tracks.slideshow import Crop, Slide

from .test_resegment import recording as long_line

SLIDES = AgentInfo(name="describe", label="Slides", model="fake")


def write(directory: Path, recorded: list[tuple[AgentInfo, list[RecordedSnapshot]]]) -> Path:
    rec = RecordingWriter(directory, "gen-test", wall_ms=0)
    for info, snapshots in recorded:
        for snap in snapshots:
            rec.add(info, snap.state, snap.usage, media_ms=snap.media_ms, wall_ms=0)
    rec.close(wall_ms=1)
    return directory


def snap(media_ms: int, state: SlidesState) -> RecordedSnapshot:
    return RecordedSnapshot(media_ms=media_ms, wall_ms=0, instance="1", seq=0, usage=Usage(), state=state)


def note(i: int, at_ms: int) -> SlideNote:
    return SlideNote(id=i, at_ms=at_ms, description=f"slide {i}")


def test_retranslate_saves_one_segment_per_cue_and_the_loop_uses_them(tmp_path: Path) -> None:
    directory = write(tmp_path, long_line())
    saved = asyncio.run(revise.retranslate(directory, revise.FakeCueTranslator()))
    cues = cue_texts(revise.read_recording(directory))[0]
    assert saved.lines[0].segments == [f"[tr] {c}" for c in cues]
    assert saved.usage.requests == 1
    recorded = revise.read_recording(directory)
    (_, caps), (_, tr) = resegment(recorded, revise.translations_by_agent(directory, recorded))
    last = tr[-1].state
    assert isinstance(last, TranslationState) and isinstance(caps[-1].state, CaptionsState)
    assert [line.text for line in last.lines] == saved.lines[0].segments
    assert [line.id for line in last.lines] == [c.id for c in caps[-1].state.lines]


def test_saved_segments_for_other_cues_fall_back_to_the_split(tmp_path: Path) -> None:
    directory = write(tmp_path, long_line())
    saved = asyncio.run(revise.retranslate(directory, revise.FakeCueTranslator()))
    stale = saved.model_copy(update={"lines": {0: saved.lines[0].model_copy(update={"cues": ["another cut"]})}})
    revise.cues_path(directory, "translate-tr").write_text(stale.model_dump_json(), encoding="utf-8")
    recorded = revise.read_recording(directory)
    _, (_, tr) = resegment(recorded, revise.translations_by_agent(directory, recorded))
    last = tr[-1].state
    assert isinstance(last, TranslationState)
    assert not any(line.text.startswith("[tr]") for line in last.lines)


def test_redescribe_describes_only_the_slides_without_a_note(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    states = [
        snap(3_000, SlidesState(lang="en", slides=[note(0, 0)])),
        snap(20_000, SlidesState(lang="en", slides=[note(0, 0), note(2, 15_000)])),
    ]
    directory = write(tmp_path, [(SLIDES, states)])
    found = [Slide(0, b"a"), Slide(8_000, b"b"), Slide(15_000, b"c"), Slide(30_000, b"d")]

    def find(media: Path, crop: Crop | None = None) -> list[Slide]:
        return found

    monkeypatch.setattr(revise, "find_slides", find)
    patch = asyncio.run(revise.redescribe(directory, directory / "lecture.mp4", Crop(), FakeLlm()))
    assert [(n.id, n.at_ms) for n in patch.notes] == [(1, 8_000), (3, 30_000)]
    merged = revise.with_patches(directory, revise.read_recording(directory))[0][1]
    assert [s.media_ms for s in merged] == [3_000, 12_000, 20_000, 34_000]
    ids: list[list[int]] = []
    for s in merged:
        assert isinstance(s.state, SlidesState)
        ids.append([n.id for n in s.state.slides])
    assert ids == [[0], [0, 1], [0, 1, 2], [0, 1, 2, 3]]


def test_the_meta_cue_translator_asks_for_one_segment_per_cue(tmp_path: Path) -> None:
    sent: list[dict[str, Any]] = []

    def reply(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        sent.append(body)
        content = json.dumps({"segments": ["bir", "iki"]})
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": content}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 300, "completion_tokens": 100},
            },
        )

    ledger = SpendLedger(tmp_path / "ledger.jsonl", 1.0)
    client = httpx.AsyncClient(transport=httpx.MockTransport(reply))
    translator = revise.MetaCueTranslator("key", ledger, base_url="http://127.0.0.1/v1", client=client)
    segments = asyncio.run(translator.translate_cues(["one", "two"], lang="tr", context=["before"]))
    assert segments == ["bir", "iki"]
    assert sent[0]["response_format"]["json_schema"]["schema"] == revise.CUES_SCHEMA
    assert "1. one\n2. two" in sent[0]["messages"][1]["content"]
    assert ledger.total() == pytest.approx(translator.usage.cost_usd) and translator.usage.requests == 1


# Turkish cut unevenly over three English cues, as retranslate's model did: the middle segment runs over 84.
TR_CUES = [
    "I'm not going to talk about disease.",
    "I am absolutely not qualified to diagnose any disease, to advise on treatment,",
    "to talk about degrees disease progression, anything like that.",
]
TR_SEGMENTS = [
    "Hastalıktan bahsetmeyeceğim.",
    "Herhangi bir hastalığı teşhis etme, tedavi önerme konusunda kesinlikle yetkin değilim,",
    "hastalığın ilerleme dereceleri hakkında konuşma, böyle şeyler.",
]


def words_of(segments: list[str]) -> list[str]:
    return " ".join(segments).split()


@pytest.mark.parametrize("anchor", ["model", "share"])
def test_resplit_line_fits_every_cue_and_keeps_the_words_in_order(anchor: revise.Anchor) -> None:
    assert max(len(s) for s in TR_SEGMENTS) > MAX_CUE_CHARS
    out = revise.resplit_line(TR_CUES, TR_SEGMENTS, anchor=anchor)
    assert len(out) == len(TR_CUES) and all(out)
    assert max(len(s) for s in out) <= MAX_CUE_CHARS
    assert words_of(out) == words_of(TR_SEGMENTS)


def test_resplit_line_moves_only_the_words_it_must_by_default() -> None:
    out = revise.resplit_line(TR_CUES, TR_SEGMENTS)
    assert out == [TR_SEGMENTS[0], TR_SEGMENTS[1].removesuffix(" değilim,"), "değilim, " + TR_SEGMENTS[2]]


def test_resplit_line_by_share_breaks_after_punctuation_near_the_share() -> None:
    # equal cues put the share point between "beş" and "altı"; the sentence end a word earlier wins
    out = revise.resplit_line(
        ["a" * 40, "b" * 40], ["Bir iki üç dört. Beş altı yedi", "sekiz dokuz on"], anchor="share"
    )
    assert out == ["Bir iki üç dört.", "Beş altı yedi sekiz dokuz on"]


def test_resplit_line_keeps_the_overflow_least_when_the_line_cannot_fit() -> None:
    long = "çok " * 60  # 239 characters, with "son" 243, over two cues of 84
    out = revise.resplit_line(["one", "two"], [long, "son"])
    assert words_of(out) == words_of([long, "son"])
    assert revise.overflow(out) == 243 - 1 - 2 * MAX_CUE_CHARS


def test_resplit_line_leaves_a_line_with_too_few_words() -> None:
    assert revise.resplit_line(["one", "two", "three"], ["iki", "kelime"]) == ["iki", "kelime"]


def test_resplit_rewrites_the_saved_cues_keeps_the_original_and_is_idempotent(tmp_path: Path) -> None:
    (tmp_path / "agents").mkdir()
    fine = revise.CueTranslation(cues=["Good morning."], segments=["Günaydın."])
    saved = revise.CueTranslations(
        lang="tr",
        model="m",
        usage=Usage(requests=2),
        lines={0: fine, 3: revise.CueTranslation(cues=TR_CUES, segments=TR_SEGMENTS)},
    )
    path = revise.cues_path(tmp_path, "translate-tr")
    path.write_text(saved.model_dump_json(), encoding="utf-8")
    result, changed = revise.resplit(tmp_path)
    assert changed == [3]
    assert result.lines[0] == fine and result.usage == saved.usage
    assert result.lines[3].cues == TR_CUES  # the cues, and so their timing, stay
    assert max(len(s) for s in result.lines[3].segments) <= MAX_CUE_CHARS
    assert words_of(result.lines[3].segments) == words_of(TR_SEGMENTS)
    assert revise.load_cue_translations(tmp_path) == {
        0: (("Good morning.",), ("Günaydın.",)),
        3: (tuple(TR_CUES), tuple(result.lines[3].segments)),
    }
    backup = tmp_path / "agents" / "translate-tr.cues.orig.json"
    assert revise.CueTranslations.model_validate_json(backup.read_text(encoding="utf-8")) == saved
    first = path.read_text(encoding="utf-8")
    again, changed = revise.resplit(tmp_path)
    assert changed == [] and again == result and path.read_text(encoding="utf-8") == first
    assert revise.CueTranslations.model_validate_json(backup.read_text(encoding="utf-8")) == saved
