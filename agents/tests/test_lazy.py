import asyncio
import json
from collections.abc import AsyncGenerator, AsyncIterator
from pathlib import Path
from typing import Any, Literal

import numpy as np
import pytest
from numpy.typing import NDArray

from talk_tracks.asr.base import AsrEvent, AsrFinal, AsrSession
from talk_tracks.contracts import AgentInfo, CaptionItem, CaptionLine, CaptionsCarry, Envelope, TranslationItem, Usage
from talk_tracks.cores.captions import CaptionsCore
from talk_tracks.cores.translate import TranslateCore
from talk_tracks.demand import Gate, gated
from talk_tracks.llm.fake import FakeLlm
from talk_tracks.llm.ledger import BudgetExceededError, RoomCap, SpendLedger, room_cap
from talk_tracks.rooms import RoomPolicy, serve_rooms
from talk_tracks.runtime import run_captions, run_translate

from .slicekit import sliced


class Switch:
    def __init__(self) -> None:
        self.on = False

    def __call__(self) -> bool:
        return self.on


def fast_gate(switch: Switch, grace_s: float = 0.05, wake_s: float = 0.0) -> Gate:
    return Gate(switch, wake_s=wake_s, grace_s=grace_s, poll_s=0.005)


async def test_a_momentary_subscription_does_not_wake_the_agent() -> None:
    switch = Switch()
    gate = fast_gate(switch, wake_s=0.3)
    wanted = asyncio.ensure_future(gate.wait_wanted())
    for _ in range(3):  # three FETCH blips: the relay subscribes upstream for ~80 ms each time
        switch.on = True
        await asyncio.sleep(0.08)
        switch.on = False
        await asyncio.sleep(0.1)
    assert not wanted.done()

    switch.on = True  # a viewer that stays
    started = asyncio.get_running_loop().time()
    await asyncio.wait_for(wanted, 1)
    assert asyncio.get_running_loop().time() - started >= 0.29


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


async def test_captions_close_the_asr_session_on_a_pause_and_reopen_after(tmp_path: Path) -> None:
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

    provider = Provider()
    track, out = sliced(tmp_path)
    core = CaptionsCore("en")
    track.carry = core.carry
    await run_captions(audio(), provider, track, core)
    assert provider.log == ["open 0", "close", "open 5000", "close"]
    assert [line.id for line in core.lines] == [400, 900, 5400, 5900]  # ids carry on over the pause
    assert out.groups() == [0, 1] and out.ended == [0]  # the pause closed slice 0; nothing was produced while idle


def line(i: int) -> CaptionLine:
    return CaptionLine(id=i, start_ms=i * 1000, end_ms=i * 1000 + 900, text=f"line {i}")


def captions(kind: Literal["carry", "item"], *ids: int) -> Envelope:
    """An object of the captions track: a carry-in with these lines, or the final line ``ids[0]``."""
    k = max(ids) * 1000 // 4000
    info = AgentInfo(name="captions", label="c", model="fake")
    if kind == "carry":
        body: Any = CaptionsCarry(lang="en", lines=[line(i) for i in ids])
    else:
        body = CaptionItem(lang="en", line=line(ids[0]), final=True)
    return Envelope(agent=info, slice=k, kind=kind, at_ms=0, usage=Usage(), body=body)


async def test_translation_switched_on_mid_talk_starts_from_now(tmp_path: Path) -> None:
    async def objects() -> AsyncIterator[Envelope | None]:
        yield captions("carry", 8, 9)  # 10 lines already said when someone first wants the translation
        yield captions("item", 10)
        yield None
        yield captions("carry", 18, 19)  # wanted again, 9 lines later
        yield captions("item", 20)

    llm = FakeLlm()
    track, out = sliced(tmp_path, "translate-tr", llm=llm)
    core = TranslateCore("tr")
    track.carry = core.carry
    await run_translate(objects(), llm, track, core)
    assert [e.body.line.id for e in out.envelopes() if isinstance(e.body, TranslationItem)] == [8, 9, 10, 18, 19, 20]
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

    async def objects() -> AsyncIterator[Envelope | None]:
        for n in range(6):
            yield captions("item", n)

    track, out = sliced(tmp_path, "translate-tr", llm=llm)
    core = TranslateCore("tr")
    track.carry = core.carry
    await run_translate(objects(), llm, track, core)
    assert [e.body.line.id for e in out.envelopes() if isinstance(e.body, TranslationItem)] == [0, 1, 2]
    assert llm.usage.requests == 3 and track.capped
    track.clock.observe(8_000)
    await track.tick()  # the next slice says why the track is silent
    (carry,) = out.envelopes(2)
    assert carry.kind == "carry" and carry.capped
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
