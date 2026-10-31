"""Room creation (decision 0025): ``POST /api/rooms`` on the room service, beside the listeners' WebSocket.

A presenter types a room name, the talk's title, their name and an access code into the lobby. The room service
checks the code, reserves the room for it, records the room under the code's spend cap where the spend ledger reads
caps (``TT_CAPS_DIR``, decision 0008), and signs a speaker token for the room with the room key, as
``deploy/mint-judge-tokens.sh`` does (``wiki/howto/tokens.md``). The title and speaker name go into the room's state
track, so players show them.

Request: ``{"code", "room", "title", "speaker"?}`` (JSON, at most 4 KiB). Answers (JSON):

* ``201 {"room", "speaker_path": "/talk/<room>?token=<jwt>", "watch_path": "/watch/<room>", "cap_usd", "expires"}``;
  the same when the code had created the room already (a fresh token: a lost speaker link).
* ``400 {"error": "invalid", "message"}``: not JSON, a room name that is not 3 to 40 of ``a-z``, ``0-9``, ``-``
  (the room-name contract) or is a demo room, a title of 1 to 120 characters, a speaker name of 1 to 60.
* ``403 {"error": "forbidden"}``: an unknown or expired code, or one that created all its rooms.
* ``409 {"error": "taken"}``: the room exists and is not this code's (another code's, a minted judge room, or a talk
  already in the archive).
* ``429 {"error": "rate"}``: too many attempts from this address, or with this code.
* ``503 {"error": "unavailable"}``: no signing key (``TT_SIGNING_KEY``) outside development.

Access codes are a JSON file on the VM (``TT_ROOM_CODES``), never in the repo; the format is in
``wiki/howto/tokens.md``. It is read again when it changes. Each code's rooms are a caps batch,
``<caps>/code-<label>.json``, so the ledger holds each room to the code's room cap and all of them to its total. With
``TT_OPEN_SPEAKER=1`` (development) any code is accepted, and without a signing key the speaker link has no token
(a local relay needs none); outside development no signing key means no room creation.

The image has no crypto library, so ES256 signing is done here with Python integers like the verification in
``archive.speaker_key``; one signature per room is cheap. The HTTP side is a minimal HTTP/1.1 server on its own port
(``websockets`` serves only GET upgrades); Caddy proxies ``/api/rooms`` to it.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
from collections import OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from pydantic import ValidationError

from ..contracts import ROOM_NAME, slides_path, teacher_path
from .listeners import NAME, Bucket
from .speaker_key import G, N, b64url, multiply, read_jwk

log = logging.getLogger("talk_tracks.archive.create")

PATH = "/api/rooms"
ROOM = ROOM_NAME  # the room-name rule (contracts.parse_room, web isValidRoom)
DEMO_ROOMS = frozenset({"virus", "dataviz", "rsa", "qrcode", "demo"})
LABEL = re.compile(r"[a-z0-9-]{1,40}")
TITLE_MAX = 120
MAX_BODY = 4 * 1024
MAX_HEAD = 8 * 1024
TOKEN_HOURS = 48.0
MAX_ROOMS = 20  # per code, unless its entry says otherwise
IP_LIMIT = (1 / 20, 5.0)  # (per second, burst): five tries at once, then one every 20 s
CODE_LIMIT = (1 / 10, 10.0)  # rooms a code creates: ten at once, then one every 10 s
IPS_KEPT = 4096
READ_TIMEOUT_S = 10.0


# --- the room key: ES256 signing ----------------------------------------------------------------------------------


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


@dataclass(frozen=True)
class SigningKey:
    """The room key's private half (``private.jwk``, EC P-256), which signs speaker tokens as ``moq auth sign``."""

    d: int
    kid: str | None = None

    @classmethod
    def from_jwk(cls, jwk: dict[str, Any]) -> SigningKey:
        if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256" or "d" not in jwk:
            raise ValueError("not a private P-256 key")
        d = int.from_bytes(b64url(str(jwk["d"])))
        if not 1 <= d < N:
            raise ValueError("not a private P-256 key")
        kid = jwk.get("kid")
        return cls(d, str(kid) if kid is not None else None)

    @classmethod
    def read(cls, path: Path) -> SigningKey:
        return cls.from_jwk(read_jwk(path))

    def public(self) -> tuple[int, int]:
        q = multiply(self.d, G)
        assert q is not None
        return q

    def sign(self, claims: dict[str, Any]) -> str:
        """A JWT: ES256 (FIPS 186-5 §6.4.1) over ``header.claims``, r and s as 32 bytes each, s in the lower half."""
        header: dict[str, Any] = {"typ": "JWT", "alg": "ES256", **({"kid": self.kid} if self.kid else {})}
        signing = ".".join(b64(json.dumps(part, separators=(",", ":")).encode()) for part in (header, claims))
        z = int.from_bytes(hashlib.sha256(signing.encode()).digest())
        while True:
            k = secrets.randbelow(N - 1) + 1
            point = multiply(k, G)
            assert point is not None
            r = point[0] % N
            s = pow(k, -1, N) * (z + r * self.d) % N
            if r and s:
                s = min(s, N - s)
                return f"{signing}.{b64(r.to_bytes(32) + s.to_bytes(32))}"


def speaker_claims(room: str, expires_s: int) -> dict[str, Any]:
    """What ``deploy/mint-judge-tokens.sh`` signs: publish the room's teacher and slides, subscribe to the room."""
    return {"publish": [slides_path(room), teacher_path(room)], "subscribe": [f"talk/{room}/**"], "exp": expires_s}


# --- access codes ---------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class AccessCode:
    """One entry of the codes file. ``label`` names its caps batch; ``expires`` is a unix time (None: never)."""

    code: str
    label: str
    room_usd: float
    total_usd: float
    max_rooms: int = MAX_ROOMS
    expires: float | None = None

    @property
    def group(self) -> str:
        return f"code-{self.label}"


def parse_codes(doc: object) -> list[AccessCode]:
    """``{"codes": [{"code", "label", "room_usd", "total_usd", "max_rooms"?, "expires"?}, ...]}``; a broken entry is
    skipped, loudly (without its code)."""
    entries = cast(dict[str, Any], doc).get("codes") if isinstance(doc, dict) else None
    if not isinstance(entries, list):
        raise ValueError('the codes file is {"codes": [...]}')
    out: list[AccessCode] = []
    for i, raw in enumerate(cast(list[object], entries)):
        try:
            entry = cast(dict[str, Any], raw)
            code, label = str(entry["code"]), str(entry["label"])
            if len(code) < 8 or not LABEL.fullmatch(label):
                raise ValueError("a code has 8 characters or more; a label is 1 to 40 of a-z, 0-9 and -")
            expires = entry.get("expires")
            out.append(
                AccessCode(
                    code,
                    label,
                    float(entry["room_usd"]),
                    float(entry["total_usd"]),
                    int(entry.get("max_rooms", MAX_ROOMS)),
                    float(expires) if expires is not None else None,
                )
            )
        except (KeyError, TypeError, ValueError) as e:
            log.warning("codes file: entry %d skipped: %s", i, e)
    return out


class CodeBook:
    """The access codes on the VM (``TT_ROOM_CODES``), read again when the file changes. No file: no code."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self._seen: tuple[float, int] | None = None
        self._codes: list[AccessCode] = []

    def codes(self) -> list[AccessCode]:
        if self.path is None:
            return []
        try:
            stat = self.path.stat()
        except OSError:
            self._seen, self._codes = None, []
            return []
        if self._seen != (stat.st_mtime, stat.st_size):
            self._seen = (stat.st_mtime, stat.st_size)
            try:
                self._codes = parse_codes(json.loads(self.path.read_text(encoding="utf-8")))
            except (OSError, ValueError) as e:
                log.warning("the codes file is unreadable: %s", e)
                self._codes = []
        return self._codes

    def find(self, code: str) -> AccessCode | None:
        """The entry of ``code``, compared in constant time with every entry."""
        found = None
        for entry in self.codes():
            if hmac.compare_digest(entry.code.encode(), code.encode()):
                found = entry
        return found


# --- which code holds which room ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class CreatedRoom:
    room: str
    group: str
    title: str
    speaker: str | None


class Registry:
    """Rooms and their codes: each code's caps batch in ``caps_dir`` (read by the spend ledger), and each created
    room's title and speaker in ``rooms_dir/<room>.json`` (beside the archive, never in the folder Caddy serves)."""

    def __init__(self, caps_dir: Path, rooms_dir: Path) -> None:
        self.caps_dir, self.rooms_dir = caps_dir, rooms_dir

    def created(self, room: str) -> CreatedRoom | None:
        try:
            doc = json.loads((self.rooms_dir / f"{room}.json").read_text(encoding="utf-8"))
            return CreatedRoom(str(doc["room"]), str(doc["group"]), str(doc["title"]), doc.get("speaker"))
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def owner(self, room: str) -> str | None:
        """The caps batch that lists ``room`` (a code's, or a minted judge batch), as the ledger finds it."""
        if (created := self.created(room)) is not None:
            return created.group
        for path in sorted(self.caps_dir.glob("*.json")) if self.caps_dir.is_dir() else []:
            try:
                batch = json.loads(path.read_text(encoding="utf-8"))
                if room in batch["rooms"]:
                    return str(batch["group"])
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return None

    def rooms_of(self, group: str) -> list[str]:
        try:
            batch = json.loads((self.caps_dir / f"{group}.json").read_text(encoding="utf-8"))
            return [str(r) for r in batch["rooms"]]
        except (OSError, ValueError, KeyError, TypeError):
            return []

    def add(self, code: AccessCode, room: str, title: str, speaker: str | None) -> None:
        rooms = self.rooms_of(code.group)
        if room not in rooms:
            rooms.append(room)
        batch = {"group": code.group, "room_usd": code.room_usd, "total_usd": code.total_usd, "rooms": rooms}
        _write(self.caps_dir / f"{code.group}.json", batch)
        doc = {"room": room, "group": code.group, "title": title, "speaker": speaker, "created": int(time.time())}
        _write(self.rooms_dir / f"{room}.json", doc)


def _write(path: Path, doc: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


# --- the request, transport-free ------------------------------------------------------------------------------------


class Refused(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _text(value: object, most: int, what: str) -> str:
    if not isinstance(value, str) or not " ".join(value.split()):
        raise Refused(400, "invalid", f"{what} is 1 to {most} characters")
    text = " ".join(value.split())
    if len(text) > most:
        raise Refused(400, "invalid", f"{what} is 1 to {most} characters")
    return text


class RoomCreation:
    """``POST /api/rooms``: check, reserve, record, sign. ``taken(room)``: the room service holds the room already (an
    archive or a speaker on air). ``on_created(room, title, speaker)``: its state track carries them from now on."""

    def __init__(
        self,
        codes: CodeBook,
        registry: Registry,
        *,
        key: SigningKey | None,
        taken: Callable[[str], bool] = lambda _: False,
        on_created: Callable[[str, str, str | None], None] | None = None,
        open_mode: bool = False,
        default_cap_usd: float = 2.0,
        demo_rooms: Iterable[str] = DEMO_ROOMS,
        token_hours: float = TOKEN_HOURS,
        clock: Callable[[], float] = time.monotonic,
        wall: Callable[[], float] = time.time,
    ) -> None:
        self.codes, self.registry, self.key, self.taken, self.on_created = codes, registry, key, taken, on_created
        self.open_mode, self.default_cap_usd, self.token_hours = open_mode, default_cap_usd, token_hours
        self.demo_rooms = frozenset(demo_rooms) | DEMO_ROOMS
        self.clock, self.wall = clock, wall
        self._ips: OrderedDict[str, Bucket] = OrderedDict()
        self._codes: dict[str, Bucket] = {}
        self._lock = asyncio.Lock()

    async def handle(self, ip: str, body: bytes) -> tuple[int, dict[str, Any]]:
        try:
            return await self._create(ip, body)
        except Refused as e:
            return e.status, {"error": e.code, "message": e.message}

    def _limit_ip(self, ip: str) -> None:
        bucket = self._ips.pop(ip, None) or Bucket(*IP_LIMIT)
        self._ips[ip] = bucket
        while len(self._ips) > IPS_KEPT:
            self._ips.popitem(last=False)
        if not bucket.take(self.clock()):
            raise Refused(429, "rate", "Too many tries from your address; wait a minute")

    def _code(self, raw: object) -> AccessCode:
        code = raw if isinstance(raw, str) else ""
        found = self.codes.find(code) if code else None
        if found is None and self.open_mode:
            return AccessCode("", "local", self.default_cap_usd, self.default_cap_usd * MAX_ROOMS, 1000)
        if found is None or (found.expires is not None and found.expires <= self.wall()):
            raise Refused(403, "forbidden", "That access code is not valid")
        return found

    async def _create(self, ip: str, body: bytes) -> tuple[int, dict[str, Any]]:
        self._limit_ip(ip)
        if self.key is None and not self.open_mode:
            raise Refused(503, "unavailable", "Room creation is not set up on this server")
        try:
            doc: object = json.loads(body)
        except ValueError:
            raise Refused(400, "invalid", "The body is a JSON object") from None
        if not isinstance(doc, dict):
            raise Refused(400, "invalid", "The body is a JSON object")
        req = cast(dict[str, Any], doc)
        room = req.get("room")
        if not isinstance(room, str) or not ROOM.fullmatch(room):
            raise Refused(400, "invalid", "A room name is 3 to 40 of a-z, 0-9 and -")
        if room in self.demo_rooms:
            raise Refused(400, "invalid", f"{room} is a demo room")
        title = _text(req.get("title"), TITLE_MAX, "The title")
        speaker = None
        if req.get("speaker") not in (None, ""):
            try:
                speaker = NAME.validate_python(_text(req.get("speaker"), 60, "The speaker's name"))
            except ValidationError:
                raise Refused(400, "invalid", "The speaker's name is 1 to 60 characters") from None
        code = self._code(req.get("code"))
        bucket = self._codes.setdefault(code.group, Bucket(*CODE_LIMIT))
        if not bucket.take(self.clock()):
            raise Refused(429, "rate", "This code is creating rooms too fast; wait a little")
        async with self._lock:
            owner = self.registry.owner(room)
            if (owner is not None and owner != code.group) or (owner is None and self.taken(room)):
                raise Refused(409, "taken", f"The room {room} is taken; choose another name")
            again = owner == code.group
            if not again and len(self.registry.rooms_of(code.group)) >= code.max_rooms:
                raise Refused(403, "forbidden", "This access code has created all its rooms")
            self.registry.add(code, room, title, speaker)
        if self.on_created is not None:
            self.on_created(room, title, speaker)
        expires = int(self.wall() + self.token_hours * 3600)
        if code.expires is not None:
            expires = min(expires, int(code.expires))
        speaker_path = f"/talk/{room}"
        if self.key is not None:
            speaker_path += f"?token={self.key.sign(speaker_claims(room, expires))}"
        log.info("room %s %s by %s (cap $%.2f)", room, "re-issued" if again else "created", code.group, code.room_usd)
        return 201, {
            "room": room,
            "speaker_path": speaker_path,
            "watch_path": f"/watch/{room}",
            "cap_usd": code.room_usd,
            "expires": expires,
        }


# --- the HTTP server ----------------------------------------------------------------------------------------------

REASONS = {
    200: "OK",
    201: "Created",
    204: "No Content",
    400: "Bad Request",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    409: "Conflict",
    413: "Payload Too Large",
    429: "Too Many Requests",
    503: "Service Unavailable",
}


class CreateServer:
    """A minimal HTTP/1.1 server for ``POST /api/rooms`` (one request per connection), with CORS for the allowed
    origins (the dev server runs on another port). ``proxied``: the client's address is the last X-Forwarded-For."""

    def __init__(self, creation: RoomCreation, *, origins: Iterable[str] | None = None, proxied: bool = False) -> None:
        self.creation, self.proxied = creation, proxied
        self.origins = frozenset(origins) if origins else None
        self.port: int | None = None

    async def serve(self, host: str, port: int, *, ready: asyncio.Event | None = None) -> None:
        server = await asyncio.start_server(self._connection, host, port, limit=MAX_HEAD)
        self.port = int(server.sockets[0].getsockname()[1]) if server.sockets else port  # port 0: the one given
        async with server:
            log.info("room creation on %s:%d%s", host, self.port, PATH)
            if ready is not None:
                ready.set()
            await server.serve_forever()

    async def _connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            status, body, extra = await asyncio.wait_for(self._request(reader, writer), READ_TIMEOUT_S)
        except (TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, ValueError, OSError):
            status, body, extra = 400, {"error": "invalid", "message": "Not an HTTP request"}, {}
        try:
            data = b"" if status == 204 else json.dumps(body, separators=(",", ":")).encode()
            head = [f"HTTP/1.1 {status} {REASONS.get(status, 'Error')}", "Connection: close", "Cache-Control: no-store"]
            if data:
                head += ["Content-Type: application/json", f"Content-Length: {len(data)}"]
            head += [f"{k}: {v}" for k, v in extra.items()]
            writer.write(("\r\n".join(head) + "\r\n\r\n").encode() + data)
            await writer.drain()
        except OSError:
            pass
        finally:
            writer.close()
            with contextlib.suppress(OSError):
                await writer.wait_closed()

    async def _request(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> tuple[int, dict[str, Any], dict[str, str]]:
        head = await reader.readuntil(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        method, target, _ = lines[0].split(" ", 2)
        headers: dict[str, str] = {}
        for line in lines[1:]:
            name, sep, value = line.partition(":")
            if sep:
                headers[name.strip().lower()] = value.strip()
        cors = self._cors(headers.get("origin"))
        if target.split("?")[0].rstrip("/") != PATH:
            return 404, {"error": "not-found", "message": "Not found"}, cors
        if method == "OPTIONS":
            return 204, {}, cors
        if method != "POST":
            return 405, {"error": "method", "message": "POST a room"}, {**cors, "Allow": "POST, OPTIONS"}
        if headers.get("origin") and self.origins is not None and headers["origin"] not in self.origins:
            return 403, {"error": "forbidden", "message": "Not from this site"}, {}
        length = int(headers.get("content-length", "0"))
        if length > MAX_BODY:
            return 413, {"error": "invalid", "message": "The body is too large"}, cors
        body = await reader.readexactly(length) if length else b""
        status, answer = await self.creation.handle(self._address(writer, headers), body)
        return status, answer, cors

    def _cors(self, origin: str | None) -> dict[str, str]:
        if not origin or (self.origins is not None and origin not in self.origins):
            return {}
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Vary": "Origin",
        }

    def _address(self, writer: asyncio.StreamWriter, headers: dict[str, str]) -> str:
        forwarded = headers.get("x-forwarded-for") if self.proxied else None
        if forwarded:
            return forwarded.split(",")[-1].strip()
        peer: object = writer.get_extra_info("peername")
        return str(cast(tuple[object, ...], peer)[0]) if isinstance(peer, tuple) and peer else "?"


@dataclass(frozen=True)
class CreateConfig:
    """How the room service creates rooms (``python -m talk_tracks.archive --create``)."""

    host: str
    port: int
    codes: Path | None  # the access codes file; None: no code (open mode still accepts any)
    caps_dir: Path
    rooms_dir: Path
    signing_key: Path | None = None  # private.jwk of the room key; None: no creation, or tokenless links (open mode)
    open_mode: bool = False
    origins: tuple[str, ...] = ()
    proxied: bool = False
    default_cap_usd: float = 2.0
    token_hours: float = TOKEN_HOURS
    demo_rooms: tuple[str, ...] = ()

    @staticmethod
    def from_env(listen: str, archive_dir: Path) -> CreateConfig:
        host, _, port = listen.rpartition(":")
        codes = os.environ.get("TT_ROOM_CODES") or None
        key = os.environ.get("TT_SIGNING_KEY") or None
        return CreateConfig(
            host or "0.0.0.0",
            int(port),
            Path(codes) if codes else None,
            Path(os.environ.get("TT_CAPS_DIR", "data/caps")),
            Path(os.environ.get("TT_ROOMS_DIR") or archive_dir.parent / "rooms"),
            Path(key) if key else None,
            open_mode=os.environ.get("TT_OPEN_SPEAKER") == "1",
            origins=tuple(o.strip() for o in os.environ.get("TT_LISTENER_ORIGINS", "").split(",") if o.strip()),
            proxied=os.environ.get("TT_PROXIED") == "1",
            default_cap_usd=float(os.environ.get("TT_ROOM_CAP_USD", "2")),
            token_hours=float(os.environ.get("TT_ROOM_TOKEN_HOURS", str(TOKEN_HOURS))),
            demo_rooms=tuple(r.strip() for r in os.environ.get("TT_DEMO_ROOMS", "").split(",") if r.strip()),
        )

    def registry(self) -> Registry:
        return Registry(self.caps_dir, self.rooms_dir)

    async def run(self, taken: Callable[[str], bool], on_created: Callable[[str, str, str | None], None]) -> None:
        key = SigningKey.read(self.signing_key) if self.signing_key is not None else None
        if key is None and not self.open_mode:
            log.warning("no signing key (TT_SIGNING_KEY): rooms cannot be created")
        if self.codes is None and not self.open_mode:
            log.warning("no access codes (TT_ROOM_CODES): every code is refused")
        creation = RoomCreation(
            CodeBook(self.codes),
            self.registry(),
            key=key,
            taken=taken,
            on_created=on_created,
            open_mode=self.open_mode,
            default_cap_usd=self.default_cap_usd,
            demo_rooms=self.demo_rooms,
            token_hours=self.token_hours,
        )
        server = CreateServer(creation, origins=self.origins or None, proxied=self.proxied)
        await server.serve(self.host, self.port)
