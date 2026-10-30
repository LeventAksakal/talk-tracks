"""The room service's write endpoint for listeners (decision 0024): one WebSocket per listener on
``/api/rooms/<room>``, beside the relay, behind Caddy on the VM.

Listeners never hold publish rights on the relay (decision 0005). They send what they draw, mark and comment here;
``archive.audience`` validates it with the contracts, stamps who and when, and publishes it on the room's
``annotations`` and ``comments`` tracks. The same socket gives the Discussion tab and the console's question list
the room's threads (a snapshot, then each new comment record), which on the track would take one FETCH per 4 s
slice of the talk.

Protocol (JSON text messages):

* ``{"type": "hello", "name"?, "id"?, "key"?, "token"?, "comments"?}`` first. No account: the room service gives a
  listener an ``id`` and a ``key`` that proves it later (an HMAC of the id), which the browser keeps so its strokes
  stay its own across reloads. ``token``: the speaker's relay token (the console has it); signed by the room key and
  allowed to publish the room's slides, the session is the speaker's (``by.speaker``). ``comments``: send the threads.
  Answer: ``{"type": "welcome", "id", "key"?, "name", "speaker", "now"}``, then ``{"type": "threads", "records"}``.
* ``{"type": "name", "name"}``: the display name from now on (1 to 60 characters, asked once per browser).
* ``{"type": "write", "seq", "track": "ink" | "marks" | "comments", "data", "at"?}``: one record's ``data`` without
  ``by`` (and a new comment's ``id`` and ``at``). Answer ``{"type": "ack", "seq", "m", "id"?}`` or
  ``{"type": "error", "seq", "code", "message"}``; codes ``invalid``, ``forbidden``, ``not-live``, ``limit``,
  ``rate``, ``name``.
* From the service: ``{"type": "comment", "record"}`` for every new comment, reply, edit or hide in the room.

Limits: a token bucket per session and track (``LIMITS``), at most ``SESSIONS_PER_IP`` sessions per address, 32 KiB
per message, and the stroke limits of ``archive.audience``.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

from pydantic import TypeAdapter, ValidationError

from ..contracts import Author, CommentRecord, DisplayName, parse_room
from .audience import Audience, Refusal
from .speaker_key import SpeakerKey

log = logging.getLogger("talk_tracks.archive.listeners")

PATH = "/api/rooms/"
HELLO_TIMEOUT_S = 10.0
MAX_MESSAGE = 32 * 1024
SESSIONS_PER_IP = 20  # a classroom behind one NAT is one address
OUTBOX = 256  # pushes queued for a slow reader before its session is closed
SPEAKER_ID = "speaker"  # the console's own author id on talk/<room>/slides

# (per second, burst) per session and track: ink is a points batch about every 50 ms while drawing
LIMITS: dict[str, tuple[float, float]] = {"ink": (30.0, 60.0), "marks": (5.0, 10.0), "comments": (0.5, 5.0)}
SPEAKER_LIMITS: dict[str, tuple[float, float]] = {"ink": (60.0, 120.0), "marks": (10.0, 20.0), "comments": (2.0, 10.0)}

NAME: TypeAdapter[str] = TypeAdapter(DisplayName)

Lookup = Callable[[str], Awaitable[Audience | None]]  # a room's audience, None for a room this service does not serve


@dataclass
class Bucket:
    """A token bucket: ``rate`` tokens a second, at most ``burst`` held."""

    rate: float
    burst: float
    tokens: float = -1.0
    at: float = 0.0

    def take(self, now: float) -> bool:
        if self.tokens < 0:
            self.tokens, self.at = self.burst, now
        self.tokens = min(self.burst, self.tokens + (now - self.at) * self.rate)
        self.at = now
        if self.tokens < 1:
            return False
        self.tokens -= 1
        return True


class Identities:
    """Listener ids with a key that proves them: HMAC-SHA256 of the id under the service's secret."""

    def __init__(self, secret: bytes) -> None:
        self._secret = secret

    def key(self, user_id: str) -> str:
        return hmac.new(self._secret, user_id.encode(), hashlib.sha256).hexdigest()[:32]

    def issue(self) -> tuple[str, str]:
        user_id = f"u{secrets.token_hex(6)}"
        return user_id, self.key(user_id)

    def check(self, user_id: object, key: object) -> bool:
        if not isinstance(user_id, str) or not isinstance(key, str) or not user_id.startswith("u"):
            return False
        return hmac.compare_digest(self.key(user_id), key)


def load_secret(path: Path) -> bytes:
    """The listener-id secret: ``TT_LISTENER_SECRET``, else a file kept beside (never inside) the served archive."""
    if env := os.environ.get("TT_LISTENER_SECRET"):
        return env.encode()
    try:
        return bytes.fromhex(path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        secret = secrets.token_bytes(32)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(secret.hex(), encoding="utf-8")
        with contextlib.suppress(OSError):
            path.chmod(0o600)
        return secret


def record_json(record: CommentRecord) -> dict[str, Any]:
    return record.model_dump(mode="json", exclude_none=True)


@dataclass(eq=False)  # one per socket: compared and hashed by identity
class Session:
    """One listener's (or the speaker's) socket: who they are, their buckets, and what is queued for them."""

    room: str
    ip: str
    send: Callable[[str], Awaitable[None]]
    user_id: str | None = None
    name: str | None = None
    speaker: bool = False
    comments: bool = False
    audience: Audience | None = None
    buckets: dict[str, Bucket] = field(default_factory=dict[str, Bucket])
    outbox: asyncio.Queue[str] = field(default_factory=lambda: asyncio.Queue[str](OUTBOX))

    @property
    def author(self) -> Author | None:
        if self.user_id is None or self.name is None:
            return None
        return Author(id=self.user_id, name=self.name, speaker=self.speaker)


def _name(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return NAME.validate_python(" ".join(value.split()))
    except ValidationError:
        return None


class Endpoint:
    """The protocol, transport-free: ``open`` a session, ``handle`` each message, ``close`` it. ``serve`` runs it on
    a WebSocket server."""

    def __init__(
        self,
        lookup: Lookup,
        identities: Identities,
        *,
        speaker_key: SpeakerKey | None = None,
        open_speaker: bool = False,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.lookup, self.identities, self.speaker_key, self.open_speaker = (
            lookup,
            identities,
            speaker_key,
            open_speaker,
        )
        self.clock = clock
        self.rooms: dict[str, set[Session]] = {}  # sessions that read the threads, per room
        self._hooked: dict[str, Audience] = {}
        self.per_ip: dict[str, int] = {}

    # --- sessions --------------------------------------------------------------------------------------------------

    def admit(self, ip: str) -> bool:
        return self.per_ip.get(ip, 0) < SESSIONS_PER_IP

    def open(self, room: str, ip: str, send: Callable[[str], Awaitable[None]]) -> Session:
        self.per_ip[ip] = self.per_ip.get(ip, 0) + 1
        return Session(room=room, ip=ip, send=send)

    def close(self, session: Session) -> None:
        left = self.per_ip.get(session.ip, 1) - 1
        if left > 0:
            self.per_ip[session.ip] = left
        else:
            self.per_ip.pop(session.ip, None)
        self.rooms.get(session.room, set()).discard(session)

    async def handle(self, session: Session, raw: str | bytes) -> list[dict[str, Any]]:
        """One message from the client: the answers to send back."""
        try:
            message: object = json.loads(raw)
        except ValueError:
            return [error(None, "invalid", "Messages are JSON")]
        if not isinstance(message, dict):
            return [error(None, "invalid", "Messages are JSON objects")]
        msg = cast(dict[str, Any], message)
        kind = msg.get("type")
        seq = msg.get("seq") if isinstance(msg.get("seq"), int) else None
        if kind == "hello":
            return await self._hello(session, msg)
        if session.user_id is None or session.audience is None:
            return [error(seq, "invalid", "Say hello first")]
        if kind == "name":
            name = _name(msg.get("name"))
            if name is None:
                return [error(seq, "name", "A display name has 1 to 60 characters")]
            session.name = name
            return [{"type": "name", "name": name}]
        if kind == "write":
            return [await self._write(session, msg, seq)]
        return [error(seq, "invalid", f"Unknown message {kind!r}")]

    async def _hello(self, session: Session, msg: dict[str, Any]) -> list[dict[str, Any]]:
        if session.user_id is not None:
            return [error(None, "invalid", "Hello once per connection")]
        audience = await self.lookup(session.room)
        if audience is None:
            return [error(None, "no-room", f"The room service does not hold room {session.room} (yet)")]
        token = msg.get("token")
        if token is not None:
            if not self._is_speaker(token, session.room):
                return [error(None, "forbidden", "That speaker link is not valid for this room")]
            session.user_id, session.speaker = SPEAKER_ID, True
            session.name = _name(msg.get("name")) or "Speaker"
        else:
            user_id, key = msg.get("id"), msg.get("key")
            if not self.identities.check(user_id, key):
                user_id, key = self.identities.issue()
            session.user_id = cast(str, user_id)
            session.name = _name(msg.get("name"))
        session.audience = audience
        self._hook(session.room, audience)
        welcome: dict[str, Any] = {
            "type": "welcome",
            "id": session.user_id,
            "name": session.name,
            "speaker": session.speaker,
            "now": audience.now(),
        }
        if not session.speaker:
            welcome["key"] = self.identities.key(session.user_id)
        out = [welcome]
        if msg.get("comments"):
            session.comments = True
            self.rooms.setdefault(session.room, set()).add(session)
            out.append({"type": "threads", "records": [record_json(r) for r in audience.threads()]})
        return out

    def _is_speaker(self, token: object, room: str) -> bool:
        if not isinstance(token, str) or not token:
            return False
        if self.speaker_key is not None:
            return self.speaker_key.is_speaker(token, room)
        if self.open_speaker:
            log.warning("room %s: speaker session without a key check (TT_OPEN_SPEAKER, development only)", room)
            return True
        return False

    async def _write(self, session: Session, msg: dict[str, Any], seq: int | None) -> dict[str, Any]:
        author, audience = session.author, session.audience
        assert audience is not None
        if author is None:
            return error(seq, "name", "Choose a display name first")
        track = msg.get("track")
        if not isinstance(track, str) or track not in LIMITS:
            return error(seq, "invalid", "A write names its track: ink, marks or comments")
        rate, burst = (SPEAKER_LIMITS if session.speaker else LIMITS)[track]
        bucket = session.buckets.setdefault(track, Bucket(rate, burst))
        if not bucket.take(self.clock()):
            return error(seq, "rate", "Slow down a little")
        at = msg.get("at")
        if at is not None and (not isinstance(at, int) or isinstance(at, bool)):
            return error(seq, "invalid", "at is a room time in ms")
        try:
            done = await audience.write(author, track, msg.get("data"), at)
        except Refusal as e:
            return error(seq, e.code, e.message)
        ack: dict[str, Any] = {"type": "ack", "seq": seq, "m": done.m}
        if done.id is not None:
            ack["id"] = done.id
        return ack

    # --- pushes ----------------------------------------------------------------------------------------------------

    def _hook(self, room: str, audience: Audience) -> None:
        if self._hooked.get(room) is audience:
            return
        self._hooked[room] = audience
        audience.listeners.append(lambda record: self._push(room, record))

    def _push(self, room: str, record: CommentRecord) -> None:
        text = json.dumps({"type": "comment", "record": record_json(record)}, separators=(",", ":"))
        for session in list(self.rooms.get(room, ())):
            try:
                session.outbox.put_nowait(text)
            except asyncio.QueueFull:
                log.info("room %s: a reader fell behind, closing its session", room)
                self.rooms[room].discard(session)

    # --- the WebSocket server --------------------------------------------------------------------------------------

    async def serve(
        self,
        host: str,
        port: int,
        *,
        origins: Iterable[str] | None = None,
        proxied: bool = False,
        ready: asyncio.Event | None = None,
    ) -> None:
        """Serve until cancelled. ``proxied``: behind Caddy, the client's address is the last X-Forwarded-For.
        ``ready`` is set once the socket listens."""
        from websockets.asyncio.server import ServerConnection, serve
        from websockets.datastructures import Headers
        from websockets.http11 import Request, Response

        def address(conn: ServerConnection, headers: Headers) -> str:
            forwarded = headers.get("X-Forwarded-For") if proxied else None
            if forwarded:
                return forwarded.split(",")[-1].strip()
            remote = conn.remote_address
            return str(remote[0]) if remote else "?"

        def room_of(path: str) -> str | None:
            if not path.startswith(PATH):
                return None
            try:
                return parse_room(path[len(PATH) :].split("?")[0].strip("/"))
            except ValueError:
                return None

        def check(conn: ServerConnection, request: Request) -> Response | None:
            if room_of(request.path) is None:
                return conn.respond(404, "Not a room\n")
            if not self.admit(address(conn, request.headers)):
                return conn.respond(429, "Too many connections from your address\n")
            return None

        async def handler(conn: ServerConnection) -> None:
            room = room_of(conn.request.path if conn.request else "")
            if room is None or conn.request is None:
                return
            session = self.open(room, address(conn, conn.request.headers), conn.send)

            async def writer() -> None:
                while True:
                    await conn.send(await session.outbox.get())

            pushing = asyncio.create_task(writer())
            try:
                first = await asyncio.wait_for(conn.recv(), HELLO_TIMEOUT_S)
                for answer in await self.handle(session, first):
                    await conn.send(json.dumps(answer, separators=(",", ":")))
                if session.user_id is None:
                    return
                async for raw in conn:
                    for answer in await self.handle(session, raw):
                        await conn.send(json.dumps(answer, separators=(",", ":")))
            except (TimeoutError, OSError):
                pass
            except Exception as e:
                if type(e).__name__ not in ("ConnectionClosedOK", "ConnectionClosedError"):
                    log.exception("room %s: a listener session failed", room)
            finally:
                pushing.cancel()
                self.close(session)

        allowed = list(origins) if origins else None
        async with serve(
            handler,
            host,
            port,
            process_request=check,
            max_size=MAX_MESSAGE,
            origins=cast(Any, allowed),
            ping_interval=20,
        ):
            log.info("listener endpoint on %s:%d%s<room>", host, port, PATH)
            if ready is not None:
                ready.set()
            await asyncio.Future[None]()


@dataclass(frozen=True)
class EndpointConfig:
    """How the room service serves listeners (``python -m talk_tracks.archive --listen``)."""

    host: str
    port: int
    secret_file: Path
    speaker_key: Path | None = None  # public.jwk of the room key; None: no speaker session unless open_speaker
    open_speaker: bool = False  # development only: any token makes the speaker
    origins: tuple[str, ...] = ()  # allowed Origin headers; none: any
    proxied: bool = False

    @staticmethod
    def parse_listen(value: str) -> tuple[str, int]:
        host, _, port = value.rpartition(":")
        return host or "0.0.0.0", int(port)

    async def run(self, lookup: Lookup) -> None:
        key = SpeakerKey.read(self.speaker_key) if self.speaker_key is not None else None
        if key is None and not self.open_speaker:
            log.warning("no speaker key (TT_SPEAKER_KEY): the speaker cannot reply to or hide comments")
        endpoint = Endpoint(
            lookup, Identities(load_secret(self.secret_file)), speaker_key=key, open_speaker=self.open_speaker
        )
        await endpoint.serve(self.host, self.port, origins=self.origins or None, proxied=self.proxied)


def error(seq: int | None, code: str, message: str) -> dict[str, Any]:
    out: dict[str, Any] = {"type": "error", "code": code, "message": message}
    if seq is not None:
        out["seq"] = seq
    return out
