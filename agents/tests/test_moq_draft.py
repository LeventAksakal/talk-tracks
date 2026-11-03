# pyright: reportPrivateUsage=false
# (the stubs stand in for aiomoqt internals, whose names are private)
"""Every aiomoqt client is pinned to MoQT draft 18 (aiomoqt offers draft 22 first when left to choose).

aiomoqt has no Windows wheels, so ``talk_tracks.moq`` is imported here against a stub that records how the client
is built.
"""

import importlib
import json
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
    fetch._is_joining = lambda fetch_type: fetch_type == "joining"  # type: ignore[attr-defined]
    reader = types.ModuleType("aiomoqt.agent.reader")
    reader.Reader = object  # type: ignore[attr-defined]
    quic = types.ModuleType("aiopquic.quic.configuration")
    quic.QuicConfiguration = types.SimpleNamespace  # type: ignore[attr-defined]
    for name, module in {
        "aiomoqt": types.ModuleType("aiomoqt"),
        "aiomoqt.agent": agent,
        "aiomoqt.agent.reader": reader,
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


@pytest.mark.parametrize(("value", "credit"), [(None, None), ("", None), ("x", None), ("0", None), ("8192", 8192)])
def test_the_bidi_stream_credit_is_raised_only_when_the_flag_says_so(
    moq: Any, monkeypatch: pytest.MonkeyPatch, value: str | None, credit: int | None
) -> None:
    """moq-relay holds one of our bidi streams per namespace it advertises to us (about 470 on 2026-11-03), which
    left too few of aiopquic's 512 for its SUBSCRIBE and FETCH: ``TT_MOQ_MAX_STREAMS_BIDI`` grants more, unset keeps
    aiopquic's default."""
    if value is None:
        monkeypatch.delenv("TT_MOQ_MAX_STREAMS_BIDI", raising=False)
    else:
        monkeypatch.setenv("TT_MOQ_MAX_STREAMS_BIDI", value)
    moq.relay_client("moqt://relay:4443")
    assert getattr(RecordingClient.made[-1]["configuration"], "max_streams_bidi", None) == credit


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


W_A = 300_000_000_000_000  # µs since 2020-01-01: broadcast a's wall time of PTS zero
W_B = W_A + 60_000_000  # broadcast b, a reload 60 s later
EPOCH = 1_577_836_800_000 + W_A // 1000  # the room started with broadcast a


def hang(wall: int) -> bytes:
    return json.dumps({"audio": {}, "clock": {"wall": wall, "timescale": 1_000_000}}).encode()


def room_catalog(shift: dict[str, int]) -> bytes:
    return json.dumps({"version": "draft-01", "tracks": [], "tt": {"E": EPOCH, "shift": shift}}).encode()


def test_teacher_audio_is_stamped_in_room_time_per_broadcast(moq: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Room time = wall time of the media - E + the broadcast's shift (design §4.5). Each broadcast's hang clock is
    read afresh; nothing is stamped until the room catalog lists the broadcast; one with no clock is not stamped."""
    import asyncio

    from talk_tracks.roomtime import RoomTime

    for name in ("TrackRef", "SubscribeSpec", "StartAt"):
        monkeypatch.setattr(moq, name, types.SimpleNamespace)
    monkeypatch.setattr(moq, "AudioAssembler", EchoAssembler)
    monkeypatch.setattr(moq, "split_legacy", lambda payload: (int(bytes(payload)) * 1000, b""))  # pyright: ignore[reportUnknownLambdaType, reportUnknownArgumentType]
    relay = ClockRelay(
        audio=[(1, b"100"), (1, b"120"), (2, b"20"), (2, b"40"), (3, b"60")],
        clocks=[[hang(W_A)], [hang(W_B)], [b'{"audio": {}}']],
    )
    room_time = RoomTime()

    async def scenario() -> list[int]:
        feed = moq.TeacherFeed(relay, "r", room_time)
        audio = moq.teacher_audio(feed)
        first = asyncio.ensure_future(audio.__anext__())  # attaches, then waits for audio
        await asyncio.sleep(0)
        run = asyncio.ensure_future(feed.run())
        await asyncio.sleep(0.05)
        assert not first.done() and room_time.edge is None  # no room catalog yet: nothing stamped
        await room_time.on_room_catalog(room_catalog({str(W_A): 0, str(W_B): 8000}))
        got = [(await first)[1]] + [(await asyncio.wait_for(audio.__anext__(), 1))[1] for _ in range(3)]
        await run
        await audio.aclose()
        return got

    assert asyncio.run(scenario()) == [100, 120, 60_000 + 8000 + 20, 60_000 + 8000 + 40]

    async def idle() -> int | None:  # no consumer: the feed still moves the room's edge, for idle agents
        relay.audio, relay.clocks = [(4, b"100"), (4, b"300")], [[hang(W_B)], None]
        await moq.TeacherFeed(relay, "r", room_time).run()
        return room_time.edge

    assert asyncio.run(idle()) == 60_000 + 8000 + 300


def test_a_hang_catalog_without_a_clock_means_no_clock(moq: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    for name in ("TrackRef", "SubscribeSpec", "StartAt"):
        monkeypatch.setattr(moq, name, types.SimpleNamespace)
    assert asyncio.run(moq.teacher_clock(ClockRelay(audio=[], clocks=[[]]), "r", wait_s=0.1)) is None
    found = asyncio.run(moq.teacher_clock(ClockRelay(audio=[], clocks=[[hang(W_A)]]), "r", wait_s=0.1))
    assert found is not None and found.key == str(W_A)


def loc(group: int, object_id: int, payload: bytes = b"x") -> Any:
    return types.SimpleNamespace(group=group, object_id=object_id, payload=payload)


class JoinSession:
    """A session whose Joining FETCH delivers ``head``, or is refused."""

    def __init__(self, head: list[Any] | None) -> None:
        self.head = head
        self.handlers: dict[int, Any] = {}
        self.joined: list[tuple[int, int]] = []

    def joining_fetch(self, request_id: int, joining_start: int) -> Any:
        self.joined.append((request_id, joining_start))
        return types.SimpleNamespace(request_id=99)

    def register_fetch_object_handler(self, rid: int, callback: Any) -> None:
        self.handlers[rid] = callback

    def unregister_fetch_object_handler(self, rid: int) -> None:
        self.handlers.pop(rid, None)

    async def _await_response(self, rid: int, timeout: float) -> Any:  # noqa: ASYNC109 - aiomoqt's signature
        if self.head is None:
            raise RuntimeError("refused")
        for obj in reversed(self.head):  # in any order: the join sorts them
            self.handlers[rid](obj)
        return object()

    async def await_fetch_done(self, rid: int, timeout: float) -> bool:  # noqa: ASYNC109 - aiomoqt's signature
        return True

    def unsubscribe(self, rid: int) -> None:
        pass


class Head:
    def __init__(self, *args: Any) -> None:
        self.got: list[Any] = []

    def on_fetched(self, obj: Any) -> None:
        self.got.append(obj)

    def drain(self) -> list[Any]:
        return self.got


class StubStartAt(types.SimpleNamespace):
    @staticmethod
    def range(group: int, end_group: int) -> None:
        return None


class LiveReader:
    def __init__(self, objects: list[Any]) -> None:
        self.objects = objects
        self.request_id = 7
        self.done = False

    async def read(self, n: int, **kw: float) -> list[Any]:
        taken, self.objects = self.objects[:1], self.objects[1:]
        self.done = not self.objects
        return taken

    def drain(self) -> list[Any]:
        return []


@pytest.mark.parametrize("refused", [False, True])
def test_a_join_reads_the_current_group_from_object_0_then_live_each_once(
    moq: Any, monkeypatch: pytest.MonkeyPatch, refused: bool
) -> None:
    """Design §5.5: translation joins captions with SUBSCRIBE plus a Joining FETCH relative 0."""
    import asyncio

    for name in ("TrackRef", "SubscribeSpec", "FetchSpec"):
        monkeypatch.setattr(moq, name, types.SimpleNamespace)
    monkeypatch.setattr(moq, "StartAt", StubStartAt)
    monkeypatch.setattr(moq, "Reader", Head)
    live = [loc(3, 2), loc(3, 3), loc(3, 4)]  # the subscription starts at the latest object, 3/2
    session = JoinSession(None if refused else [loc(3, 0), loc(3, 1), loc(3, 2)])
    relay = moq.Relay.__new__(moq.Relay)
    relay.session = session
    readers = [LiveReader(live)]

    async def reader(spec: Any) -> LiveReader:
        if not readers:
            await asyncio.Event().wait()
        return readers.pop(0)

    relay.agent = types.SimpleNamespace(reader=reader, close_reader=lambda name: None)  # pyright: ignore[reportUnknownLambdaType]

    async def scenario() -> list[tuple[int, int]]:
        found = relay.joined("talk/r/agents/captions", "items")
        got = [(await found.__anext__())[:2] for _ in range(3 if refused else 5)]
        await found.aclose()
        return got

    got = asyncio.run(scenario())
    assert session.joined == [(7, 0)]  # relative 0, joined to the subscription
    assert got == ([] if refused else [(3, 0), (3, 1)]) + [(3, 2), (3, 3), (3, 4)]


def test_the_relay_subscriptions_of_a_sliced_track_feed_its_demand(moq: Any) -> None:
    import asyncio

    calls: list[str] = []

    class Track:
        def __init__(self) -> None:
            self.sub = types.SimpleNamespace(subscribers=set[int]())
            self._subs = [self.sub]

        async def _on_subscribe(self, session: Any, msg: Any) -> None:
            calls.append("subscribe")
            self.sub.subscribers.add(msg.request_id)

        def _on_request_cancelled(self, request_id: int, sub: Any = None) -> None:
            calls.append("cancelled")
            self.sub.subscribers.discard(request_id)

        async def produce(self, out: Any) -> None:
            pass

    track = Track()
    out = moq.SlicedOut(types.SimpleNamespace(_track=track))
    asyncio.run(track._on_subscribe(None, types.SimpleNamespace(request_id=5)))  # pyright: ignore[reportPrivateUsage]
    assert out.demand.open() == 1 and calls == ["subscribe"]
    track._on_request_cancelled(5)  # pyright: ignore[reportPrivateUsage]
    assert out.demand.open() == 0 and calls == ["subscribe", "cancelled"]


# --- R2 (2026-11-03): a recording publisher stopped answering the relay ----------------------------------------


class RequestStreams:
    """aiomoqt's request-stream handling as it is: a reset of the relay's half and a served FETCH leave our half open.
    Records what we send on each stream."""

    _is_client = True

    def __init__(self) -> None:
        self._bidi_stream_requests: dict[int, int] = {}
        self._bidi_streams: dict[int, int] = {}
        self.resets: list[int] = []
        self.fins: list[int] = []

    def bind(self, stream_id: int, request_id: int) -> None:
        self._bidi_stream_requests[stream_id] = request_id
        self._bidi_streams[request_id] = stream_id

    def _on_request_stream_terminated(self, stream_id: int, *, stop_sending_code: int | None = None) -> None:
        self._bidi_stream_requests.pop(stream_id, None)

    def _on_control_data(self, stream_id: int, data: Any, end_stream: bool, *, is_request_bidi: bool = False) -> None:
        pass

    async def serve_fetch(self, request_id: int, objects: Any, **kw: Any) -> int:
        return 99  # the data stream, FIN'd

    def stream_reset(self, stream_id: int, error_code: int = 1) -> None:
        self.resets.append(stream_id)

    def stream_fin(self, stream_id: int) -> None:
        self.fins.append(stream_id)

    _gone_requests: ClassVar[dict[int, None]] = {}
    _half_open: Any = None  # set by _retire_request_streams

    def _send_on_request_stream(self, request_id: int, msg: Any, fin: bool = False) -> None:
        if fin:  # aiomoqt FINs with stream_write, not stream_fin
            self.fins.append(self._bidi_streams[request_id])

    def stop_sending(self, stream_id: int) -> None:
        """The relay's STOP_SENDING, as aiomoqt handles it: our half is reset, then the request is told."""
        self.stream_reset(stream_id, 0)
        self._on_request_stream_terminated(stream_id, stop_sending_code=0)


def test_a_request_stream_the_relay_resets_is_closed_on_our_side_so_its_credit_comes_back(moq: Any) -> None:
    """Draft 18 caps the relay's requests to us only by QUIC bidi credit (512), which a stream gives back once both
    halves are closed. The relay ends a subscription by resetting its half; ours must close too."""
    import asyncio

    async def scenario() -> list[int]:
        session = RequestStreams()
        moq._retire_request_streams(session)  # pyright: ignore[reportPrivateUsage]
        session.bind(5, 2)
        session._on_request_stream_terminated(5)  # the relay reset its half of a SUBSCRIBE it sent (stream 5)
        session._on_request_stream_terminated(9, stop_sending_code=0)  # STOP_SENDING: aiomoqt resets ours itself
        session._on_request_stream_terminated(4)  # a stream we opened: our own request, not ours to retire
        return session.resets

    assert asyncio.run(scenario()) == [5]


@pytest.mark.parametrize("relay_first", [False, True])
def test_a_served_fetch_closes_its_request_stream_once_the_relay_has_closed_its_half(
    moq: Any, monkeypatch: pytest.MonkeyPatch, relay_first: bool
) -> None:
    """A FETCH's request stream carried FETCH_OK; once its data stream is done and the relay has FIN'd its half, ours
    closes (a grace later), whichever comes first. A subscription the relay FINs but still holds keeps its stream."""
    import asyncio

    monkeypatch.setattr(moq, "FIN_GRACE_S", 0.01)

    async def scenario() -> tuple[list[int], list[int], dict[int, int]]:
        session = RequestStreams()
        moq._retire_request_streams(session)  # pyright: ignore[reportPrivateUsage]
        session.bind(13, 3)  # a FETCH
        session.bind(17, 4)  # a SUBSCRIBE
        if relay_first:
            session._on_control_data(13, b"", True, is_request_bidi=True)
        await asyncio.sleep(0.05)
        assert session.fins == []  # not before the FETCH is served
        await session.serve_fetch(3, [])
        if not relay_first:
            await asyncio.sleep(0.05)
            assert session.fins == []  # not before the relay ends its half
            session._on_control_data(13, b"", True, is_request_bidi=True)
        session._on_control_data(17, b"", True, is_request_bidi=True)
        await asyncio.sleep(0.05)
        return session.fins, session.resets, session._bidi_streams

    fins, resets, bound = asyncio.run(scenario())
    assert fins == [13] and resets == []
    assert bound == {4: 17}  # the served FETCH is forgotten; the subscription is untouched


class GhostSession:
    """A SUBSCRIBE whose cancel aiomoqt handled before the track's handler ran: marked gone, no handler to call."""

    def __init__(self, gone: set[int]) -> None:
        self._gone_requests = dict.fromkeys(gone)
        self._request_cancel_handlers: dict[int, Any] = {}

    def _notify_request_cancelled(self, request_id: int, why: str) -> None:
        cb = self._request_cancel_handlers.pop(request_id, None)
        if cb is not None:
            cb(request_id)


class SubscribedTrack:
    """aiomoqt's ``_on_subscribe``: accepts, adds the subscriber, registers the cancel that ends it."""

    trackname = "catalog"

    def __init__(self) -> None:
        self.subscribers: set[int] = set()

    async def _on_subscribe(self, session: Any, msg: Any) -> None:
        self.subscribers.add(msg.request_id)
        session._request_cancel_handlers[msg.request_id] = self.subscribers.discard


def test_a_subscribe_cancelled_before_it_was_handled_leaves_no_ghost_subscriber(moq: Any) -> None:
    """The relay abandons a SUBSCRIBE its viewer gave up on as soon as it sends it. Without this the track wrote to
    the ghost every 2 s for over an hour (the relay's "unknown track alias", 2026-11-03), and a lazy agent would see
    a subscriber forever."""
    import asyncio

    track = SubscribedTrack()
    moq._drop_cancelled_subscribes(track)  # pyright: ignore[reportPrivateUsage]
    session = GhostSession(gone={86})

    async def scenario() -> None:
        await track._on_subscribe(session, types.SimpleNamespace(request_id=86))  # pyright: ignore[reportPrivateUsage]
        await track._on_subscribe(session, types.SimpleNamespace(request_id=90))  # pyright: ignore[reportPrivateUsage]

    asyncio.run(scenario())
    assert track.subscribers == {90}
    assert set(session._request_cancel_handlers) == {90}


def test_a_request_stream_leaves_the_bookkeeping_once_both_halves_are_closed(moq: Any) -> None:
    """Every way a request stream of the relay's ends takes it out of what ``_retire_request_streams`` remembers, so
    a publisher that runs for days holds only the streams still open."""
    import asyncio

    async def scenario() -> tuple[Any, list[int]]:
        session = RequestStreams()
        moq._retire_request_streams(session)
        session.bind(21, 6)  # a refused FETCH: REQUEST_ERROR with FIN, then the relay's FIN
        session._send_on_request_stream(6, "REQUEST_ERROR", fin=True)
        session._on_control_data(21, b"", True, is_request_bidi=True)
        session.bind(25, 7)  # a SUBSCRIBE the relay FINs at once, ended later by our PUBLISH_DONE
        session._on_control_data(25, b"", True, is_request_bidi=True)
        session._send_on_request_stream(7, "PUBLISH_DONE", fin=True)
        session.bind(29, 8)  # a subscription the relay ends with STOP_SENDING, then FIN
        session.stop_sending(29)
        session._on_control_data(29, b"", True, is_request_bidi=True)
        session.bind(33, 9)  # a served FETCH the relay ends with STOP_SENDING, then a reset
        await session.serve_fetch(9, [])
        session.stop_sending(33)
        session._on_request_stream_terminated(33)
        return session._half_open, session.resets

    half, resets = asyncio.run(scenario())
    assert (half.peer_ended, half.ours_ended, half.served) == (set(), set(), set())
    assert resets == [29, 33]


def test_stop_sending_then_a_reset_resets_our_half_once(moq: Any) -> None:
    import asyncio

    async def scenario() -> list[int]:
        session = RequestStreams()
        moq._retire_request_streams(session)
        session.bind(37, 10)
        session.stop_sending(37)  # aiomoqt resets our half
        session._on_request_stream_terminated(37)  # then the relay resets its own
        return session.resets

    assert asyncio.run(scenario()) == [37]


@pytest.mark.parametrize(("value", "on"), [(None, False), ("", False), ("0", False), ("1", True), ("on", True)])
def test_request_streams_are_retired_only_when_the_flag_says_so(
    moq: Any, monkeypatch: pytest.MonkeyPatch, value: str | None, on: bool
) -> None:
    """Under image c1c4914 the relay stopped sending requests to our publishers within minutes (2026-11-03), and the
    retire patch is not cleared of it: off unless ``TT_MOQ_RETIRE_STREAMS`` turns it on, one service at a time."""
    if value is None:
        monkeypatch.delenv("TT_MOQ_RETIRE_STREAMS", raising=False)
    else:
        monkeypatch.setenv("TT_MOQ_RETIRE_STREAMS", value)
    assert moq.retiring_streams() is on


def test_no_watchdog_is_left_to_restart_a_healthy_publisher(moq: Any) -> None:
    """The watchdog restarted all four recording publishers every ~2.5 min while they served (2026-11-03): its probe
    misses whenever the relay forwards nothing upstream, whoever is at fault. It is gone, with its probe track."""
    assert not hasattr(moq, "answering") and not hasattr(moq, "PROBE_TRACK")
