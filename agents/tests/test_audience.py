"""Listeners write through the room service (decision 0024): what they may draw, mark and comment, what goes out on
``talk/<room>/annotations`` and ``talk/<room>/comments``, the re-send when the speaker shows a slide again, and the
speaker's own session (proven by their relay token)."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any, cast

import pytest

from talk_tracks.archive.events import HistoryOut, RoomEvents
from talk_tracks.archive.listeners import LIMITS, Endpoint, Identities, Session
from talk_tracks.archive.slices import NORMAL, Slice
from talk_tracks.archive.speaker_key import G, N, SpeakerKey, covers, multiply
from talk_tracks.contracts import (
    SLICE_MS,
    Comment,
    CommentRecord,
    CommentsObject,
    CurrentSlideRecord,
    InkBegin,
    InkObject,
    InkRecord,
    InkShape,
    InkStroke,
    MarksObject,
    Reply,
    ShowSlide,
)
from talk_tracks.records import (
    comment_threads,
    comments_carry,
    current_slide,
    element,
    encode,
    ink_carry,
    marks_carry,
)

ROOM = "talk1"
SLIDES = f"talk/{ROOM}/slides"
ANNOTATIONS = f"talk/{ROOM}/annotations"
COMMENTS = f"talk/{ROOM}/comments"
DECK = 3


# --- a relay: the speaker's slide track fed by the test, what the room service publishes kept ---------------------


class Out:
    def __init__(self) -> None:
        self.live: dict[int, list[bytes]] = {}
        self.source: Callable[[int], Awaitable[Slice]] | None = None

    def subscribed(self) -> bool:
        return False

    async def put(self, group: int, object_id: int, payload: bytes) -> None:
        objects = self.live.setdefault(group, [])
        assert object_id == len(objects)
        objects.append(payload)

    async def end_group(self, group: int) -> None:
        pass

    async def end_track(self) -> None:
        pass

    def serve(self, source: Callable[[int], Awaitable[Slice]], stats: object = None, open_slice: object = None) -> None:
        self.source = source

    async def fetch(self, group: int) -> list[bytes]:
        assert self.source is not None
        return [o.payload for o in (await self.source(group)).objects if o.status == NORMAL]


class Relay:
    def __init__(self) -> None:
        self.queues: dict[str, asyncio.Queue[tuple[int, int, bytes]]] = {}
        self.published: dict[tuple[str, str], Out] = {}

    def queue(self, track: str) -> asyncio.Queue[tuple[int, int, bytes]]:
        return self.queues.setdefault(track, asyncio.Queue())

    async def joined(self, namespace: str, track: str) -> AsyncIterator[tuple[int, int, bytes]]:
        q = self.queue(track)
        while True:
            yield await q.get()

    async def publish_sliced(self, namespace: str, track: str) -> HistoryOut:
        out = self.published[(namespace, track)] = Out()
        return cast(HistoryOut, out)


async def settle() -> None:
    for _ in range(50):
        await asyncio.sleep(0)


def show(m: int, index: int) -> bytes:
    return encode([CurrentSlideRecord(m=m, data=ShowSlide(deck=DECK, index=index))])


# --- the speaker's token: ES256 signed by the room key ------------------------------------------------------------


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def keypair() -> tuple[int, dict[str, str]]:
    d = secrets.randbelow(N - 1) + 1
    q = multiply(d, G)
    assert q is not None
    return d, {"kty": "EC", "crv": "P-256", "x": b64(q[0].to_bytes(32)), "y": b64(q[1].to_bytes(32))}


def token(d: int, claims: dict[str, Any]) -> str:
    """A JWT as ``moq auth sign`` makes it: ES256 over header.claims, r and s as 32 bytes each."""
    signing = f"{b64(json.dumps({'alg': 'ES256', 'typ': 'JWT'}).encode())}.{b64(json.dumps(claims).encode())}"
    z = int.from_bytes(hashlib.sha256(signing.encode()).digest())
    while True:
        k = secrets.randbelow(N - 1) + 1
        point = multiply(k, G)
        assert point is not None
        r = point[0] % N
        s = pow(k, -1, N) * (z + r * d) % N
        if r and s:
            return f"{signing}.{b64(r.to_bytes(32) + s.to_bytes(32))}"


def test_only_a_token_signed_by_the_room_key_for_the_rooms_slides_makes_the_speaker() -> None:
    d, jwk = keypair()
    key = SpeakerKey.from_jwk(jwk)
    speaker = token(d, {"put": [f"talk/{ROOM}/teacher", f"talk/{ROOM}/slides"], "get": [f"talk/{ROOM}/**"]})
    assert key.is_speaker(speaker, ROOM)
    assert not key.is_speaker(speaker, "talk2")  # another room's speaker
    assert key.is_speaker(token(d, {"root": "talk", "publish": ["*/slides"]}), ROOM)
    assert not key.is_speaker(token(d, {"put": [f"talk/{ROOM}/agents/**"]}), ROOM)  # an agent token
    assert not key.is_speaker(token(d, {"put": [f"talk/{ROOM}/slides"], "exp": 1_000}), ROOM)  # expired
    other, _ = keypair()
    assert not key.is_speaker(token(other, {"put": [f"talk/{ROOM}/slides"]}), ROOM)  # signed by another key
    header, _claims, signature = speaker.split(".")
    forged = b64(json.dumps({"put": ["talk/**"]}).encode())
    assert not key.is_speaker(f"{header}.{forged}.{signature}", ROOM)
    assert not key.is_speaker("not a token", ROOM)
    assert covers("talk/**", f"talk/{ROOM}/slides") and not covers("talk/*", f"talk/{ROOM}/slides")


# --- a room with its endpoint ---------------------------------------------------------------------------------------


class Room:
    """The room service of one room, a speaker on slide 0 of the deck, and the endpoint in front of it."""

    def __init__(self, tmp: Path, *, key: SpeakerKey | None = None, now: int = 12_000) -> None:
        self.relay = Relay()
        self.now = now
        self.events = RoomEvents(ROOM, self.relay, tmp, room_now=lambda: self.now)
        self.clock = 0.0
        self.endpoint = Endpoint(self.lookup, Identities(b"secret"), speaker_key=key, clock=lambda: self.clock)
        self.pushed: dict[int, list[dict[str, Any]]] = {}

    async def lookup(self, room: str) -> Any:
        return await self.events.audience_tracks() if room == ROOM else None

    async def start(self) -> None:
        self.events.announced(SLIDES, True)
        self.relay.queue("slide").put_nowait((3, 0, show(12_000, 0)))
        await settle()
        await self.events.tick(self.now, live=True)

    async def join(self, hello: dict[str, Any]) -> tuple[Session, list[dict[str, Any]]]:
        async def send(_: str) -> None:
            pass

        session = self.endpoint.open(ROOM, "192.0.2.1", send)
        return session, await self.endpoint.handle(session, json.dumps({"type": "hello", **hello}))

    async def write(self, session: Session, track: str, data: dict[str, Any], **extra: Any) -> dict[str, Any]:
        msg = {"type": "write", "seq": 1, "track": track, "data": data, **extra}
        [answer] = await self.endpoint.handle(session, json.dumps(msg))
        return answer

    async def at(self, ms: int) -> None:
        self.now = ms
        await self.events.tick(ms, live=True)

    def objects(self, ns: str, track: str) -> list[bytes]:
        out = self.relay.published[(ns, track)]
        return [p for k in sorted(out.live) for p in out.live[k]]

    def group(self, ns: str, track: str, k: int) -> list[bytes]:
        return self.relay.published[(ns, track)].live[k]


def ink(payloads: list[bytes], t: int | None = None) -> list[InkRecord]:
    return [r for p in payloads for r in InkObject.model_validate_json(p).root if t is None or r.m <= t]


def comments(payloads: list[bytes]) -> list[CommentRecord]:
    return [r for p in payloads for r in CommentsObject.model_validate_json(p).root]


def begin(stroke: str, **over: Any) -> dict[str, Any]:
    return {
        "kind": "begin",
        "stroke": stroke,
        "deck": DECK,
        "index": 0,
        "tool": "pen",
        "color": "#2f9e44",
        "width": 0.006,
        "points": [[0.1, 0.1]],
        **over,
    }


async def test_a_listeners_stroke_goes_out_stamped_with_who_and_when_and_a_second_viewer_draws_it(
    tmp_path: Path,
) -> None:
    room = Room(tmp_path)
    await room.start()
    ada, [welcome] = await room.join({"name": "Ada"})
    assert welcome["type"] == "welcome" and welcome["speaker"] is False and welcome["name"] == "Ada"
    me = welcome["id"]

    assert (await room.write(ada, "ink", begin(f"{me}:1")))["type"] == "ack"
    room.now = 12_300
    await room.write(ada, "ink", {"kind": "points", "stroke": f"{me}:1", "points": [[0.2, 0.2], [0.3, 0.25]]})
    room.now = 12_500
    await room.write(ada, "ink", {"kind": "end", "stroke": f"{me}:1"})

    records = ink(room.objects(ANNOTATIONS, "ink"))
    begun = records[0].data
    assert isinstance(begun, InkBegin)
    assert records[0].m == 12_000 and begun.by.model_dump() == {"id": me, "name": "Ada", "speaker": False}
    # a second viewer seeking into the slice draws the whole stroke, as it was at each moment
    on = ShowSlide(deck=DECK, index=0)
    seen = ink_carry(ink(room.group(ANNOTATIONS, "ink", 3), 12_400), on)
    assert [(s.data.stroke, len(s.data.points), s.data.done) for s in seen if isinstance(s.data, InkStroke)] == [
        (f"{me}:1", 3, False)
    ]
    # the next slice's carry-in has it done: one group is enough
    await room.at(16_100)
    [carry] = ink(room.group(ANNOTATIONS, "ink", 4)[:1])
    assert isinstance(carry.data, InkStroke) and carry.data.done and carry.m == 12_000


async def test_what_a_listener_may_not_do_publishes_nothing(tmp_path: Path) -> None:
    room = Room(tmp_path)
    await room.start()
    ada, [hello] = await room.join({"name": "Ada"})
    bob, _ = await room.join({"name": "Bob"})
    nameless, _ = await room.join({})
    me = hello["id"]
    await room.write(ada, "ink", begin(f"{me}:1"))
    before = room.objects(ANNOTATIONS, "ink")

    async def code(session: Session, track: str, data: dict[str, Any]) -> str:
        return (await room.write(session, track, data))["code"]

    speaker = {"id": "x", "name": "Ada", "speaker": True}
    assert await code(ada, "ink", {**begin(f"{me}:2"), "by": speaker}) == "invalid"  # nobody says who they are
    assert await code(ada, "ink", begin("2")) == "invalid"  # an id without the writer's
    assert await code(ada, "ink", begin(f"{me}:1")) == "invalid"  # taken
    assert await code(bob, "ink", {"kind": "points", "stroke": f"{me}:1", "points": [[0.5, 0.5]]}) == "forbidden"
    assert await code(bob, "ink", {"kind": "erase", "strokes": [f"{me}:1"]}) == "forbidden"
    assert await code(ada, "ink", {**begin(f"{me}:3"), "color": "red"}) == "invalid"  # the contract's shape
    assert await code(ada, "ink", {"kind": "stroke", "stroke": f"{me}:4"}) == "invalid"  # a whole stroke is whole
    assert await code(nameless, "ink", begin("x:1")) == "name"  # a display name first
    assert room.objects(ANNOTATIONS, "ink") == before

    # Bob's clear leaves Ada's stroke: a listener's clear removes their own
    assert (await room.write(bob, "ink", {"kind": "clear", "deck": DECK, "index": 0}))["type"] == "ack"
    kept = ink_carry(ink(room.objects(ANNOTATIONS, "ink")), current_slide([]) or ON)
    assert [s.data.stroke for s in kept if isinstance(s.data, InkStroke)] == [f"{me}:1"]


ON = ShowSlide(deck=DECK, index=0)


def arrow(stroke: str, end: list[float]) -> dict[str, Any]:
    return {
        "kind": "shape",
        "stroke": stroke,
        "deck": DECK,
        "index": 0,
        "shape": "arrow",
        "start": [0.1, 0.1],
        "end": end,
        "color": "#2f9e44",
        "width": 0.004,
    }


async def test_a_listener_draws_shapes_and_undoes_and_redoes_their_own_work_for_everyone(tmp_path: Path) -> None:
    """Shapes and undo are ordinary records: a late joiner's carry-in shows what the room saw at that moment."""
    room = Room(tmp_path)
    await room.start()
    ada, [hello] = await room.join({"name": "Ada"})
    bob, [bob_hello] = await room.join({"name": "Bob"})
    me = hello["id"]

    async def answer(session: Session, data: dict[str, Any]) -> str:
        reply = await room.write(session, "ink", data)
        return str(reply.get("code", reply["type"]))

    # an arrow dragged out: sent again with the same id, the last one wins
    assert await answer(ada, arrow(f"{me}:1", [0.2, 0.2])) == "ack"
    assert await answer(ada, arrow(f"{me}:1", [0.5, 0.4])) == "ack"
    # a pen stroke, drawn and finished
    await room.write(ada, "ink", begin(f"{me}:2"))
    assert await answer(ada, {**begin(f"{me}:2"), "kind": "stroke", "done": True}) == "invalid"  # still being drawn
    await room.write(ada, "ink", {"kind": "end", "stroke": f"{me}:2"})
    stroke = {**begin(f"{me}:2"), "kind": "stroke", "done": True}

    assert await answer(bob, arrow(f"{me}:9", [0.3, 0.3])) == "invalid"  # not Bob's id
    assert await answer(bob, {"kind": "erase", "strokes": [f"{me}:1"]}) == "forbidden"  # not Bob's to undo
    assert await answer(ada, {**stroke, "done": False}) == "invalid"  # a whole stroke is done

    room.now = 12_600
    assert await answer(ada, {"kind": "erase", "strokes": [f"{me}:2"]}) == "ack"  # undo the stroke
    room.now = 12_800
    assert await answer(ada, stroke) == "ack"  # redo: the stroke sent again whole
    room.now = 13_000
    assert await answer(ada, {"kind": "erase", "strokes": [f"{me}:1"]}) == "ack"  # undo the arrow, not redone

    def visible(t: int) -> list[str]:
        return [element(r).stroke for r in ink_carry(ink(room.group(ANNOTATIONS, "ink", 3), t), ON)]

    assert visible(12_500) == [f"{me}:1", f"{me}:2"]
    assert visible(12_700) == [f"{me}:1"]
    assert visible(12_900) == [f"{me}:1", f"{me}:2"]
    assert visible(13_100) == [f"{me}:2"]
    [dragged] = [r.data for r in ink_carry(ink(room.group(ANNOTATIONS, "ink", 3), 12_500), ON)[:1]]
    assert isinstance(dragged, InkShape) and dragged.end == (0.5, 0.4) and dragged.by.id == me
    # a late joiner: the next slice's carry-in alone
    await room.at(16_100)
    carry = ink(room.group(ANNOTATIONS, "ink", 4)[:1])
    assert [(r.data.kind, getattr(r.data, "stroke", None)) for r in carry] == [("stroke", f"{me}:2")]
    assert bob_hello["id"] != me


async def test_the_speaker_moderates_through_the_room_service_with_their_relay_token(tmp_path: Path) -> None:
    d, jwk = keypair()
    room = Room(tmp_path, key=SpeakerKey.from_jwk(jwk))
    await room.start()
    ada, [hello] = await room.join({"name": "Ada"})
    me = hello["id"]
    await room.write(ada, "ink", begin(f"{me}:1"))
    await room.write(ada, "ink", {"kind": "end", "stroke": f"{me}:1"})
    [impostor] = (await room.join({"name": "Mallory", "token": token(keypair()[0], {"put": [SLIDES]})}))[1]
    assert impostor["code"] == "forbidden"
    console, [welcome] = await room.join({"name": "Grace", "token": token(d, {"put": [SLIDES]})})
    assert welcome["speaker"] is True and welcome["id"] == "speaker" and "key" not in welcome
    assert (await room.write(console, "ink", {"kind": "erase", "strokes": [f"{me}:1"]}))["type"] == "ack"
    assert ink_carry(ink(room.objects(ANNOTATIONS, "ink")), ON) == []


async def test_comments_threads_and_questions_reach_every_reader_and_hidden_ones_stay_out(tmp_path: Path) -> None:
    d, jwk = keypair()
    room = Room(tmp_path, key=SpeakerKey.from_jwk(jwk))
    await room.start()
    ada, [_hello, threads] = await room.join({"name": "Ada", "comments": True})
    assert threads == {"type": "threads", "records": []}
    console, _ = await room.join({"token": token(d, {"put": [SLIDES]}), "comments": True})
    anchor = {"deck": DECK, "index": 0, "region": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.1}}
    ack = await room.write(
        ada, "comments", {"kind": "comment", "text": "  Why fast water?  ", "anchor": anchor, "question": True}
    )
    question = ack["id"]
    room.now = 13_000
    reply = await room.write(console, "comments", {"kind": "reply", "to": question, "text": "It carries more."})
    assert reply["type"] == "ack"
    spam = (await room.write(ada, "comments", {"kind": "comment", "text": "spam", "anchor": anchor}))["id"]
    assert (
        await room.write(ada, "comments", {"kind": "edit", "id": question, "text": "Why is fast water so strong?"})
    )["type"] == "ack"
    assert (await room.write(console, "comments", {"kind": "edit", "id": question, "text": "x"}))["code"] == "forbidden"
    assert (await room.write(console, "comments", {"kind": "hide", "id": spam}))["type"] == "ack"

    published = comments(room.objects(COMMENTS, "comments"))
    first = published[0].data
    assert isinstance(first, Comment) and first.by.name == "Ada" and first.question and first.text == "Why fast water?"
    assert first.id == question and first.at == 12_000
    shown = comment_threads(published)
    assert [(type(r.data).__name__, getattr(r.data, "text", "")) for r in shown] == [
        ("Comment", "Why is fast water so strong?"),
        ("Reply", "It carries more."),
    ]
    assert isinstance(shown[1].data, Reply) and shown[1].data.by.speaker
    # every reader of the room got each record as it went out; a late reader gets the threads without the hidden one
    pushed = [m for m in await drain(ada)]
    assert [m["record"]["data"]["kind"] for m in pushed] == ["comment", "reply", "comment", "edit", "hide"]
    _, [_, late] = await room.join({"name": "Lin", "comments": True})
    assert [r["data"]["id"] for r in late["records"]] == [question, shown[1].data.id]


async def drain(session: Session) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    while not session.outbox.empty():
        out.append(json.loads(session.outbox.get_nowait()))
    return out


async def test_a_comment_made_while_rewound_sits_at_the_playhead_and_goes_out_now(tmp_path: Path) -> None:
    room = Room(tmp_path)
    await room.start()
    await room.at(40_000)
    ada, _ = await room.join({"name": "Ada"})
    anchor = {"deck": DECK, "index": 0}
    await room.write(ada, "comments", {"kind": "comment", "text": "Back at the start", "anchor": anchor}, at=12_500)
    await room.write(ada, "comments", {"kind": "comment", "text": "From the future", "anchor": anchor}, at=99_000)
    a, b = (r for r in comments(room.objects(COMMENTS, "comments")) if isinstance(r.data, Comment))
    assert (a.m, cast(Comment, a.data).at) == (40_000, 12_500)
    assert (b.m, cast(Comment, b.data).at) == (40_000, 40_000)  # never later than now


async def test_a_slide_shown_again_re_sends_its_audience_strokes_marks_and_threads(tmp_path: Path) -> None:
    room = Room(tmp_path)
    await room.start()
    ada, [hello] = await room.join({"name": "Ada"})
    me = hello["id"]
    await room.write(ada, "ink", begin(f"{me}:1"))
    await room.write(ada, "ink", {"kind": "end", "stroke": f"{me}:1"})
    span = [{"run": "t1"}]
    mark = {
        "kind": "mark",
        "id": f"{me}:m1",
        "deck": DECK,
        "index": 0,
        "style": "highlight",
        "color": "#ffd400",
        "span": span,
    }
    assert (await room.write(ada, "marks", mark))["type"] == "ack"
    await room.write(ada, "comments", {"kind": "comment", "text": "Nice", "anchor": {"deck": DECK, "index": 0}})
    # the speaker moves to slide 1, then comes back to slide 0 three slices later
    await room.at(14_000)
    room.relay.queue("slide").put_nowait((3, 1, show(14_000, 1)))
    await settle()
    await room.at(26_100)
    room.relay.queue("slide").put_nowait(
        (6, 0, encode([CurrentSlideRecord(m=24_000, data=ShowSlide(deck=DECK, index=1))]))
    )
    room.relay.queue("slide").put_nowait((6, 1, show(26_200, 0)))
    await settle()

    # slice 6 started on slide 1 (nothing of the audience on it), and the re-send makes it whole for slide 0
    def resent(ns: str, track: str) -> tuple[list[Any], list[Any]]:
        group = room.relay.published[(ns, track)].live[6]
        model: Any = {"ink": InkObject, "marks": MarksObject, "comments": CommentsObject}[track]

        def parse(payload: bytes) -> list[Any]:
            return list(model.model_validate_json(payload).root)

        later = [r for p in group[1:] for r in parse(p)]
        assert later and all(r.m == 26_200 for r in later), track
        return parse(group[0]), later

    carry, later = resent(ANNOTATIONS, "ink")
    assert carry == [] and len(ink_carry(later, ON)) == 1
    carry, later = resent(ANNOTATIONS, "marks")
    assert carry == [] and len(marks_carry(later, ON)) == 1
    carry, later = resent(COMMENTS, "comments")
    assert carry == [] and len(comments_carry(later, ON)) == 1
    for ns, track in ((ANNOTATIONS, "ink"), (ANNOTATIONS, "marks"), (COMMENTS, "comments")):
        out = room.relay.published[(ns, track)]
        assert await out.fetch(6) == out.live[6]  # what a FETCH of group 6 answers is what went out live


async def test_a_restarted_room_service_keeps_every_slides_audience_annotations(tmp_path: Path) -> None:
    room = Room(tmp_path)
    await room.start()
    ada, [hello] = await room.join({"name": "Ada"})
    me = hello["id"]
    await room.write(ada, "ink", begin(f"{me}:1"))
    await room.write(ada, "ink", {"kind": "end", "stroke": f"{me}:1"})
    await room.at(14_000)
    room.relay.queue("slide").put_nowait((3, 1, show(14_000, 1)))
    await settle()
    for t in range(16_000, 40_001, 4_000):
        await room.at(t)
    await room.events.close()

    # (a slice left open by the stopped service is never written again: it continues in the next one)
    again = Room(tmp_path, now=45_000)
    again.events.slides = [CurrentSlideRecord(m=14_000, data=ShowSlide(deck=DECK, index=1))]
    await again.events.restore()
    assert again.events.audience is not None
    # Ada's stroke on slide 0 was made ten slices ago, but showing slide 0 brings it back
    again.events.announced(SLIDES, True)
    again.relay.queue("slide").put_nowait((11, 1, show(45_000, 0)))
    await settle()
    resent = ink(again.objects(ANNOTATIONS, "ink"))
    assert [r.data.stroke for r in resent if isinstance(r.data, InkStroke)] == [f"{me}:1"]
    # and the same listener, with the key the service gave them, may still erase it
    ada2, [welcome] = await again.join({"name": "Ada", "id": me, "key": hello["key"]})
    assert welcome["id"] == me
    assert (await again.write(ada2, "ink", {"kind": "erase", "strokes": [f"{me}:1"]}))["type"] == "ack"
    _stranger, [other] = await again.join({"name": "Eve", "id": me, "key": "0" * 32})
    assert other["id"] != me  # a guessed key gets a fresh id


async def test_writes_are_rate_limited_per_session(tmp_path: Path) -> None:
    room = Room(tmp_path)
    await room.start()
    ada, _ = await room.join({"name": "Ada"})
    anchor = {"deck": DECK, "index": 0}
    rate, burst = LIMITS["comments"]
    answers = [
        (await room.write(ada, "comments", {"kind": "comment", "text": f"#{i}", "anchor": anchor}))["type"]
        for i in range(int(burst) + 1)
    ]
    assert answers == ["ack"] * int(burst) + ["error"]
    room.clock += 1 / rate
    assert (await room.write(ada, "comments", {"kind": "comment", "text": "later", "anchor": anchor}))["type"] == "ack"


async def test_before_the_room_has_a_clock_nothing_is_written(tmp_path: Path) -> None:
    room = Room(tmp_path)
    room.events.room_now = lambda: None
    await room.start()
    ada, [hello] = await room.join({"name": "Ada"})
    assert hello["now"] is None
    assert (await room.write(ada, "ink", begin(f"{hello['id']}:1")))["code"] == "not-live"
    nowhere = room.endpoint.open("other-room", "192.0.2.2", ada.send)
    [answer] = await room.endpoint.handle(nowhere, json.dumps({"type": "hello", "name": "Ada"}))
    assert answer["code"] == "no-room"


async def test_the_endpoint_over_a_real_websocket(tmp_path: Path) -> None:
    from websockets.asyncio.client import connect

    room = Room(tmp_path)
    await room.start()
    listening = asyncio.Event()
    server = asyncio.create_task(room.endpoint.serve("127.0.0.1", 18_391, ready=listening))
    try:
        await asyncio.wait_for(listening.wait(), 10)
        ws = await connect(f"ws://127.0.0.1:18391/api/rooms/{ROOM}")
        async with ws:
            await ws.send(json.dumps({"type": "hello", "name": "Ada", "comments": True}))
            welcome = json.loads(await ws.recv())
            assert welcome["type"] == "welcome" and json.loads(await ws.recv())["type"] == "threads"
            msg = {"kind": "comment", "text": "Hello", "anchor": {"deck": DECK, "index": 0}}
            await ws.send(json.dumps({"type": "write", "seq": 7, "track": "comments", "data": msg}))
            got = [json.loads(await ws.recv()) for _ in range(2)]
            assert sorted(m["type"] for m in got) == ["ack", "comment"]
            assert next(m for m in got if m["type"] == "ack")["seq"] == 7
        with pytest.raises(Exception, match="404"):
            await connect("ws://127.0.0.1:18391/elsewhere")
    finally:
        server.cancel()
        with pytest.raises(asyncio.CancelledError):
            await server
    assert SLICE_MS == 4000
