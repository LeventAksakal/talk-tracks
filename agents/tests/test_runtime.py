import base64
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from talk_tracks import statefile
from talk_tracks.asr.base import AsrEvent, AsrFinal, AsrSession
from talk_tracks.asr.scripted import ScriptedAsr, ScriptedLine
from talk_tracks.contracts import ENVELOPE, AgentInfo, CaptionsState, SlideFrame, Usage
from talk_tracks.cores.captions import CaptionsCore
from talk_tracks.llm.fake import FakeLlm
from talk_tracks.publisher import SnapshotPublisher
from talk_tracks.runtime import run_captions, run_describe, run_outline, run_translate

SCRIPT = [
    ScriptedLine(0, 2_000, "Media over Quick lets a relay fan out named tracks."),
    ScriptedLine(2_500, 4_000, "Agents are ordinary publishers."),
    ScriptedLine(4_500, 6_000, "A viewer subscribes only to the tracks it wants."),
]


class ListSink:
    def __init__(self) -> None:
        self.objects: list[bytes] = []

    async def write(self, data: bytes) -> None:
        self.objects.append(data)

    def envelopes(self) -> list[Any]:
        return [ENVELOPE.validate_json(o) for o in self.objects]


def publisher(name: str, sink: ListSink, llm: FakeLlm | None = None) -> SnapshotPublisher:
    return SnapshotPublisher(
        AgentInfo(name=name, label=name, model="fake"),
        sink,
        (lambda: llm.usage) if llm else (lambda: Usage()),
        instance="1",
        clock_ms=lambda: 1,
    )


async def audio(seconds: int) -> AsyncIterator[tuple[NDArray[np.int16], int]]:
    for i in range(seconds * 10):
        yield np.zeros(1600, dtype=np.int16), (i + 1) * 100


async def states(sink: ListSink) -> AsyncIterator[CaptionsState]:
    for env in sink.envelopes():
        assert isinstance(env.state, CaptionsState)
        yield env.state


async def test_captions_end_to_end_with_scripted_asr() -> None:
    sink = ListSink()
    await run_captions(audio(7), ScriptedAsr(SCRIPT), publisher("captions", sink), "en")
    envelopes = sink.envelopes()
    assert [x.text for x in envelopes[-1].state.lines] == [s.text for s in SCRIPT]
    assert [e.seq for e in envelopes] == list(range(1, len(envelopes) + 1))
    assert any(e.state.interim for e in envelopes)  # viewers saw partial text on the way


async def test_restarted_captions_keep_their_lines_and_ids(tmp_path: Path) -> None:
    path = tmp_path / "captions-dev-en.json"
    first = ListSink()
    await run_captions(
        audio(3), ScriptedAsr(SCRIPT[:1]), publisher("captions", first), "en", save=lambda s: statefile.save(path, s)
    )
    later = [ScriptedLine(s.start_ms, s.end_ms, s.text) for s in SCRIPT[1:]]
    second = ListSink()
    await run_captions(
        audio(7), ScriptedAsr(later), publisher("captions", second), "en", resume=statefile.load_captions(path)
    )
    lines = second.envelopes()[-1].state.lines
    assert [line.id for line in lines] == [0, 1, 2]
    assert lines[0].text == SCRIPT[0].text

    # A translator that already did line 0 under the old instance translates only the new lines.
    tr, llm = ListSink(), FakeLlm()

    async def both() -> AsyncIterator[CaptionsState]:
        async for state in states(first):
            yield state
        async for state in states(second):
            yield state

    await run_translate(both(), llm, publisher("translate-tr", tr, llm), "tr")
    assert [line.id for line in tr.envelopes()[-1].state.lines] == [0, 1, 2]
    assert llm.usage.requests == 3


def test_a_stale_or_broken_state_file_is_ignored(tmp_path: Path) -> None:
    path = tmp_path / "s.json"
    assert statefile.load_captions(path) is None
    path.write_text("{", encoding="utf-8")
    assert statefile.load_captions(path) is None
    statefile.save(path, CaptionsCore("en").state())
    assert statefile.load_captions(path) is not None
    assert statefile.load_captions(path, max_age_s=-1) is None


async def test_translate_outline_and_describe_follow_the_captions() -> None:
    cap = ListSink()
    await run_captions(audio(7), ScriptedAsr(SCRIPT), publisher("captions", cap), "en")

    tr, llm = ListSink(), FakeLlm()
    await run_translate(states(cap), llm, publisher("translate-tr", tr, llm), "tr")
    assert tr.envelopes()[-1].state.lines[0].text.startswith("[tr] Media over Quick")
    assert tr.envelopes()[-1].usage.requests == 3

    ol, llm2 = ListSink(), FakeLlm()
    ticks = iter(range(0, 10**9, 70_000))
    await run_outline(states(cap), llm2, publisher("chapters", ol, llm2), "en", clock=lambda: next(ticks))
    assert ol.envelopes()[-1].state.recap

    sl, llm3 = ListSink(), FakeLlm()

    async def frames() -> AsyncIterator[SlideFrame]:
        # Slide 3 shows slide 1's image again: it reuses the description instead of paying for it twice.
        for i, image in ((1, b"one"), (1, b"one"), (2, b"two"), (3, b"one")):
            yield SlideFrame(id=i, at_ms=i, mime="image/png", data_b64=base64.b64encode(image).decode())

    await run_describe(frames(), llm3, publisher("describe", sl, llm3), "en")
    notes = sl.envelopes()[-1].state.slides
    assert [n.id for n in notes] == [1, 2, 3]
    assert notes[2].description == notes[0].description
    assert llm3.usage.requests == 2


async def test_failing_model_does_not_stop_the_track() -> None:
    class Flaky(FakeLlm):
        async def translate(self, text: str, *, lang: str, context: Any) -> str:
            if "Agents" in text:
                raise RuntimeError("model down")
            return await super().translate(text, lang=lang, context=context)

    cap = ListSink()
    await run_captions(audio(7), ScriptedAsr(SCRIPT), publisher("captions", cap), "en")
    tr = ListSink()
    await run_translate(states(cap), Flaky(), publisher("translate-tr", tr), "tr")
    assert len(tr.envelopes()[-1].state.lines) == 2


async def test_asr_opens_on_first_audio_and_reopens_after_a_failure() -> None:
    class Session:
        def __init__(self, fail_at_ms: int | None) -> None:
            self.fail_at_ms = fail_at_ms

        async def feed(self, pcm16k: NDArray[np.int16], end_ms: int) -> list[AsrEvent]:
            if self.fail_at_ms is not None and end_ms >= self.fail_at_ms:
                raise RuntimeError("stream closed")
            return [AsrFinal(f"to {end_ms}", end_ms - 100, end_ms)] if end_ms % 1000 == 0 else []

        async def close(self) -> list[AsrEvent]:
            return []

    class Provider:
        def __init__(self) -> None:
            self.offsets: list[int] = []

        async def open(self, language: str, offset_ms: int = 0) -> AsrSession:
            self.offsets.append(offset_ms)
            return Session(6_500 if len(self.offsets) == 1 else None)

    async def late_audio() -> AsyncIterator[tuple[NDArray[np.int16], int]]:
        for end_ms in range(5_100, 8_100, 100):  # the talk was already 5 s in when the agent started
            yield np.zeros(1600, dtype=np.int16), end_ms

    provider, sink = Provider(), ListSink()
    await run_captions(late_audio(), provider, publisher("captions", sink), "en")
    assert provider.offsets == [5_000, 6_500]  # first chunk's start; then the chunk after the failure at 6.5 s
    assert [x.text for x in sink.envelopes()[-1].state.lines] == ["to 6000", "to 7000", "to 8000"]


async def test_heartbeat_repeats_state_with_same_seq() -> None:
    sink = ListSink()
    pub = publisher("captions", sink)
    await pub.publish(CaptionsCore("en").state())
    await pub.heartbeat()
    a, b = (json.loads(o) for o in sink.objects)
    assert a["seq"] == b["seq"] == 1


async def test_heartbeat_before_first_state_is_silent() -> None:
    sink = ListSink()
    await publisher("captions", sink).heartbeat()
    assert sink.objects == []
