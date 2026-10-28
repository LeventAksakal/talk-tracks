import asyncio
from pathlib import Path

import pytest

from talk_tracks.archive.slices import END_OF_TRACK, SliceObject, TrackArchive
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
from talk_tracks.live_slices import MediaClock, Refused, envelopes_of
from talk_tracks.llm.fake import FakeLlm
from talk_tracks.llm.ledger import BudgetExceededError, RoomCap, SpendLedger
from talk_tracks.llm.queued import Priority
from talk_tracks.runtime import backfill_translate

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

    first, second = await asyncio.gather(track.slice(3, produce), track.slice(3, produce))
    assert calls == [3] and first == second  # ten viewers rewinding to the same minute pay once
    assert [e.kind for e in envelopes_of(first)] == ["carry", "item"]
    assert track.archive.read_local(3) == first
    assert await track.slice(3, produce) == first and calls == [3]  # later: an archive read
    with pytest.raises(Refused, match="not yet"):
        await track.slice(9, produce)  # the future
    with pytest.raises(Refused, match="does not back-fill"):
        await track.slice(2, None)  # an agent that does not back-fill

    track.clock = still_clock()  # the speaker is back, inside slice 3
    track.clock.observe(12_100)
    track.wake()
    await track.tick()
    assert track.open_slice is None  # live output never rewrites slice 3, which a back-fill made
    track.clock.observe(24_000)
    await track.tick()
    assert track.open_slice == 6


async def test_the_open_slice_is_served_as_far_as_it_has_got_and_never_back_filled(tmp_path: Path) -> None:
    track, _ = sliced(tmp_path)
    track.clock.observe(8_100)
    await track.item(item(1, 8_100))

    async def produce(k: int) -> tuple[CaptionsCarry, list[CaptionItem]]:
        raise AssertionError("never back-filled")

    found = await track.slice(2, produce)
    assert not found.complete and [e.kind for e in envelopes_of(found)] == ["carry", "item"]
    with pytest.raises(Refused, match="open slice"):
        await track.slice(3, produce)


async def test_no_back_fill_past_the_budget_or_the_cap_and_nothing_is_stored(tmp_path: Path) -> None:
    track, _ = sliced(tmp_path)

    async def produce(k: int) -> tuple[CaptionsCarry, list[CaptionItem]]:
        raise BudgetExceededError("back-fill budget reached", scope="backfill")

    async def no_input(k: int) -> tuple[CaptionsCarry, list[CaptionItem]]:
        raise LookupError("captions slice 1 is not in the archive")

    with pytest.raises(Refused, match="budget"):
        await track.slice(1, produce)
    with pytest.raises(Refused, match="no input"):
        await track.slice(1, no_input)
    assert track.archive.read_local(1) is None  # a later, larger budget can still produce it
    await track.cap()
    with pytest.raises(Refused, match="cap"):
        await track.slice(1, produce)


async def test_a_slice_another_process_wrote_first_is_served_as_that_copy(tmp_path: Path) -> None:
    track, _ = sliced(tmp_path)
    a = track.archive
    other = TrackArchive(a.room, a.agent, a.track, root=a.root)

    async def produce(k: int) -> tuple[CaptionsCarry, list[CaptionItem]]:
        theirs = Envelope(agent=track.info, slice=k, kind="carry", at_ms=1, usage=Usage(), body=EMPTY)
        other.write(k, SliceObject(object_id=0, payload=ENVELOPE.dump_json(theirs)))
        other.end_group(k)  # a replacement agent back-filled it meanwhile
        return EMPTY, [item(k * 4000, k * 4000 + 900)]

    found = await track.slice(1, produce)
    assert [e.kind for e in envelopes_of(found)] == ["carry"] and found == track.archive.read_local(1)


async def test_the_last_leave_finishes_the_open_slice_and_opens_no_new_one(tmp_path: Path) -> None:
    track, out = sliced(tmp_path)
    track.clock.observe(1_000)
    await track.item(item(1, 1_000))
    done = asyncio.create_task(track.finish())
    await asyncio.sleep(0.01)
    await track.item(item(2, 2_000))  # still slice 0: it goes in
    assert not done.done()
    track.clock.observe(4_100)
    await track.item(item(3, 4_100))  # slice 1 would open: it does not
    await asyncio.wait_for(done, 1)
    assert out.ended == [0] and track.open_slice is None and out.groups() == [0]
    stored = track.archive.read_local(0)
    assert stored is not None and stored.complete and len(envelopes_of(stored)) == 3
    await track.pause()
    track.clock.observe(8_100)
    await track.item(item(4, 8_100))  # a new viewer later: slices open again
    assert track.open_slice == 2


async def test_translation_back_fill_is_held_to_its_share_of_the_room_cap(tmp_path: Path) -> None:
    room = SpendLedger(tmp_path / "ledger.jsonl", 100).for_room("judge-a", RoomCap(0.08))
    llm = FakeLlm(room.for_backfill(), usd_per_call=0.01)  # back-fill budget: 25 % of $0.08
    info = AgentInfo(name="captions", label="c", model="fake")
    lines = [CaptionLine(id=4_000 + i, start_ms=4_000 + i, end_ms=4_500 + i, text=f"line {i}") for i in range(3)]
    captions = [
        Envelope(agent=info, slice=1, kind="carry", at_ms=0, usage=Usage(), body=EMPTY),
        *(
            Envelope(
                agent=info,
                slice=1,
                kind="item",
                at_ms=0,
                usage=Usage(),
                body=CaptionItem(lang="en", line=x, final=True),
            )
            for x in lines[:2]
        ),
    ]
    t_carry, t_items = await backfill_translate(llm, "tr", captions, None)
    assert t_carry == TranslationCarry(lang="tr", lines=[])
    assert [i.line.id for i in t_items] == [4_000, 4_001] and t_items[0].line.text.startswith("[tr] line 0")
    assert room.room_total() == pytest.approx(0.02)  # each call reserved, then settled to its cost
    one_more = [*captions, captions[-1].model_copy(update={"body": CaptionItem(lang="en", line=lines[2], final=True)})]
    with pytest.raises(BudgetExceededError, match="back-fill"):
        await backfill_translate(llm, "tr", one_more, None)
    room.check(0.05)  # live work still has the rest of the room's cap


async def test_back_fill_calls_queue_behind_live_ones() -> None:
    priority = Priority()
    order: list[str] = []
    release = asyncio.Event()

    async def live_call() -> None:
        async with priority.live():
            order.append("live starts")
            await release.wait()
            order.append("live ends")

    live = asyncio.create_task(live_call())
    await asyncio.sleep(0)
    backfill = asyncio.create_task(priority.wait_live_idle())
    await asyncio.sleep(0.01)
    assert not backfill.done()
    release.set()
    await asyncio.wait_for(backfill, 1)
    await live
    assert order == ["live starts", "live ends"]


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
    assert envelopes_of(found)[0].body == latest.body
    with pytest.raises(Refused):
        await track.slice(3)
