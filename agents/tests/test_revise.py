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
from talk_tracks.resegment import cue_texts, resegment
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
