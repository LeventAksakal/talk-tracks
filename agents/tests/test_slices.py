import asyncio
from pathlib import Path

import pytest

from talk_tracks.archive.slices import END_OF_TRACK, SliceObject, TrackArchive
from talk_tracks.contracts import (
    CarryNote,
    ChapterData,
    Cue,
    CueObject,
    OutlineObject,
    OutlineRecord,
    RecapData,
)
from talk_tracks.live_slices import Refused, Watermark, payloads
from talk_tracks.llm.fake import FakeLlm
from talk_tracks.llm.ledger import BudgetExceededError, RoomCap, SpendLedger
from talk_tracks.llm.queued import Priority
from talk_tracks.records import Data, carry_in, encode, record
from talk_tracks.runtime import backfill_translate

from .slicekit import objects, sliced, snapshot_track, still_clock


def cue(i: int, end_ms: int, *, final: bool = True) -> Cue:
    start = max(0, end_ms - 500)
    return Cue(start=start, end=end_ms, id=str(start + i), text=f"line {i}", final=final)


def produced(*cues: Cue) -> tuple[list[Data], list[Data]]:
    return [], list(cues)


def test_the_watermark_is_the_newest_input_and_goes_stale() -> None:
    now = [0.0]
    edge: list[int | None] = [None]
    clock = Watermark(hold_s=8, edge=lambda: edge[0], clock=lambda: now[0])
    assert clock.now() is None and clock.room_edge() is None
    edge[0] = 30_000
    assert clock.now() is None and clock.room_edge() == 30_000  # idle: the teacher's newest media is the edge
    clock.observe(10_000)
    now[0] = 2.5
    assert clock.now() == 10_000  # never the agent's own wall clock running on
    clock.observe(9_000)  # an input that lags does not step it back
    assert clock.now() == 10_000
    now[0] = 11.0
    assert clock.now() is None  # the inputs are quiet: the speaker left


async def test_slices_follow_the_watermark_and_object_0_is_the_carry_in(tmp_path: Path) -> None:
    last = cue(0, 900)
    track, out = sliced(tmp_path, carry=lambda: [last])
    track.clock.observe(1_000)
    await track.item(cue(1, 1_000, final=False))
    track.clock.observe(3_900)
    await track.tick()
    assert out.ended == []
    track.clock.observe(4_000)
    await track.tick()  # no record needed: the slice closes when the watermark leaves it
    assert out.ended == [0] and track.open_slice == 1
    assert [(g, o) for g, o, _ in out.objects] == [(0, 0), (0, 1), (1, 0)]
    assert objects(out.payloads(0)) == [(None, [last]), (None, [cue(1, 1_000, final=False)])]
    assert CueObject.model_validate_json(out.payloads(0)[0]).root[0].m == last.start  # m is the cue's start
    await track.pause()
    assert out.ended == [0, 1] and track.open_slice is None
    track.clock.observe(9_000)
    await track.tick()
    assert track.open_slice is None  # paused: an idle agent produces no slices
    await track.item(cue(2, 9_000))
    assert track.open_slice == 2


async def test_captions_mark_where_they_started_inside_a_slice(tmp_path: Path) -> None:
    track, out = sliced(tmp_path, marks_from=True)
    track.clock.observe(5_300)
    await track.item(cue(1, 5_300))
    track.clock.observe(8_000)
    await track.tick()
    assert objects(out.payloads(1))[0][0] == CarryNote(from_=5_300)  # nothing before 5.3 s in slice 1
    assert objects(out.payloads(2))[0][0] is None  # later slices are whole
    await track.pause()
    track.clock.observe(20_100)
    await track.item(cue(2, 20_100))
    assert objects(out.payloads(5))[0][0] == CarryNote(from_=20_100)  # each run starts afresh


async def test_a_capped_track_keeps_slicing_with_capped_carry_ins_only(tmp_path: Path) -> None:
    track, out = sliced(tmp_path)
    track.clock.observe(100)
    await track.item(cue(1, 100))
    await track.cap()
    await track.item(cue(2, 200))  # nothing more is published
    track.clock.observe(4_100)
    clock = asyncio.create_task(track.run_clock(every_s=0.01))
    await asyncio.sleep(0.05)
    clock.cancel()
    assert objects(out.payloads(1)) == [(CarryNote(capped=True), [])]
    out.on = False  # nobody subscribes: no slices at all
    track.clock.observe(8_100)
    clock = asyncio.create_task(track.run_clock(every_s=0.01))
    await asyncio.sleep(0.05)
    clock.cancel()
    assert out.groups() == [0, 1]


async def test_end_of_track_closes_the_room(tmp_path: Path) -> None:
    track, out = sliced(tmp_path)
    track.clock.observe(100)
    await track.item(cue(1, 100))
    await track.end()
    stored = track.archive.read_local(0)
    assert out.track_ended and stored is not None and stored.end_of_track
    assert stored.objects[-1].status == END_OF_TRACK


async def test_a_slice_never_produced_is_back_filled_once_and_stored(tmp_path: Path) -> None:
    track, _ = sliced(tmp_path)
    track.clock.observe(20_000)
    calls: list[int] = []

    async def produce(k: int) -> tuple[list[Data], list[Data]]:
        calls.append(k)
        await asyncio.sleep(0.02)
        return produced(cue(k, k * 4000 + 900))

    first, second = await asyncio.gather(track.slice(3, produce), track.slice(3, produce))
    assert calls == [3] and first == second  # ten viewers rewinding to the same minute pay once
    assert objects(first) == [(None, []), (None, [cue(3, 12_900)])] and track.stats.backfills == 1
    assert track.archive.read_local(3) == first
    assert await track.slice(3, produce) == first and calls == [3]  # later: an archive read
    with pytest.raises(Refused, match="open slice or later"):
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


async def test_an_idle_agent_takes_its_edge_from_the_teacher(tmp_path: Path) -> None:
    track, _ = sliced(tmp_path)
    with pytest.raises(Refused, match="room time is not known"):
        await track.slice(1, lambda k: asyncio.sleep(0, produced()))
    edge = [9_000]
    track.clock = still_clock(lambda: edge[0])
    with pytest.raises(Refused, match="open slice or later"):
        await track.slice(2, lambda k: asyncio.sleep(0, produced()))
    assert objects(await track.slice(1, lambda k: asyncio.sleep(0, produced(cue(1, 4_900))))) == [
        (None, []),
        (None, [cue(1, 4_900)]),
    ]


async def test_one_back_fill_at_a_time_two_waiting_and_then_busy(tmp_path: Path) -> None:
    track, _ = sliced(tmp_path)
    track.clock.observe(40_000)
    release = asyncio.Event()
    running: list[int] = []

    async def produce(k: int) -> tuple[list[Data], list[Data]]:
        running.append(k)
        await release.wait()
        return produced(cue(k, k * 4000 + 900))

    queued = [asyncio.create_task(track.slice(k, produce)) for k in (1, 2, 3)]
    await asyncio.sleep(0.01)
    assert running == [1]  # one at a time
    with pytest.raises(Refused, match="busy"):
        await track.slice(4, produce)
    release.set()
    done = await asyncio.gather(*queued)
    assert running == [1, 2, 3] and [objects(s)[1][1][0].start for s in done] == [4_400, 8_400, 12_400]


async def test_the_open_slice_is_served_as_far_as_it_has_got_and_never_back_filled(tmp_path: Path) -> None:
    track, _ = sliced(tmp_path)
    track.clock.observe(8_100)
    await track.item(cue(1, 8_100))

    async def produce(k: int) -> tuple[list[Data], list[Data]]:
        raise AssertionError("never back-filled")

    found = await track.slice(2, produce)
    assert not found.complete and objects(found) == [(None, []), (None, [cue(1, 8_100)])]
    with pytest.raises(Refused, match="open slice"):
        await track.slice(3, produce)


async def test_no_back_fill_past_the_budget_or_the_cap_and_nothing_is_stored(tmp_path: Path) -> None:
    track, _ = sliced(tmp_path)
    track.clock.observe(20_000)

    async def produce(k: int) -> tuple[list[Data], list[Data]]:
        raise BudgetExceededError("back-fill budget reached", scope="backfill")

    async def no_input(k: int) -> tuple[list[Data], list[Data]]:
        raise LookupError("items slice 1: not found")

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
    track.clock.observe(20_000)
    a = track.archive
    other = TrackArchive(a.room, a.agent, a.track, root=a.root)

    async def produce(k: int) -> tuple[list[Data], list[Data]]:
        other.write(k, SliceObject(object_id=0, payload=carry_in(k, [])))
        other.end_group(k)  # a replacement agent back-filled it meanwhile
        return produced(cue(k, k * 4000 + 900))

    found = await track.slice(1, produce)
    assert objects(found) == [(None, [])] and found == track.archive.read_local(1)
    assert track.stats.backfills == 0


async def test_the_last_leave_finishes_the_open_slice_and_opens_no_new_one(tmp_path: Path) -> None:
    track, out = sliced(tmp_path)
    track.clock.observe(1_000)
    await track.item(cue(1, 1_000))
    done = asyncio.create_task(track.finish())
    await asyncio.sleep(0.01)
    await track.item(cue(2, 2_000))  # still slice 0: it goes in
    assert not done.done()
    track.clock.observe(4_100)
    await track.item(cue(3, 4_100))  # slice 1 would open: it does not
    await asyncio.wait_for(done, 1)
    assert out.ended == [0] and track.open_slice is None and out.groups() == [0]
    stored = track.archive.read_local(0)
    assert stored is not None and stored.complete and len(payloads(stored)) == 3
    await track.pause()
    track.clock.observe(8_100)
    await track.item(cue(4, 8_100))  # a new viewer later: slices open again
    assert track.open_slice == 2


async def test_translation_back_fill_is_held_to_its_share_of_the_room_cap(tmp_path: Path) -> None:
    room = SpendLedger(tmp_path / "ledger.jsonl", 100).for_room("judge-a", RoomCap(0.08))
    llm = FakeLlm(room.for_backfill(), usd_per_call=0.01)  # back-fill budget: 25 % of $0.08
    cues = [
        Cue(start=4_000, end=4_400, id="4000", text="line 0", final=True),
        Cue(start=5_000, end=5_400, id="5000", text="line 2", final=True),
    ]
    interim = Cue(start=5_000, end=5_200, id="5000", text="li", rev=0, final=False)
    captions = [carry_in(1, [cue(0, 3_900)]), encode([record(cues[0])]), encode([record(interim)])]
    captions.append(encode([record(cues[1].model_copy(update={"rev": 1}))]))
    carry, made = await backfill_translate(llm, "tr", captions, [])
    assert carry == []
    assert [c.id for c in made] == ["4000", "5000"] and made[0].text.startswith("[tr] line 0")
    assert room.room_total() == pytest.approx(0.02)  # each call reserved, then settled to its cost
    one_more = [*captions, encode([record(Cue(start=6_000, end=6_400, id="6000", text="x", final=True))])]
    with pytest.raises(BudgetExceededError, match="back-fill"):
        await backfill_translate(llm, "tr", one_more, [])
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


async def test_outline_revisions_are_groups_repeated_for_late_joiners(tmp_path: Path) -> None:
    track, out = snapshot_track(tmp_path)
    track.clock.observe(6_000)
    chapter = OutlineRecord(m=0, data=ChapterData(id=0, start=0, title="Intro", summary="Why"))
    await track.publish([chapter, OutlineRecord(m=6_000, data=RecapData(text="so far"))])
    newer = [chapter, OutlineRecord(m=6_000, data=RecapData(text="more"))]
    await track.publish(newer)  # two revisions in one slice: two groups
    assert out.groups() == [1, 2] and out.ended == [1, 2]
    track.clock.observe(16_500)
    clock = asyncio.create_task(track.run_clock(every_s=0.01))
    await asyncio.sleep(0.05)
    clock.cancel()
    assert out.groups() == [1, 2, 4]  # repeated once room time passed into a new slice, while subscribed
    seed = track.seed_object()
    assert seed is not None and OutlineObject.model_validate_json(seed).root == newer
    found = await track.slice(2)
    assert payloads(found) == [seed]
    with pytest.raises(Refused):
        await track.slice(3)
