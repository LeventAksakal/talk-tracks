import asyncio
import json
from collections.abc import AsyncGenerator, AsyncIterator
from pathlib import Path

import numpy as np
import pytest
from numpy.typing import NDArray

from talk_tracks.asr.base import AsrEvent, AsrFinal, AsrSession
from talk_tracks.contracts import CaptionLine, CaptionsState
from talk_tracks.demand import Gate, gated
from talk_tracks.llm.fake import FakeLlm
from talk_tracks.llm.ledger import BudgetExceededError, RoomCap, SpendLedger, room_cap
from talk_tracks.rooms import RoomPolicy, serve_rooms
from talk_tracks.runtime import run_captions, run_translate

from .test_runtime import ListSink, publisher


class Switch:
    def __init__(self) -> None:
        self.on = False

    def __call__(self) -> bool:
        return self.on


def fast_gate(switch: Switch, grace_s: float = 0.05) -> Gate:
    return Gate(switch, grace_s=grace_s, poll_s=0.005)


async def test_gate_waits_out_the_grace_period() -> None:
    switch = Switch()
    gate = fast_gate(switch, grace_s=0.1)
    switch.on = True
    await asyncio.wait_for(gate.wait_wanted(), 1)
    switch.on = False
    idle = asyncio.ensure_future(gate.wait_unwanted())
    await asyncio.sleep(0.05)
    switch.on = True  # back within the grace period (a page reload): still wanted
    await asyncio.sleep(0.1)
    assert not idle.done()
    switch.on = False
    await asyncio.wait_for(idle, 1)


async def test_gated_input_opens_on_a_subscriber_and_closes_without_one() -> None:
    switch = Switch()
    opened: list[int] = []
    closed: list[int] = []

    def open_input() -> AsyncGenerator[int]:
        n = len(opened)
        opened.append(n)

        async def items() -> AsyncGenerator[int]:
            try:
                i = 0
                while True:
                    await asyncio.sleep(0.005)
                    yield n * 1000 + i
                    i += 1
            finally:
                closed.append(n)  # where the real input unsubscribes upstream

        return items()

    out: list[int | None] = []

    async def consume() -> None:
        async for item in gated(fast_gate(switch), open_input, "test"):
            out.append(item)

    task = asyncio.create_task(consume())
    await asyncio.sleep(0.05)
    assert opened == [] and out == []  # nobody subscribed: the input is never opened

    switch.on = True
    await asyncio.sleep(0.05)
    switch.on = False
    await asyncio.sleep(0.15)
    assert opened == [0] and closed == [0]
    assert out[-1] is None  # the pause is passed on
    paused_at = len(out)

    switch.on = True
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert opened == [0, 1] and closed == [0, 1]
    assert all(isinstance(x, int) and x >= 1000 for x in out[paused_at:])


async def test_captions_close_the_asr_session_on_a_pause_and_reopen_after() -> None:
    class Session:
        def __init__(self, log: list[str]) -> None:
            self.log = log

        async def feed(self, pcm16k: NDArray[np.int16], end_ms: int) -> list[AsrEvent]:
            return [AsrFinal(f"to {end_ms}", end_ms - 100, end_ms)] if end_ms % 500 == 0 else []

        async def close(self) -> list[AsrEvent]:
            self.log.append("close")
            return []

    class Provider:
        def __init__(self) -> None:
            self.log: list[str] = []

        async def open(self, language: str, offset_ms: int = 0) -> AsrSession:
            self.log.append(f"open {offset_ms}")
            return Session(self.log)

    async def audio() -> AsyncIterator[tuple[NDArray[np.int16], int] | None]:
        for end_ms in range(100, 1100, 100):
            yield np.zeros(1600, dtype=np.int16), end_ms
        yield None  # nobody reads the captions: nothing is sent, so nothing is paid
        for end_ms in range(5100, 6100, 100):
            yield np.zeros(1600, dtype=np.int16), end_ms

    provider, sink = Provider(), ListSink()
    await run_captions(audio(), provider, publisher("captions", sink), "en")
    assert provider.log == ["open 0", "close", "open 5000", "close"]
    assert [line.id for line in sink.envelopes()[-1].state.lines] == [0, 1, 2, 3]  # ids carry on over the pause


def captions_with(n: int) -> CaptionsState:
    return CaptionsState(lang="en", lines=[CaptionLine(id=i, start_ms=i, end_ms=i, text=f"line {i}") for i in range(n)])


async def test_translation_switched_on_mid_talk_starts_from_now() -> None:
    async def states() -> AsyncIterator[CaptionsState | None]:
        yield captions_with(10)  # 10 lines already said when someone first wants the translation
        yield captions_with(11)
        yield None
        yield captions_with(20)  # wanted again, 9 lines later
        yield captions_with(21)

    sink, llm = ListSink(), FakeLlm()
    await run_translate(states(), llm, publisher("translate-tr", sink, llm), "tr")
    assert [line.id for line in sink.envelopes()[-1].state.lines] == [8, 9, 10, 18, 19, 20]
    assert llm.usage.requests == 6


def test_room_and_group_caps(tmp_path: Path) -> None:
    ledger = SpendLedger(tmp_path / "ledger.jsonl", 100)
    group = RoomCap(2, "judges-1", 3)
    a, b = ledger.for_room("judge-a", group), ledger.for_room("judge-b", group)
    a.record(1.5, "chat")
    a.check(0.5)
    with pytest.raises(BudgetExceededError) as room:
        a.check(0.6)
    assert room.value.scope == "room"
    b.record(1.0, "chat")
    with pytest.raises(BudgetExceededError) as total:
        b.check(0.6)  # b's own cap has room, but all judge rooms together would pass $3
    assert total.value.scope == "group"
    ledger.for_room("live", RoomCap(2)).check(1.9)  # another room is untouched
    assert ledger.total() == 2.5 and ledger.room_total("judge-a") == 1.5 and ledger.group_total("judges-1") == 2.5
    first = json.loads((tmp_path / "ledger.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert first["room"] == "judge-a" and first["group"] == "judges-1"


def test_the_ceiling_still_holds_over_every_room(tmp_path: Path) -> None:
    ledger = SpendLedger(tmp_path / "ledger.jsonl", 1)
    ledger.record(0.9, "carried over from the laptop")
    with pytest.raises(BudgetExceededError) as exc:
        ledger.for_room("live", RoomCap(5)).check(0.2)
    assert exc.value.scope == "ceiling"


def test_room_cap_comes_from_its_judge_batch(tmp_path: Path) -> None:
    batch = {"group": "judges-1", "room_usd": 2, "total_usd": 10, "rooms": ["judge-a", "judge-b"]}
    (tmp_path / "judges-1.json").write_text(json.dumps(batch), encoding="utf-8")
    (tmp_path / "broken.json").write_text("{", encoding="utf-8")
    assert room_cap("judge-b", tmp_path) == RoomCap(2, "judges-1", 10)
    assert room_cap("live", tmp_path, default_usd=5) == RoomCap(5)
    assert room_cap("live", None) == RoomCap(2)


async def test_at_its_cap_an_agent_stops_paying_and_says_so(tmp_path: Path) -> None:
    ledger = SpendLedger(tmp_path / "ledger.jsonl", 100).for_room("judge-a", RoomCap(0.03))
    llm = FakeLlm(ledger, usd_per_call=0.01)

    async def states() -> AsyncIterator[CaptionsState | None]:
        yield captions_with(0)
        for n in range(1, 6):
            yield captions_with(n)

    sink = ListSink()
    await run_translate(states(), llm, publisher("translate-tr", sink, llm), "tr")
    last = sink.envelopes()[-1]
    assert [line.id for line in last.state.lines] == [0, 1, 2]
    assert llm.usage.requests == 3
    assert last.agent.label == "translate-tr (paused: this room reached its spend cap)"
    assert ledger.room_total() == pytest.approx(0.03)


def test_room_policy() -> None:
    any_room = RoomPolicy("*", exclude=["demo", ""])
    assert any_room.wants("judge-a") and not any_room.wants("demo")
    listed = RoomPolicy("live, judge-a")
    assert listed.wants("judge-a") and not listed.wants("other")


async def test_rooms_are_served_while_their_speaker_is_on_air() -> None:
    events: asyncio.Queue[tuple[str, bool]] = asyncio.Queue()
    serving: list[str] = []
    stopped: list[str] = []

    async def on_air() -> AsyncIterator[tuple[str, bool]]:
        while True:
            yield await events.get()

    async def serve(room: str) -> None:
        serving.append(room)
        try:
            await asyncio.Event().wait()
        finally:
            stopped.append(room)

    task = asyncio.create_task(serve_rooms(on_air(), RoomPolicy("*", ["demo"]), serve, linger_s=0.1))
    for event in [("a", True), ("demo", True), ("b", True), ("a", True)]:
        events.put_nowait(event)
    await asyncio.sleep(0.02)
    assert serving == ["a", "b"]  # the demo room is never served; a second announce changes nothing

    events.put_nowait(("a", False))
    events.put_nowait(("b", False))
    await asyncio.sleep(0.02)
    events.put_nowait(("b", True))  # b's speaker reloaded within the linger: b keeps its agent
    await asyncio.sleep(0.2)
    assert stopped == ["a"]

    events.put_nowait(("a", True))  # a's speaker is back after the linger: a fresh agent
    await asyncio.sleep(0.02)
    assert serving == ["a", "b", "a"]
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert sorted(stopped) == ["a", "a", "b"]


async def test_a_failing_room_stops_the_process() -> None:
    async def on_air() -> AsyncIterator[tuple[str, bool]]:
        yield "a", True
        await asyncio.Event().wait()
        yield "never", True

    async def serve(room: str) -> None:
        raise ConnectionError("relay session closed")

    with pytest.raises(ConnectionError):
        await asyncio.wait_for(serve_rooms(on_air(), RoomPolicy("*"), serve), 1)
