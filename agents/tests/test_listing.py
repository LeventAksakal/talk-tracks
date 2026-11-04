"""The public room list (``GET /api/rooms``): every room presenters made, live or recorded, for the hub; never a
code, a label, a cap or a token, and never a room the coordinator hides."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from talk_tracks.archive.create import AccessCode, CreateServer, Registry
from talk_tracks.archive.listing import Denylist, RoomListing, RoomState

from .test_create import creation

NOW = 1_793_400_000


def archived(root: Path, room: str, *, started_s: int, last_s: int, media_ms: int, slide: str | None = None) -> None:
    run = "r1"
    doc = {
        "format": "talk-tracks-archive",
        "v": 2,
        "room": room,
        "epoch_ms": started_s * 1000,
        "runs": [
            {
                "run": run,
                "broadcast": "b",
                "shift_ms": 0,
                "started_wall_ms": started_s * 1000,
                "last_wall_ms": last_s * 1000,
                "media_first_ms": 0,
                "media_last_ms": media_ms - 1,
            }
        ],
    }
    (root / room / run / "slides").mkdir(parents=True)
    (root / room / "room.json").write_text(json.dumps(doc), encoding="utf-8")
    if slide:
        line = {"room_ms": 0, "wall_ms": 0, "id": 1, "at_ms": 0, "mime": "image/jpeg", "file": slide}
        (root / room / run / "slides" / "frames.jsonl").write_text(json.dumps(line) + "\n", encoding="utf-8")


def setup(tmp: Path, states: dict[str, RoomState] | None = None, hidden: Path | None = None) -> RoomListing:
    registry = Registry(tmp / "caps", tmp / "rooms")
    code = AccessCode("secret-code-0000", "class", 2.0, 8.0)
    registry.add(code, "quantum-101", "Intro to Quantum Cryptography", "Ada")
    registry.add(code, "physics-101", "Waves", None)
    registry.add(code, "rehearsal-1", "A rehearsal", None)
    (tmp / "caps" / "judges.json").write_text(
        json.dumps({"group": "judges", "room_usd": 1, "total_usd": 4, "rooms": ["judge-1", "virus"]}), encoding="utf-8"
    )
    root = tmp / "archive"
    archived(root, "physics-101", started_s=NOW - 3600, last_s=NOW - 600, media_ms=2_940_000, slide="ab12.jpg")
    archived(root, "quantum-101", started_s=NOW - 120, last_s=NOW, media_ms=120_000)
    archived(root, "walk-in", started_s=NOW - 900, last_s=NOW - 300, media_ms=600_000)
    archived(root, "dataviz-recording", started_s=NOW - 900, last_s=NOW - 300, media_ms=600_000)
    said = states or {"quantum-101": "on_air"}
    return RoomListing(
        registry,
        root,
        archived_rooms=lambda: ["physics-101", "quantum-101", "walk-in", "dataviz-recording", "virus"],
        room_state=lambda room: said.get(room),
        listed=lambda room: room not in {"virus", "dataviz"},
        hidden=Denylist(hidden),
        wall=lambda: float(NOW),
    )


def by_room(listing: RoomListing) -> dict[str, dict[str, Any]]:
    return {r["room"]: r for r in listing.answer()["rooms"]}


def test_lists_created_judge_and_archived_rooms_with_their_state(tmp_path: Path) -> None:
    rooms = by_room(setup(tmp_path))
    # The demo lectures and their recordings are the hub's own; everything else is listed.
    assert sorted(rooms) == ["judge-1", "physics-101", "quantum-101", "rehearsal-1", "walk-in"]
    assert rooms["quantum-101"] | {"created": None} == {
        "room": "quantum-101",
        "title": "Intro to Quantum Cryptography",
        "speaker": "Ada",
        "state": "live",
        "created": None,
        "started": NOW - 120,
        "ended": None,
        "duration": 120,
        "recording": True,
        "still": None,
    }
    assert isinstance(rooms["quantum-101"]["created"], int)
    physics = rooms["physics-101"]
    assert (physics["state"], physics["recording"], physics["duration"]) == ("ended", True, 2940)
    assert (physics["started"], physics["ended"]) == (NOW - 3600, NOW - 600)
    assert physics["still"] == "/archive/physics-101/r1/slides/ab12.jpg"
    assert (rooms["rehearsal-1"]["state"], rooms["rehearsal-1"]["recording"]) == ("upcoming", False)
    assert rooms["judge-1"]["title"] == "judge-1" and rooms["judge-1"]["state"] == "upcoming"
    assert rooms["walk-in"]["state"] == "ended" and rooms["walk-in"]["speaker"] is None


def test_end_talk_ends_a_room_whose_broadcast_is_still_up(tmp_path: Path) -> None:
    rooms = by_room(setup(tmp_path, {"quantum-101": "ended"}))
    assert rooms["quantum-101"]["state"] == "ended" and rooms["quantum-101"]["ended"] == NOW


def test_never_exposes_codes_labels_or_caps(tmp_path: Path) -> None:
    text = json.dumps(setup(tmp_path).answer())
    for secret in ("secret-code-0000", "code-class", "judges", "usd", "group", "token"):
        assert secret not in text


def test_the_denylist_hides_rooms_and_is_read_again_when_it_changes(tmp_path: Path) -> None:
    hidden = tmp_path / "rooms-hidden.txt"
    hidden.write_text("# rehearsals\nrehearsal-*\n\nwalk-in  # a stray\n", encoding="utf-8")
    listing = setup(tmp_path, hidden=hidden)
    assert sorted(by_room(listing)) == ["judge-1", "physics-101", "quantum-101"]
    hidden.write_text("physics-101\n", encoding="utf-8")
    listing.ttl_s = 0
    assert "physics-101" not in by_room(listing) and "walk-in" in by_room(listing)


def test_the_list_is_built_at_most_once_per_ttl(tmp_path: Path) -> None:
    listing = setup(tmp_path)
    first = listing.answer()
    Registry(tmp_path / "caps", tmp_path / "rooms").add(AccessCode("x" * 8, "late", 1, 1), "late-1", "Late", None)
    assert listing.answer() is first
    listing.ttl_s = 0
    assert "late-1" in by_room(listing)


async def test_get_over_http_is_public_and_briefly_cached(tmp_path: Path) -> None:
    made, _, _ = creation(tmp_path)
    listing = setup(tmp_path / "list")
    server = CreateServer(made, origins=["https://site.example"], listing=listing.answer)
    ready = asyncio.Event()
    task = asyncio.create_task(server.serve("127.0.0.1", 0, ready=ready))
    await asyncio.wait_for(ready.wait(), 5)
    try:
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{server.port}") as client:
            got = await client.get("/api/rooms", headers={"Origin": "https://evil.example"})
            assert got.status_code == 200 and got.headers["cache-control"] == "public, max-age=10"
            assert {r["room"] for r in got.json()["rooms"]} >= {"quantum-101", "physics-101"}
            made_room = await client.post("/api/rooms", content=b"{}")
            assert made_room.headers["cache-control"] == "no-store"
            assert (await client.put("/api/rooms")).headers["allow"] == "GET, POST, OPTIONS"
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
