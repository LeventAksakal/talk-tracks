"""Who is the speaker at the room service's write endpoint (decision 0024): the holder of a relay token that may
publish the room's slides.

The speaker's console already holds that token (decision 0005, ``wiki/howto/tokens.md``): an ES256 JWT signed by the
room key, whose public half the relay's auth server reads from ``public.jwk``. The room service checks the same token
with the same public key, so a listener can never claim to be the speaker. The image has no crypto library (the
agents' MoQ stack is not installed on every machine that runs these tests), and one signature per speaker session is
cheap, so P-256 verification is done here with Python integers (FIPS 186-5 §6.4.2, SEC 1 §4.1.4).
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from ..contracts import slides_path

# NIST P-256 (secp256r1), FIPS 186-5 / SEC 2 §2.4.2
P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
A = P - 3
B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
G = (
    0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
    0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5,
)

Point = tuple[int, int] | None  # None: the point at infinity


def on_curve(q: tuple[int, int]) -> bool:
    x, y = q
    return 0 <= x < P and 0 <= y < P and (y * y - (x * x * x + A * x + B)) % P == 0


def add(p1: Point, p2: Point) -> Point:
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    (x1, y1), (x2, y2) = p1, p2
    if x1 == x2:
        if (y1 + y2) % P == 0:
            return None
        slope = (3 * x1 * x1 + A) * pow(2 * y1, -1, P) % P
    else:
        slope = (y2 - y1) * pow(x2 - x1, -1, P) % P
    x3 = (slope * slope - x1 - x2) % P
    return x3, (slope * (x1 - x3) - y1) % P


def multiply(k: int, q: Point) -> Point:
    out: Point = None
    while k:
        if k & 1:
            out = add(out, q)
        q = add(q, q)
        k >>= 1
    return out


def verify(public: tuple[int, int], message: bytes, signature: bytes) -> bool:
    """An ES256 signature (JWS: r and s, 32 bytes each) of ``message`` by ``public``."""
    if len(signature) != 64 or not on_curve(public):
        return False
    r, s = int.from_bytes(signature[:32]), int.from_bytes(signature[32:])
    if not (1 <= r < N and 1 <= s < N):
        return False
    z = int.from_bytes(hashlib.sha256(message).digest())  # 256 bits: the order's length, nothing to cut
    w = pow(s, -1, N)
    found = add(multiply(z * w % N, G), multiply(r * w % N, public))
    return found is not None and found[0] % N == r


def b64url(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def covers(pattern: str, path: str) -> bool:
    """moq-token path patterns, as the console reads them (``web/src/speaker/token.ts``): ``*`` one segment, ``**``
    any depth (none included), anything else literal."""
    p = [s for s in pattern.split("/") if s]
    s = [x for x in path.split("/") if x]

    def match(i: int, j: int) -> bool:
        if i == len(p):
            return j == len(s)
        if p[i] == "**":
            return match(i + 1, j) or (j < len(s) and match(i, j + 1))
        return j < len(s) and p[i] in ("*", s[j]) and match(i + 1, j + 1)

    return match(0, 0)


def _strings(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [v for v in cast(list[object], value) if isinstance(v, str)]
    return []


def publish_paths(claims: dict[str, Any]) -> list[str]:
    """The paths a token may publish: ``put`` (moq-token's name), ``publish`` or ``pub``, under its ``root``."""
    root = str(claims.get("root") or "").rstrip("/")
    paths = [*_strings(claims.get("put")), *_strings(claims.get("publish")), *_strings(claims.get("pub"))]
    return [f"{root}/{p.lstrip('/')}" if root else p for p in paths]


def read_jwk(path: Path) -> dict[str, Any]:
    """A JWK file: plain JSON, or the base64url of the JSON, which is what ``moq auth generate`` writes."""
    text = path.read_text(encoding="utf-8").strip()
    value: object = json.loads(text if text.startswith("{") else b64url(text))
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} is not a JWK")
    return cast(dict[str, Any], value)


@dataclass(frozen=True)
class SpeakerKey:
    """The room key's public half (``public.jwk``, EC P-256)."""

    public: tuple[int, int]

    @classmethod
    def from_jwk(cls, jwk: dict[str, Any]) -> SpeakerKey:
        if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256":
            raise ValueError("not a P-256 key")
        point = (int.from_bytes(b64url(str(jwk["x"]))), int.from_bytes(b64url(str(jwk["y"]))))
        if not on_curve(point):
            raise ValueError("the key's point is not on P-256")
        return cls(point)

    @classmethod
    def read(cls, path: Path) -> SpeakerKey:
        return cls.from_jwk(read_jwk(path))

    def claims(self, token: str, now_s: float | None = None) -> dict[str, Any] | None:
        """The claims of a token this key signed (ES256) that has not expired; None for any other."""
        parts = token.strip().split(".")
        if len(parts) != 3:
            return None
        try:
            header = json.loads(b64url(parts[0]))
            claims = json.loads(b64url(parts[1]))
            signature = b64url(parts[2])
        except ValueError:
            return None
        if not isinstance(header, dict) or not isinstance(claims, dict):
            return None
        if cast(dict[str, Any], header).get("alg") != "ES256":
            return None
        if not verify(self.public, f"{parts[0]}.{parts[1]}".encode(), signature):
            return None
        claims = cast(dict[str, Any], claims)
        exp = claims.get("exp")
        now = time.time() if now_s is None else now_s
        if isinstance(exp, int | float) and not isinstance(exp, bool) and exp <= now:
            return None
        return claims

    def is_speaker(self, token: str, room: str, now_s: float | None = None) -> bool:
        """The token is the speaker's of ``room``: signed by this key, unexpired, and may publish its slides."""
        claims = self.claims(token, now_s)
        if claims is None:
            return False
        return any(covers(p, slides_path(room)) for p in publish_paths(claims))
