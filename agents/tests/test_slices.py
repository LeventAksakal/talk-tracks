import asyncio
from collections.abc import AsyncIterator
from pathlib import Path

import numpy as np
import pytest
from numpy.typing import NDArray

from talk_tracks.archive.slices import END_OF_TRACK
from talk_tracks.asr.scripted import ScriptedAsr, ScriptedLine
from talk_tracks.contracts import (
    ENVELOPE,
    AgentInfo,
    CaptionItem,
    CaptionLine,
    CaptionsCarry,
    Envelope,
    OutlineSnapshot,
    TranslationCarry,
    Usage,
)
from talk_tracks.llm.fake import FakeLlm
from talk_tracks.llm.ledger import BudgetExceededError, RoomCap, SpendLedger
from talk_tracks.runtime import backfill_captions, backfill_translate
from talk_tracks.slicing import MediaClock, envelopes_of

from .slicekit import sliced, snapshot_track, still_clock

EMPTY = CaptionsCarry(lang="en", lines=[])


def item(i: int, end_ms: int) -> CaptionItem:
    return CaptionItem(
        lang="en", line=CaptionLine(id=i, start_ms=max(0, end_ms - 500), end_ms=end_ms, text=f"line {i}"), final=True
    )


def test_the_media_clock_runs_on_then_stops() -> None:
    now = [0.0]
    clock = MediaClock(hold_s=8, clock=lambda: now[0])
    assert clock.now() is None
    clock.observe(10_000)
    now[0] = 2.5
    assert clock.now() == 12_500
    clock.observe(11_000)  # an input that lags the clock does not step it back
    assert clock.now() == 12_500
    now[0] = 11.0
    assert clock.now() is None  # the inputs are quiet: the speaker left


async def test_slices_follow_the_clock_and_end_on_time(tmp_path: Path) -> None:
    track, out = sliced(tmp_path)
    track.clock.observe(1_000)
    await track.item(item(1, 1_000))
    track.clock.observe(3_900)
    await track.tick()
    assert out.ended == []
    track.clock.observe(4_000)
    await track.tick()  # no item needed: the slice closes when its time is over
    assert out.ended == [0] and track.open_slice == 1
    assert [(g, o) for g, o, _ in out.objects] == [(0, 0), (0, 1), (1, 0)]
    await track.pause()
    assert out.ended == [0, 1] and track.open_slice is None
    track.clock.observe(9_000)
    await track.tick()
    assert track.open_slice is None  # paused: an idle agent produces no slices
    await track.item(item(2, 9_000))
    assert track.open_slice == 2


async def test_a_capped_track_keeps_slicing_with_capped_carry_ins_only(tmp_path: Path) -> None:
    track, out = sliced(tmp_path)
    track.clock.observe(100)
    await track.item(item(1, 100))
    await track.cap()
    await track.item(item(2, 200))  # nothing more is published
    track.clock.observe(4_100)
    clock = asyncio.create_task(track.run_clock(every_s=0.01))
    await asyncio.sleep(0.05)
    clock.cancel()
    capped = out.envelopes(1)
    assert len(capped) == 1 and capped[0].kind == "carry" and capped[0].capped
    out.on = False  # nobody subscribes: no slices at all
    track.clock.observe(8_100)
    clock = asyncio.create_task(track.run_clock(every_s=0.01))
    await asyncio.sleep(0.05)
    clock.cancel()
    assert out.groups() == [0, 1]


async def test_end_of_track_closes_the_talk(tmp_path: Path) -> None:
    track, out = sliced(tmp_path)
    track.clock.observe(100)
    await track.item(item(1, 100))
    await track.end()
    stored = track.archive.read_local(0)
    assert out.track_ended and stored is not None and stored.end_of_track
    assert stored.objects[-1].status == END_OF_TRACK


async def test_a_slice_never_produced_is_back_filled_once_and_stored(tmp_path: Path) -> None:
    track, _ = sliced(tmp_path)
    track.clock.observe(20_000)
    calls: list[int] = []

    async def produce(k: int) -> tuple[CaptionsCarry, list[CaptionItem]]:
        calls.append(k)
        await asyncio.sleep(0.02)
        return EMPTY, [item(k * 4000, k * 4000 + 900)]

    first, second = await asyncio.gather(track.slice(3, produce, lambda: EMPTY), track.slice(3, produce, lambda: EMPTY))
    assert calls == [3] and first == second  # ten viewers rewinding to the same minute pay once
    assert first is not None and [e.kind for e in envelopes_of(first)] == ["carry", "item"]
    assert track.archive.read_local(3) == first
    assert await track.slice(3, produce, lambda: EMPTY) == first and calls == [3]  # later: an archive read
    assert await track.slice(9, produce, lambda: EMPTY) is None  # the future: nothing to back-fill yet
    assert await track.slice(2, None, lambda: EMPTY) is None  # an agent that cannot produce past slices

    track.clock = still_clock()  # the speaker is back, inside slice 3
    track.clock.observe(12_100)
    track.wake()
    await track.tick()
    assert track.open_slice is None  # live output never rewrites slice 3, which a back-fill made
    track.clock.observe(24_000)
    await track.tick()
    assert track.open_slice == 6


async def test_back_fill_at_the_cap_answers_an_empty_capped_group_and_stores_nothing(tmp_path: Path) -> None:
    track, _ = sliced(tmp_path)

    async def produce(k: int) -> tuple[CaptionsCarry, list[CaptionItem]]:
        raise BudgetExceededError("room cap reached", scope="room")

    found = await track.slice(1, produce, lambda: EMPTY)
    assert found is not None
    (only,) = envelopes_of(found)
    assert only.kind == "carry" and only.capped and only.body == EMPTY
    assert track.archive.read_local(1) is None  # a later, larger cap can still produce it


async def silence(start_ms: int, end_ms: int) -> AsyncIterator[tuple[NDArray[np.int16], int]]:
    for t in range(start_ms + 100, end_ms + 1, 100):
        yield np.zeros(1600, dtype=np.int16), t


SCRIPT = [ScriptedLine(500, 3_000, "one two"), ScriptedLine(3_500, 5_000, "three"), ScriptedLine(5_500, 7_000, "four")]


async def test_captions_back_fill_hears_the_slice_and_what_came_before() -> None:
    carry, items = await backfill_captions(1, ScriptedAsr(SCRIPT), "en", silence)
    assert [x.text for x in carry.lines] == ["one two"]
    assert [i.line.text for i in items] == ["three", "four"] and all(i.final for i in items)


async def test_translation_back_fill_fetches_captions_and_is_charged_to_the_room(tmp_path: Path) -> None:
    ledger = SpendLedger(tmp_path / "ledger.jsonl", 100).for_room("judge-a", RoomCap(0.05))
    llm = FakeLlm(ledger, usd_per_call=0.01)
    carry, items = await backfill_captions(1, ScriptedAsr(SCRIPT), "en", silence)
    info = AgentInfo(name="captions", label="c", model="fake")
    captions = [
        Envelope(agent=info, slice=1, kind="carry", at_ms=0, usage=Usage(), body=carry),
        *(Envelope(agent=info, slice=1, kind="item", at_ms=0, usage=Usage(), body=i) for i in items),
    ]
    fetched: list[int] = []

    async def fetch(k: int) -> list[Envelope] | None:
        fetched.append(k)
        return [ENVELOPE.validate_json(ENVELOPE.dump_json(e)) for e in captions] if k == 1 else None

    t_carry, t_items = await backfill_translate(1, llm, "tr", fetch, None)
    assert fetched == [1] and t_carry == TranslationCarry(lang="tr", lines=[])
    assert [i.line.id for i in t_items] == [i.line.id for i in items] and t_items[0].line.text.startswith("[tr] three")
    assert ledger.room_total() == pytest.approx(0.02)  # paid once per line, against the room's cap
    with pytest.raises(LookupError):
        await backfill_translate(4, llm, "tr", fetch, None)  # captions could not be had: not produced


async def test_outline_revisions_are_snapshot_groups_repeated_for_late_joiners(tmp_path: Path) -> None:
    track, out = snapshot_track(tmp_path)
    track.clock.observe(6_000)
    snap = OutlineSnapshot(lang="en", chapters=[], glossary=[], recap="so far")
    await track.publish(snap)
    await track.publish(snap.model_copy(update={"recap": "more"}))  # two revisions in one slice: two groups
    assert out.groups() == [1, 2] and out.ended == [1, 2]
    track.clock.observe(16_500)
    clock = asyncio.create_task(track.run_clock(every_s=0.01))
    await asyncio.sleep(0.05)
    clock.cancel()
    assert out.groups() == [1, 2, 4]  # repeated once the clock passed into a new slice, while subscribed
    latest = track.seed()
    assert latest is not None and isinstance(latest.body, OutlineSnapshot) and latest.body.recap == "more"
    found = await track.slice(2)
    assert found is not None and envelopes_of(found)[0].body == latest.body
