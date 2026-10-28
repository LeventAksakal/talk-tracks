import base64
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from talk_tracks.asr.base import AsrEvent, AsrFinal, AsrSession
from talk_tracks.asr.scripted import ScriptedAsr, ScriptedLine
from talk_tracks.contracts import OutlineObject, RecapData, SlideFrame
from talk_tracks.cores.captions import CaptionsCore
from talk_tracks.cores.outline import OutlineCore
from talk_tracks.cores.slides import SlidesCore
from talk_tracks.cores.translate import TranslateCore
from talk_tracks.llm.fake import FakeLlm
from talk_tracks.records import cues_of, slides_of
from talk_tracks.runtime import CaptionsObject, captions_object, run_captions, run_describe, run_outline, run_translate

from .slicekit import ListOut, objects, sliced, snapshot_track

SCRIPT = [
    ScriptedLine(0, 2_000, "Media over Quick lets a relay fan out named tracks."),
    ScriptedLine(2_500, 4_000, "Agents are ordinary publishers."),
    ScriptedLine(4_500, 6_000, "A viewer subscribes only to the tracks it wants."),
]


async def audio(seconds: float, start_ms: int = 0) -> AsyncIterator[tuple[NDArray[np.int16], int]]:
    for i in range(int(seconds * 10)):
        yield np.zeros(1600, dtype=np.int16), start_ms + (i + 1) * 100


async def replay(out: ListOut) -> AsyncIterator[CaptionsObject]:
    """What a downstream agent reads from a captions track, in order."""
    for group, object_id, payload in out.objects:
        yield captions_object(group, object_id, payload)


def finals(out: ListOut) -> list[str]:
    """The final cues published, carry-ins left out."""
    return [c.text for _, o, p in out.objects if o > 0 for c in cues_of(p)[1] if c.final]


async def captions_out(tmp_path: Path) -> ListOut:
    track, out = sliced(tmp_path / "cap")
    core = CaptionsCore("en")
    track.carry = core.carry
    await run_captions(audio(7), ScriptedAsr(SCRIPT), track, core)
    await track.pause()
    return out


async def test_captions_in_slices_with_a_carry_in_then_cues(tmp_path: Path) -> None:
    track, out = sliced(tmp_path)
    core = CaptionsCore("en")
    track.carry = core.carry
    await run_captions(audio(7), ScriptedAsr(SCRIPT), track, core)
    await track.pause()

    assert out.groups() == [0, 1] and out.ended == [0, 1]  # room time 0-4 s, 4-7 s; each closed with End of Group
    first, second = objects(out.payloads(0)), objects(out.payloads(1))
    assert first[0] == (None, [])  # nothing before the talk
    assert all(len(cues) == 1 for _, cues in first[1:])  # one record per later object
    assert finals(out) == [line.text for line in SCRIPT]  # each final once
    assert any(not c.final for _, cues in first for c in cues)  # interim revisions are records too
    assert [c.text for c in second[0][1]] == [SCRIPT[0].text]  # slice 1 opens before line 2, final at 4 s, lands
    assert [o for g, o, _ in out.objects if g == 1][:2] == [0, 1]  # object 0 is the carry-in, records follow

    for k in (0, 1):  # the record is byte for byte what went live, ending with End of Group
        stored = track.archive.read_local(k)
        assert stored is not None and stored.complete
        assert [o.payload for o in stored.objects if o.payload] == out.payloads(k)


async def test_a_restarted_agent_starts_at_the_next_slice_and_keeps_its_cues(tmp_path: Path) -> None:
    track, _ = sliced(tmp_path)
    core = CaptionsCore("en")
    track.carry = core.carry
    await run_captions(audio(5), ScriptedAsr(SCRIPT[:2]), track, core)  # killed 5 s in, inside slice 1
    track.archive.close()

    again, out = sliced(tmp_path, marks_from=True)  # same name, same archive
    seeded = CaptionsCore("en", cues=[c for p in again.seed_objects() for c in cues_of(p)[1]])
    assert [c.text for c in seeded.carry()] == [s.text for s in SCRIPT[:2]]
    again.carry = seeded.carry
    later = [ScriptedLine(500, 1_500, "After the restart.")]
    await run_captions(audio(6, start_ms=5_000), ScriptedAsr(later), again, seeded)
    await again.pause()
    assert out.groups() == [2]  # slice 1 was partly published by the old process: never continued, never rewritten
    note, carry = objects(out.payloads(2))[
        0
    ]  # the cue said inside slice 1 was not published; slice 2's carry-in has it
    assert note is None  # it has heard everything since 5.1 s, so slice 2 is whole
    assert [c.text for c in carry] == [SCRIPT[1].text, "After the restart."]
    assert int(carry[1].id) > int(carry[0].id)


async def test_translate_outline_and_describe_follow_the_captions(tmp_path: Path) -> None:
    cap = await captions_out(tmp_path)

    llm = FakeLlm()
    tr, tr_out = sliced(tmp_path / "tr", "translate-tr")
    core = TranslateCore("tr")
    tr.carry = core.carry
    await run_translate(replay(cap), llm, tr, core)
    await tr.pause()
    made = [c for p in tr_out.payloads() for c in cues_of(p)[1]][: len(SCRIPT)]
    source = {c.id: c for p in cap.payloads() for c in cues_of(p)[1] if c.final}
    assert made[0].text.startswith("[tr] Media over Quick") and made[0].start == 0
    assert all(c.id in source and (c.start, c.end) == (source[c.id].start, source[c.id].end) for c in made)
    assert llm.usage.requests == 3 and tr_out.groups() == [0, 1]  # each cue in the slice open when it was made

    llm2 = FakeLlm()
    ol, ol_out = snapshot_track(tmp_path / "ol")
    ticks = iter(range(0, 10**9, 70_000))
    await run_outline(replay(cap), llm2, ol, OutlineCore("en"), clock=lambda: next(ticks))
    revisions = ol_out.payloads()
    assert revisions and all(len(ol_out.payloads(g)) == 1 for g in ol_out.groups())
    last = OutlineObject.model_validate_json(revisions[-1]).root
    assert any(isinstance(r.data, RecapData) and r.data.text for r in last)
    assert ol.seed_object() == revisions[-1]  # what a restarted chapters agent carries on from

    llm3 = FakeLlm()
    sl, sl_out = sliced(tmp_path / "sl", "describe")
    slides = SlidesCore("en")
    sl.carry = slides.carry

    async def frames() -> AsyncIterator[tuple[SlideFrame, int]]:
        # Slide 3 shows slide 1's image again: it reuses the description instead of paying for it twice.
        for i, image in ((1, b"one"), (1, b"one"), (2, b"two"), (3, b"one")):
            frame = SlideFrame(
                id=i, at_ms=1_800_000_000_000 + i, mime="image/png", data_b64=base64.b64encode(image).decode()
            )
            yield frame, i * 3000

    await run_describe(frames(), llm3, sl, slides)
    await sl.pause()
    made_slides = [s for p in sl_out.payloads() for s in slides_of(p)[1]]
    unique = list({s.id: s for s in made_slides}.values())
    assert [s.id for s in unique] == [1, 2, 3] and unique[2].text == unique[0].text and unique[1].at == 6000
    assert llm3.usage.requests == 2
    # Each slice opens with the slide on screen when it starts: slide 2 shows at 6 s, inside slice 1 (4-8 s).
    assert [slides_of(sl_out.payloads(k)[0])[1] for k in (1, 2)] == [[unique[0]], [unique[1]]]


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
    assert len([p for _, o, p in out.objects if o > 0]) == 2


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
    assert finals(out) == ["to 6000", "to 7000", "to 8000"]
    assert out.groups() == [1, 2]


async def test_a_paused_scripted_asr_finalises_only_the_line_it_was_hearing() -> None:
    """Seen in the local run: closing the session on a pause made the whole two-hour demo script final at once."""
    from talk_tracks.asr.scripted import demo_script

    session = await ScriptedAsr(demo_script(["One two three four."])).open("en", offset_ms=10_000)
    await session.feed(np.zeros(1600, dtype=np.int16), 11_000)  # a third of the way into the first line
    closed = await session.close()
    assert [(e.text, e.start_ms) for e in closed if isinstance(e, AsrFinal)] == [("One two", 10_000)]
