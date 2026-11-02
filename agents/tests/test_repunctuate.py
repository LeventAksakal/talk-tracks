import asyncio
import json
import re
from pathlib import Path
from typing import Any

import httpx
import pytest

from talk_tracks import cli, revise
from talk_tracks.contracts import CaptionLine, CaptionsState, TranslatedLine, TranslationState, Usage
from talk_tracks.llm.ledger import SpendLedger
from talk_tracks.recording import RecordedSnapshot
from talk_tracks.repunctuate import (
    PUNCT_SCHEMA,
    FakePunctuator,
    MetaPunctuator,
    merge_punctuation,
    punct_path,
    repunctuate,
)
from talk_tracks.resegment import cue_report, resegment
from talk_tracks.session import honest_recording

from .test_resegment import CAPTIONS, TRANSLATE, snap
from .test_revise import write

# Two ASR lines as the virus and dataviz recogniser returned them: lower case, almost no punctuation.
LINES = [
    (
        "so viruses are not alive in the way that cells are but they hijack the machinery of the cell to copy "
        "themselves and every one of us carries the remains of ancient infections in our genome and some of those "
        "remains still do useful work today because evolution reuses whatever it finds lying around in the cell"
    ),
    (
        "now the interesting part is what happens next because the immune system has to learn the shape of each "
        "new virus before it can respond and that takes days which is why the first infection hits hardest while "
        "the second one barely registers at all"
    ),
]
SPANS = [(2_000, 32_000, 33_500), (34_000, 58_000, 59_500)]


def spoken_words(text: str) -> list[str]:
    """The word sequence, ignoring case and the punctuation around a word (the test's own rule, not the module's)."""
    return [re.sub(r"^[^\w]+|[^\w]+$", "", w).lower() for w in text.split()]


def unpunctuated() -> list[tuple[Any, list[RecordedSnapshot]]]:
    caps = [snap(0, CaptionsState(lang="en", lines=[]))]
    done: list[CaptionLine] = []
    for n, (text, (start, end, final)) in enumerate(zip(LINES, SPANS, strict=True)):
        words = text.split()
        for t in range(start + 500, end + 500, 500):  # the interim grows at an even pace
            heard = min(len(words), len(words) * (t - start - 500) // (end - start) + 1)
            caps.append(snap(t, CaptionsState(lang="en", lines=list(done), interim=" ".join(words[:heard]))))
        done.append(CaptionLine(id=n, start_ms=start, end_ms=end, text=text))
        caps.append(snap(final, CaptionsState(lang="en", lines=list(done))))
    tr = [
        snap(0, TranslationState(lang="tr", lines=[])),
        snap(36_000, TranslationState(lang="tr", lines=[TranslatedLine(id=0, text="birinci satir " * 20)])),
        snap(62_000, TranslationState(lang="tr", lines=[TranslatedLine(id=1, text="ikinci satir " * 18)])),
    ]
    return [(CAPTIONS, caps), (TRANSLATE, tr)]


def last_lines(directory: Path) -> list[CaptionLine]:
    (_, caps), *_ = revise.read_recording(directory)
    state = caps[-1].state
    assert isinstance(state, CaptionsState)
    return state.lines


class Rewriter:
    """A model that does not do as told: it respells, drops, adds and reorders words as well as punctuating."""

    def __init__(self) -> None:
        self.requests = 0

    @property
    def model(self) -> str:
        return "rewriter"

    @property
    def usage(self) -> Usage:
        return Usage(requests=self.requests)

    async def punctuate(self, text: str, *, before: str, after: str) -> str:
        self.requests += 1
        words = text.split()
        words[1] = "Virii,"  # respelled
        del words[5]  # dropped
        words.insert(9, "basically")  # added
        words[12], words[13] = words[13], words[12]  # reordered
        return " ".join(words[:-1]) + " " + words[-1].capitalize() + "."


def test_merge_keeps_every_word_and_takes_only_punctuation_and_case() -> None:
    original = "so the cell is fine but the virus is not and that matters"
    proposed = "So, the cell is fine, but the VIRUSES are not; and that really matters!"
    merged = merge_punctuation(original, proposed)
    assert spoken_words(merged) == spoken_words(original)
    assert merged == "So, the cell is fine, but the virus is not; and that matters!"
    assert merge_punctuation(original, "") == original


def test_the_word_sequence_is_identical_before_and_after_ignoring_case(tmp_path: Path) -> None:
    directory = write(tmp_path, unpunctuated())
    for punctuator in (FakePunctuator(), Rewriter()):
        punct_path(directory, "captions").unlink(missing_ok=True)
        asyncio.run(repunctuate(directory, punctuator))
        after = last_lines(directory)
        assert [spoken_words(line.text) for line in after] == [spoken_words(text) for text in LINES]
        assert [line.text for line in after] != LINES  # punctuation was added
        for _, cues in revise.read_recording(directory)[:1]:  # every snapshot of the track, not only the last
            for s in cues:
                assert isinstance(s.state, CaptionsState)
                for line in s.state.lines:
                    assert spoken_words(line.text) == spoken_words(LINES[line.id])


def test_repunctuation_moves_forced_breaks_to_sentences_and_clauses(tmp_path: Path) -> None:
    directory = write(tmp_path, unpunctuated())
    before = cue_report(revise.read_recording(directory))
    result = asyncio.run(repunctuate(directory, FakePunctuator()))
    assert result.written and result.changed == 2 and result.usage.requests == 2
    assert result.before == before and before.forced > 0
    after = cue_report(revise.read_recording(directory))
    assert result.after == after
    assert after.forced < before.forced and after.forced * 100 < 15 * after.cues
    assert after.mid_phrase == 0


def test_a_session_and_the_recording_room_cut_the_punctuated_lines_and_resplit_translations(tmp_path: Path) -> None:
    directory = write(tmp_path, unpunctuated())
    asyncio.run(repunctuate(directory, FakePunctuator()))
    (_, caps), (_, tr) = honest_recording(directory)
    cues = caps[-1].state
    assert isinstance(cues, CaptionsState)
    assert cues.lines[0].text[0].isupper() and any(c.text.endswith((".", ",")) for c in cues.lines)
    last = tr[-1].state
    assert isinstance(last, TranslationState)
    ids = {line.id for line in last.lines}
    assert ids and ids <= {c.id for c in cues.lines}  # the translation follows the new cues


def test_a_dry_run_sends_nothing_and_writes_nothing(tmp_path: Path) -> None:
    directory = write(tmp_path, unpunctuated())
    punctuator = FakePunctuator()
    result = asyncio.run(repunctuate(directory, punctuator, dry_run=True))
    assert not result.written and punctuator.usage.requests == 0
    assert not punct_path(directory, "captions").exists()
    assert result.plan.lines == 2 and result.plan.chars == sum(map(len, LINES))
    assert 0 < result.plan.usd < 0.01


def test_a_second_run_sends_only_the_lines_not_saved(tmp_path: Path) -> None:
    directory = write(tmp_path, unpunctuated())
    asyncio.run(repunctuate(directory, FakePunctuator()))
    first = punct_path(directory, "captions").read_text(encoding="utf-8")
    again = FakePunctuator()
    result = asyncio.run(repunctuate(directory, again))
    assert again.usage.requests == 0 and result.plan.lines == 0 and result.plan.saved == 2
    saved = json.loads(first)["lines"]
    del saved["1"]
    punct_path(directory, "captions").write_text(json.dumps({**json.loads(first), "lines": saved}), encoding="utf-8")
    third = FakePunctuator()
    asyncio.run(repunctuate(directory, third))
    assert third.usage.requests == 1


def test_a_saved_text_whose_words_differ_from_its_line_is_ignored(tmp_path: Path) -> None:
    directory = write(tmp_path, unpunctuated())
    body = {"model": "x", "usage": {}, "lines": {"0": "Something else entirely."}}
    punct_path(directory, "captions").write_text(json.dumps(body), encoding="utf-8")
    assert [line.text for line in last_lines(directory)] == LINES


def test_resegment_of_unpunctuated_recording_is_unchanged_without_a_pass(tmp_path: Path) -> None:
    directory = write(tmp_path, unpunctuated())
    recorded = revise.read_recording(directory)
    assert [line.text for line in last_lines(directory)] == LINES
    assert resegment(recorded)  # no saved pass: the recording as recorded


def test_the_meta_punctuator_asks_for_the_line_in_a_data_block_with_a_schema(tmp_path: Path) -> None:
    sent: list[dict[str, Any]] = []

    def reply(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": json.dumps({"text": "So, it works."})}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 250, "completion_tokens": 40},
            },
        )

    ledger = SpendLedger(tmp_path / "ledger.jsonl", 1.0)
    client = httpx.AsyncClient(transport=httpx.MockTransport(reply))
    punctuator = MetaPunctuator("key", ledger, base_url="http://127.0.0.1/v1", client=client)
    text = asyncio.run(punctuator.punctuate("so it works", before="the line before", after="the next"))
    assert text == "So, it works."
    body = sent[0]
    assert body["response_format"]["json_schema"]["schema"] == PUNCT_SCHEMA
    assert body["reasoning_effort"] == "minimal"
    assert "<line>so it works</line>" in body["messages"][1]["content"]
    assert "<before>the line before</before>" in body["messages"][1]["content"]
    assert ledger.total() == pytest.approx(punctuator.usage.cost_usd, abs=1e-5) and punctuator.usage.requests == 1


def test_cli_repunctuate_dry_run_needs_no_room_and_fake_writes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("TT_ROOM", raising=False)
    monkeypatch.delenv("TT_RELAY", raising=False)
    directory = write(tmp_path, unpunctuated())
    asyncio.run(cli.main_async(cli.parse(["repunctuate", "--recording", str(directory), "--dry-run"])))
    assert "dry run" in capsys.readouterr().out and not punct_path(directory, "captions").exists()
    with pytest.raises(SystemExit):
        cli.parse(["repunctuate", "--recording", str(directory)])  # a real run spends through a room's ledger
    args = cli.parse(["repunctuate", "--recording", str(directory), "--room", "repunct-test", "--fake"])
    asyncio.run(cli.main_async(args))
    assert "after:" in capsys.readouterr().out and punct_path(directory, "captions").exists()
