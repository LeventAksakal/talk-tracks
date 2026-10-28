"""Every aiomoqt client is pinned to MoQT draft 18 (aiomoqt offers draft 22 first when left to choose).

aiomoqt has no Windows wheels, so ``talk_tracks.moq`` is imported here against a stub that records how the client
is built.
"""

import importlib
import re
import sys
import types
from pathlib import Path
from typing import Any, ClassVar

import pytest

SRC = Path(__file__).resolve().parents[1] / "src" / "talk_tracks"


class RecordingClient:
    made: ClassVar[list[dict[str, Any]]] = []

    def __init__(self, host: str, port: int, **kwargs: Any) -> None:
        RecordingClient.made.append({"host": host, "port": port, **kwargs})


@pytest.fixture
def moq(monkeypatch: pytest.MonkeyPatch) -> Any:
    agent = types.ModuleType("aiomoqt.agent")
    for name in ("AgentSession", "FetchSpec", "PublishSpec", "StartAt", "SubscribeSpec", "TrackRef"):
        setattr(agent, name, object)
    client = types.ModuleType("aiomoqt.client")
    client.MOQTClient = RecordingClient  # type: ignore[attr-defined]
    logger = types.ModuleType("aiomoqt.utils.logger")
    logger.set_log_level = lambda level: None  # type: ignore[attr-defined]
    data = types.ModuleType("aiomoqt.messages.data")
    data.FetchObject = object  # type: ignore[attr-defined]
    fetch = types.ModuleType("aiomoqt.messages.fetch")
    fetch._is_joining = lambda fetch_type: False  # type: ignore[attr-defined]
    quic = types.ModuleType("aiopquic.quic.configuration")
    quic.QuicConfiguration = types.SimpleNamespace  # type: ignore[attr-defined]
    for name, module in {
        "aiomoqt": types.ModuleType("aiomoqt"),
        "aiomoqt.agent": agent,
        "aiomoqt.client": client,
        "aiomoqt.messages": types.ModuleType("aiomoqt.messages"),
        "aiomoqt.messages.data": data,
        "aiomoqt.messages.fetch": fetch,
        "aiomoqt.utils": types.ModuleType("aiomoqt.utils"),
        "aiomoqt.utils.logger": logger,
        "aiopquic": types.ModuleType("aiopquic"),
        "aiopquic.quic": types.ModuleType("aiopquic.quic"),
        "aiopquic.quic.configuration": quic,
    }.items():
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.delitem(sys.modules, "talk_tracks.moq", raising=False)
    RecordingClient.made.clear()
    yield importlib.import_module("talk_tracks.moq")
    sys.modules.pop("talk_tracks.moq", None)


@pytest.mark.parametrize("url", ["moqt://relay:4443", "https://relay.example:443/anon"])
def test_relay_client_offers_only_draft_18(moq: Any, url: str) -> None:
    moq.relay_client(url, token="t")
    assert moq.DRAFT == 18
    assert RecordingClient.made[-1]["supported_drafts"] == 18


def test_agents_advertise_short_quic_timers(moq: Any) -> None:
    """A killed agent's session times out in 3 s, so its replacement is not stalled for 12 s (design, spike S8)."""
    moq.relay_client("moqt://relay:4443")
    made = RecordingClient.made[-1]
    assert made["configuration"].idle_timeout == 3.0 and made["configuration"].keep_alive_interval == 1.0
    assert made["keep_alive_interval"] == 1.0


def test_no_other_aiomoqt_client_is_built() -> None:
    """Every connection goes through ``moq.relay_client``, so the pin above covers them all."""
    builders = {
        path.relative_to(SRC).as_posix()
        for path in SRC.rglob("*.py")
        if re.search(r"\bMOQTClient\s*\(", path.read_text(encoding="utf-8"))
    }
    assert builders == {"moq.py"}
    assert len(re.findall(r"\bMOQTClient\s*\(", (SRC / "moq.py").read_text(encoding="utf-8"))) == 1


def test_until_closed_stops_the_work_when_cancelled(moq: Any) -> None:
    """SIGTERM cancels the agent: its work must stop before the track closes, or it keeps writing slices that a
    replacement then skips."""
    import asyncio

    async def scenario() -> bool:
        loop = asyncio.get_running_loop()
        relay = types.SimpleNamespace(closed=loop.create_future())
        stopped = asyncio.Event()

        async def work() -> None:
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()

        outer = asyncio.ensure_future(moq.until_closed(relay, work()))
        await asyncio.sleep(0)
        outer.cancel()
        with pytest.raises(asyncio.CancelledError):
            await outer
        return stopped.is_set()

    assert asyncio.run(scenario())


def test_until_closed_raises_when_the_relay_goes(moq: Any) -> None:
    import asyncio

    async def scenario() -> None:
        loop = asyncio.get_running_loop()
        relay = types.SimpleNamespace(closed=loop.create_future())
        loop.call_soon(relay.closed.set_result, "gone")
        await moq.until_closed(relay, asyncio.Event().wait())

    with pytest.raises(ConnectionError, match="gone"):
        asyncio.run(scenario())


class ClockReader:
    """A subscription that delivers ``payloads`` (then stays open), or nothing."""

    def __init__(self, payloads: list[bytes]) -> None:
        self.objects = [types.SimpleNamespace(payload=p) for p in payloads]
        self.done = False
        self.request_id = None

    async def read(self, n: int, **kw: float) -> list[Any]:
        import asyncio

        if not self.objects:
            await asyncio.sleep(kw["timeout"])
            return []
        return [self.objects.pop(0)]

    def drain(self) -> list[Any]:
        return []


class ClockRelay:
    """Audio subscriptions as given, and a room clock per subscription (None: the clock subscription is refused)."""

    def __init__(self, audio: list[tuple[int, bytes]], clocks: list[list[bytes] | None]) -> None:
        self.audio = audio
        self.clocks = clocks
        self.agent = types.SimpleNamespace(reader=self._reader, close_reader=self._unsubscribe)
        self.session = None

    async def _reader(self, spec: Any) -> ClockReader:
        payloads = self.clocks.pop(0)
        if payloads is None:
            raise RuntimeError("not found")
        return ClockReader(payloads)

    def _unsubscribe(self, *args: Any) -> None:
        pass

    async def subscriptions(self, namespace: str, track: str, *, idle_s: float | None = None) -> Any:
        for item in self.audio:
            yield item


class EchoAssembler:
    """Each payload is its own media end time in ms, as text."""

    def push(self, payload: bytes) -> list[tuple[Any, int]]:
        return [(b"pcm", int(payload))]

    def flush(self) -> list[tuple[Any, int]]:
        return []


def clock_json(offset_ms: int, session: str) -> bytes:
    return f'{{"epoch_ms": 1000, "offset_ms": {offset_ms}, "session": "{session}"}}'.encode()


def test_teacher_audio_is_stamped_in_room_time_per_broadcast(moq: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Room time = media time + the broadcast's offset (design §4.5). A new broadcast (subscription) reads the clock
    again; one without a clock track (the looper) is offset 0."""
    import asyncio

    for name in ("TrackRef", "SubscribeSpec", "StartAt"):
        monkeypatch.setattr(moq, name, types.SimpleNamespace)
    monkeypatch.setattr(moq, "AudioAssembler", EchoAssembler)
    relay = ClockRelay(
        audio=[(1, b"100"), (1, b"120"), (2, b"20"), (2, b"40"), (3, b"60")],
        clocks=[[b"not a clock", clock_json(50_000, "a")], [clock_json(90_000, "b")], None],
    )

    async def scenario() -> list[int]:
        return [end_ms async for _, end_ms in moq.teacher_audio(relay, "r")]

    assert asyncio.run(scenario()) == [50_100, 50_120, 90_020, 90_040, 60]


def test_a_silent_clock_track_means_no_room_clock(moq: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    for name in ("TrackRef", "SubscribeSpec", "StartAt"):
        monkeypatch.setattr(moq, name, types.SimpleNamespace)
    relay = ClockRelay(audio=[], clocks=[[]])
    assert asyncio.run(moq.room_clock(relay, "r", wait_s=0.1)) is None
