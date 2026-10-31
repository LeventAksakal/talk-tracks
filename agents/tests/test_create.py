"""Room creation by access code (decision 0025): ``POST /api/rooms`` checks the code, reserves the room under the
code's caps batch, signs a speaker token the room key verifies, and the room's state carries the title."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from talk_tracks.archive.create import (
    CreateServer,
    Registry,
    RoomCreation,
    SigningKey,
    b64,
    parse_codes,
)
from talk_tracks.archive.events import RoomEvents
from talk_tracks.archive.speaker_key import N, SpeakerKey, b64url
from talk_tracks.contracts import RoomStateObject
from talk_tracks.llm.ledger import room_cap

from .test_event_archive import FakeRelay

CODE = "judges-code-0000"  # a placeholder, as in wiki/howto/tokens.md
NOW = 1_793_400_000.0


def key_files(tmp: Path) -> tuple[SigningKey, Path]:
    """A room key as ``moq auth generate`` writes it: base64url of the JWK."""
    key = SigningKey(123456789123456789123456789, "k1")
    x, y = key.public()
    jwk = {"kty": "EC", "crv": "P-256", "alg": "ES256", "kid": "k1", "x": b64(x.to_bytes(32)), "y": b64(y.to_bytes(32))}
    private = {**jwk, "d": b64(key.d.to_bytes(32))}
    (tmp / "private.jwk").write_text(b64(json.dumps(private).encode()), encoding="utf-8")
    (tmp / "public.jwk").write_text(b64(json.dumps(jwk).encode()), encoding="utf-8")
    return SigningKey.read(tmp / "private.jwk"), tmp / "public.jwk"


def codes_file(tmp: Path, *entries: dict[str, Any]) -> Path:
    path = tmp / "room-codes.json"
    path.write_text(json.dumps({"codes": list(entries)}), encoding="utf-8")
    return path


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def creation(tmp: Path, *, taken: set[str] | None = None, **over: Any) -> tuple[RoomCreation, Clock, list[Any]]:
    from talk_tracks.archive.create import CodeBook

    key, _ = key_files(tmp)
    codes = codes_file(
        tmp,
        {"code": CODE, "label": "judges", "room_usd": 1.5, "total_usd": 6, "max_rooms": 3},
        {"code": "other-code-1111", "label": "class", "room_usd": 2, "total_usd": 4},
        {"code": "old-code-2222", "label": "old", "room_usd": 2, "total_usd": 4, "expires": NOW - 1},
    )
    clock, created = Clock(), list[Any]()
    held = taken or set()
    made = RoomCreation(
        CodeBook(codes),
        Registry(tmp / "caps", tmp / "rooms"),
        key=over.pop("key", key),
        taken=lambda room: room in held,
        on_created=lambda room, title, speaker: created.append((room, title, speaker)),
        clock=clock,
        wall=lambda: NOW,
        **over,
    )
    return made, clock, created


def body(**fields: Any) -> bytes:
    return json.dumps(
        {"code": CODE, "room": "quantum-101", "title": "Intro to Quantum Cryptography", **fields}
    ).encode()


async def test_a_code_creates_a_room_with_a_capped_speaker_token_for_that_room_only(tmp_path: Path) -> None:
    made, _, created = creation(tmp_path)
    status, answer = await made.handle("192.0.2.1", body(speaker="  Ada   Lovelace "))
    assert status == 201
    assert answer["room"] == "quantum-101" and answer["watch_path"] == "/watch/quantum-101"
    assert answer["cap_usd"] == 1.5 and answer["expires"] == int(NOW) + 48 * 3600
    path, _, token = answer["speaker_path"].partition("?token=")
    assert path == "/talk/quantum-101" and token

    public = SpeakerKey.read(tmp_path / "public.jwk")
    claims = public.claims(token, NOW)
    assert claims == {
        "publish": ["talk/quantum-101/slides", "talk/quantum-101/teacher"],
        "subscribe": ["talk/quantum-101/**"],
        "exp": answer["expires"],
    }
    assert public.is_speaker(token, "quantum-101", NOW) and not public.is_speaker(token, "other-room", NOW)
    assert public.claims(token, answer["expires"]) is None  # expired then
    header = json.loads(b64url(token.split(".")[0]))
    assert header == {"typ": "JWT", "alg": "ES256", "kid": "k1"}
    s = int.from_bytes(b64url(token.split(".")[2])[32:])
    assert s <= N // 2  # low s: any ES256 verifier takes it

    # recorded where the spend ledger reads caps: the room is held to the code's cap, the code to its total
    cap = room_cap("quantum-101", tmp_path / "caps")
    assert (cap.room_usd, cap.group, cap.group_usd) == (1.5, "code-judges", 6.0)
    assert created == [("quantum-101", "Intro to Quantum Cryptography", "Ada Lovelace")]
    found = Registry(tmp_path / "caps", tmp_path / "rooms").created("quantum-101")
    assert found is not None and (found.title, found.speaker, found.group) == (
        created[0][1],
        "Ada Lovelace",
        "code-judges",
    )


async def test_the_same_code_gets_a_fresh_link_for_its_room_and_another_code_is_refused(tmp_path: Path) -> None:
    made, _, _ = creation(tmp_path, taken={"busy-room"})
    assert (await made.handle("192.0.2.1", body()))[0] == 201
    again, answer = await made.handle("192.0.2.1", body(title="New title"))
    assert again == 201 and "?token=" in answer["speaker_path"]  # a lost speaker link
    assert Registry(tmp_path / "caps", tmp_path / "rooms").rooms_of("code-judges") == ["quantum-101"]

    status, answer = await made.handle("192.0.2.2", body(code="other-code-1111"))
    assert (status, answer["error"]) == (409, "taken")
    (tmp_path / "caps" / "judges-1.json").write_text(
        json.dumps({"group": "judges-1", "room_usd": 2, "total_usd": 10, "rooms": ["judge-3f9a"]}), encoding="utf-8"
    )
    assert (await made.handle("192.0.2.2", body(room="judge-3f9a")))[0] == 409  # a minted judge room
    assert (await made.handle("192.0.2.2", body(room="busy-room")))[0] == 409  # a talk the archive keeps


@pytest.mark.parametrize(
    ("fields", "status"),
    [
        ({"room": "Quantum"}, 400),  # upper case
        ({"room": "qa"}, 400),  # too short
        ({"room": "a" * 41}, 400),  # longer than the room-name rule
        ({"room": "../etc"}, 400),
        ({"room": "virus"}, 400),  # a demo room
        ({"title": "  "}, 400),
        ({"title": "x" * 121}, 400),
        ({"speaker": "y" * 61}, 400),
        ({"code": "wrong-code-9999"}, 403),
        ({"code": None}, 403),
        ({"code": "old-code-2222"}, 403),  # expired
    ],
)
async def test_bad_requests_and_codes_are_refused(tmp_path: Path, fields: dict[str, Any], status: int) -> None:
    made, _, created = creation(tmp_path)
    got, answer = await made.handle("192.0.2.1", body(**fields))
    assert got == status and "message" in answer and not created
    assert not (tmp_path / "caps").exists()


async def test_not_json_is_refused(tmp_path: Path) -> None:
    made, _, _ = creation(tmp_path)
    assert (await made.handle("192.0.2.1", b"code=x"))[0] == 400
    assert (await made.handle("192.0.2.1", b"[1]"))[0] == 400


async def test_a_code_creates_at_most_its_rooms(tmp_path: Path) -> None:
    made, _, _ = creation(tmp_path)
    for i in range(3):
        assert (await made.handle(f"192.0.2.{i}", body(room=f"talk-{i}")))[0] == 201
    status, answer = await made.handle("192.0.2.9", body(room="talk-9"))
    assert (status, answer["error"]) == (403, "forbidden")
    assert (await made.handle("192.0.2.9", body(room="talk-1")))[0] == 201  # its own rooms still re-issue


async def test_attempts_are_rate_limited_per_address_and_per_code(tmp_path: Path) -> None:
    made, clock, _ = creation(tmp_path)
    for _ in range(5):
        assert (await made.handle("192.0.2.1", body(code="guess-0000")))[0] == 403
    assert (await made.handle("192.0.2.1", body()))[0] == 429  # guessing codes costs the address its tries
    clock.t += 20
    assert (await made.handle("192.0.2.1", body()))[0] == 201

    (tmp_path / "b").mkdir()
    made, clock, _ = creation(tmp_path / "b")
    rooms = [f"room-{i}" for i in range(11)]
    answers = [
        (await made.handle(f"198.51.100.{i}", body(code="other-code-1111", room=r)))[0] for i, r in enumerate(rooms)
    ]
    assert answers[:10] == [201, 201, 201, 201, 201, 201, 201, 201, 201, 201] and answers[10] == 429


async def test_without_a_signing_key_rooms_are_created_only_in_development(tmp_path: Path) -> None:
    made, _, _ = creation(tmp_path, key=None)
    assert (await made.handle("192.0.2.1", body()))[0] == 503
    (tmp_path / "dev").mkdir()
    dev, _, _ = creation(tmp_path / "dev", key=None, open_mode=True)
    status, answer = await dev.handle("192.0.2.1", body(code="anything"))
    assert status == 201 and answer["speaker_path"] == "/talk/quantum-101"  # a local relay needs no token
    assert room_cap("quantum-101", tmp_path / "dev" / "caps").group == "code-local"


def test_the_codes_file_skips_broken_entries() -> None:
    codes = parse_codes(
        {
            "codes": [
                {"code": CODE, "label": "judges", "room_usd": 2, "total_usd": 10},
                {"code": "short", "label": "x", "room_usd": 2, "total_usd": 10},  # too short to be a secret
                {"code": "no-cap-code-1", "label": "y"},
                {"code": "bad-label-code", "label": "Bad Label", "room_usd": 1, "total_usd": 1},
            ]
        }
    )
    assert [(c.label, c.group, c.max_rooms) for c in codes] == [("judges", "code-judges", 20)]
    with pytest.raises(ValueError):
        parse_codes(["not", "an", "object"])


async def test_the_room_state_carries_the_title_and_speaker_of_a_created_room(tmp_path: Path) -> None:
    relay = FakeRelay()
    events = RoomEvents("quantum-101", relay, tmp_path)
    events.describe("Intro to Quantum Cryptography", "Ada")
    await events.tick(9_000, live=True)
    await events.end()
    out = relay.published[("talk/quantum-101/catalog", "room")]
    records = [r for p in out.live[2] for r in RoomStateObject.model_validate_json(p).root]
    assert [(r.data.state, r.data.title, r.data.speaker) for r in records] == [
        ("on_air", "Intro to Quantum Cryptography", "Ada"),
        ("ended", "Intro to Quantum Cryptography", "Ada"),
    ]
    again = RoomEvents("quantum-101", FakeRelay(), tmp_path)  # restarted: the title comes back from the archive
    await again.tick(30_000, live=True)
    assert again.state is not None and again.state.records[-1].data.title == "Intro to Quantum Cryptography"


async def test_the_endpoint_over_http(tmp_path: Path) -> None:
    made, _, _ = creation(tmp_path)
    server = CreateServer(made, origins=["https://site.example"])
    ready = asyncio.Event()
    task = asyncio.create_task(server.serve("127.0.0.1", 0, ready=ready))
    await asyncio.wait_for(ready.wait(), 5)
    base = f"http://127.0.0.1:{server.port}"
    try:
        async with httpx.AsyncClient(base_url=base) as client:
            pre = await client.options("/api/rooms", headers={"Origin": "https://site.example"})
            assert pre.status_code == 204 and pre.headers["access-control-allow-origin"] == "https://site.example"
            made_room = await client.post("/api/rooms", content=body(), headers={"Content-Type": "application/json"})
            assert made_room.status_code == 201 and made_room.json()["room"] == "quantum-101"
            assert made_room.headers["cache-control"] == "no-store"
            assert (await client.get("/api/rooms")).status_code == 405
            assert (await client.post("/api/other", content=b"{}")).status_code == 404
            foreign = await client.post("/api/rooms", content=body(), headers={"Origin": "https://evil.example"})
            assert foreign.status_code == 403
            big = await client.post("/api/rooms", content=b"x" * 5000)
            assert big.status_code == 413
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
