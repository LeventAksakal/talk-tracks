import base64
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from talk_tracks import statefile
from talk_tracks.asr.base import AsrEvent, AsrFinal, AsrSession
from talk_tracks.asr.scripted import ScriptedAsr, ScriptedLine
from talk_tracks.contracts import CaptionItem, CaptionsCarry, Envelope, OutlineSnapshot, SlideFrame, SlideItem
from talk_tracks.cores.captions import CaptionsCore
from talk_tracks.cores.outline import OutlineCore
from talk_tracks.cores.slides import SlidesCore
from talk_tracks.cores.translate import TranslateCore
from talk_tracks.llm.fake import FakeLlm
from talk_tracks.runtime import caption_lines, run_captions, run_describe, run_outline, run_translate

from .slicekit import ListOut, sliced, snapshot_track

SCRIPT = [
    ScriptedLine(0, 2_000, "Media over Quick lets a relay fan out named tracks."),
    ScriptedLine(2_500, 4_000, "Agents are ordinary publishers."),
    ScriptedLine(4_500, 6_000, "A viewer subscribes only to the tracks it wants."),
]


async def audio(seconds: float, start_ms: int = 0) -> AsyncIterator[tuple[NDArray[np.int16], int]]:
    for i in range(int(seconds * 10)):
        yield np.zeros(1600, dtype=np.int16), start_ms + (i + 1) * 100


async def replay(out: ListOut) -> AsyncIterator[Envelope]:
    """What a downstream agent reads from a captions track, in order."""
    for env in out.envelopes():
        yield env


async def captions_out(tmp_path: Path) -> ListOut:
    track, out = sliced(tmp_path / "cap")
    core = CaptionsCore("en")
    track.carry = core.carry
    await run_captions(audio(7), ScriptedAsr(SCRIPT), track, core)
    await track.pause()
    return out


async def test_captions_in_slices_with_a_carry_in_then_items(tmp_path: Path) -> None:
    track, out = sliced(tmp_path)
    core = CaptionsCore("en")
    track.carry = core.carry
    await run_captions(audio(7), ScriptedAsr(SCRIPT), track, core)
    await track.pause()

    assert out.groups() == [0, 1] and out.ended == [0, 1]  # media 0-4 s, 4-7 s; each closed with End of Group
    first, second = out.envelopes(0), out.envelopes(1)
    assert first[0].kind == "carry" and first[0].body == CaptionsCarry(lang="en", lines=[])
    assert all(e.kind == "item" and e.slice == 0 for e in first[1:])
    finals = [e.body.line.text for e in first + second if isinstance(e.body, CaptionItem) and e.body.final]
    assert finals == [line.text for line in SCRIPT]
    assert any(isinstance(e.body, CaptionItem) and not e.body.final for e in first)  # interim versions are items too
    carry = second[0].body
    assert isinstance(carry, CaptionsCarry) and [x.text for x in carry.lines] == [SCRIPT[0].text]  # line 2 ends at 4 s
    assert [o for g, o, _ in out.objects if g == 1][:2] == [0, 1]  # object 0 is the carry-in, items follow

    for k in (0, 1):  # the record is byte for byte what went live, ending with End of Group
        stored = track.archive.read_local(k)
        assert stored is not None and stored.complete
        assert [o.payload for o in stored.objects if o.payload] == [p for g, _, p in out.objects if g == k]


async def test_a_restarted_agent_starts_at_the_next_slice_and_keeps_its_lines(tmp_path: Path) -> None:
    track, _ = sliced(tmp_path)
    core = CaptionsCore("en")
    track.carry = core.carry
    await run_captions(audio(5), ScriptedAsr(SCRIPT[:2]), track, core)  # killed 5 s in, inside slice 1
    track.archive.close()

    again, out = sliced(tmp_path)  # same name, same archive
    seeded = CaptionsCore("en", lines=[x for env in again.seed_envelopes() for x in caption_lines(env)])
    assert [x.text for x in seeded.lines] == [s.text for s in SCRIPT[:2]]
    again.carry = seeded.carry
    later = [ScriptedLine(500, 1_500, "After the restart.")]
    await run_captions(audio(6, start_ms=5_000), ScriptedAsr(later), again, seeded)
    await again.pause()
    assert out.groups() == [2]  # slice 1 was partly published by the old process: never continued, never rewritten
    carry = out.envelopes(2)[0].body  # the line said inside slice 1 was not published; slice 2's carry-in has it
    assert isinstance(carry, CaptionsCarry)
    assert [x.text for x in carry.lines] == [SCRIPT[1].text, "After the restart."]
    assert carry.lines[1].id > carry.lines[0].id


def test_a_stale_or_broken_state_file_is_ignored(tmp_path: Path) -> None:
    path = tmp_path / "s.json"
    assert statefile.load_captions(path) is None
    path.write_text("{", encoding="utf-8")
    assert statefile.load_captions(path) is None
    statefile.save(path, CaptionsCore("en").state())
    assert statefile.load_captions(path) is not None
    assert statefile.load_captions(path, max_age_s=-1) is None


async def test_translate_outline_and_describe_follow_the_captions(tmp_path: Path) -> None:
    cap = await captions_out(tmp_path)

    llm = FakeLlm()
    tr, tr_out = sliced(tmp_path / "tr", "translate-tr", llm=llm)
    core = TranslateCore("tr")
    tr.carry = core.carry
    await run_translate(replay(cap), llm, tr, core)
    await tr.pause()
    lines = [e.body.line for e in tr_out.envelopes() if e.kind == "item"]
    assert lines[0].text.startswith("[tr] Media over Quick") and lines[0].start_ms == 0
    assert llm.usage.requests == 3 and tr_out.groups() == [0, 1]  # each line in the slice open when it was made

    llm2 = FakeLlm()
    ol, ol_out = snapshot_track(tmp_path / "ol")
    ticks = iter(range(0, 10**9, 70_000))
    await run_outline(replay(cap), llm2, ol, OutlineCore("en"), clock=lambda: next(ticks))
    revisions = ol_out.envelopes()
    assert revisions and all(e.kind == "snapshot" and len(ol_out.envelopes(e.slice)) == 1 for e in revisions)
    assert isinstance(revisions[-1].body, OutlineSnapshot) and revisions[-1].body.recap
    assert ol.seed() == revisions[-1]  # what a restarted chapters agent carries on from

    llm3 = FakeLlm()
    sl, sl_out = sliced(tmp_path / "sl", "describe", llm=llm3)
    slides = SlidesCore("en")
    sl.carry = slides.carry

    async def frames() -> AsyncIterator[SlideFrame]:
        # Slide 3 shows slide 1's image again: it reuses the description instead of paying for it twice.
        for i, image in ((1, b"one"), (1, b"one"), (2, b"two"), (3, b"one")):
            yield SlideFrame(id=i, at_ms=i * 3000, mime="image/png", data_b64=base64.b64encode(image).decode())

    await run_describe(frames(), llm3, sl, slides)
    await sl.pause()
    notes = [e.body.slide for e in sl_out.envelopes() if isinstance(e.body, SlideItem)]
    assert [n.id for n in notes] == [1, 2, 3] and notes[2].description == notes[0].description
    assert llm3.usage.requests == 2
    # Each slice opens with the slide on screen when it starts: slide 2 shows at 6 s, inside slice 1 (4-8 s).
    assert [getattr(sl_out.envelopes(k)[0].body, "slide", None) for k in (1, 2)] == [notes[0], notes[1]]


async def test_failing_model_does_not_stop_the_track(tmp_path: Path) -> None:
    class Flaky(FakeLlm):
        async def translate(self, text: str, *, lang: str, context: Any) -> str:
            if "Agents" in text:
                raise RuntimeError("model down")
            return await super().translate(text, lang=lang, context=context)

    cap = await captions_out(tmp_path)
    tr, out = sliced(tmp_path / "tr", "translate-tr")
    core = TranslateCore("tr")
    tr.carry = core.carry
    await run_translate(replay(cap), Flaky(), tr, core)
    assert len([e for e in out.envelopes() if e.kind == "item"]) == 2


async def test_asr_opens_on_first_audio_and_reopens_after_a_failure(tmp_path: Path) -> None:
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

    provider = Provider()
    track, out = sliced(tmp_path)
    core = CaptionsCore("en")
    track.carry = core.carry
    await run_captions(audio(3, start_ms=5_000), provider, track, core)  # the talk was 5 s in when it started
    assert provider.offsets == [5_000, 6_500]  # first chunk's start; then the chunk after the failure at 6.5 s
    assert [x.text for x in core.lines] == ["to 6000", "to 7000", "to 8000"]
    assert out.groups() == [1, 2]
