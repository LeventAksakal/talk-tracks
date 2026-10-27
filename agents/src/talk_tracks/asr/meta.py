"""Muse Voice Transcribe over its realtime WebSocket, in ENDPOINTING mode.

The server wants audio at real time (it closes the stream with 1008 when it falls 10 s behind or runs 5 s ahead),
so the caller feeds frames as they arrive and fills the gaps Opus silence suppression leaves with silence.
Turns map to caption lines: ``speechStart`` opens one, partial ``transcript`` events update the interim text,
``speechComplete`` makes the final line. Media time = session start offset + the server's ``audioProcessedMs``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from typing import Any

import numpy as np
import websockets
from numpy.typing import NDArray
from websockets.asyncio.client import ClientConnection

from .base import AsrEvent, AsrFinal, AsrPartial, AsrSession

URL = "wss://api.meta.ai/v1/asr/realtime"
MODEL = "muse-voice-transcribe-1.0"
SAMPLE_RATE = 16_000
FRAME_SAMPLES = SAMPLE_RATE * 80 // 1000  # 80 ms, as in Meta's examples


class MetaAsrError(RuntimeError):
    pass


class MetaVoiceAsrSession:
    def __init__(self, ws: ClientConnection, offset_ms: int) -> None:
        self._ws = ws
        self._offset_ms = offset_ms
        self._events: asyncio.Queue[AsrEvent] = asyncio.Queue()
        self._turn_start: dict[int, int] = {}
        self._pending: NDArray[np.int16] = np.zeros(0, dtype=np.int16)
        self._reader = asyncio.create_task(self._read())
        self.error: str | None = None

    async def _read(self) -> None:
        try:
            async for raw in self._ws:
                if isinstance(raw, bytes):
                    continue
                self._on_message(json.loads(raw))
        except websockets.ConnectionClosed:
            pass

    def _on_message(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "speechStart":
            self._turn_start[int(msg["turnId"])] = int(msg["audioProcessedMs"])
        elif kind == "transcript":
            self._events.put_nowait(AsrPartial(str(msg["transcript"])))
        elif kind == "speechComplete":
            end = int(msg["audioProcessedMs"])
            start = self._turn_start.pop(int(msg["turnId"]), end)
            self._events.put_nowait(
                AsrFinal(str(msg.get("transcript", "")), self._offset_ms + start, self._offset_ms + max(start, end))
            )
        elif kind == "error":
            self.error = str(msg.get("message", msg))

    async def feed(self, pcm16k: NDArray[np.int16], end_ms: int) -> list[AsrEvent]:
        if self.error:
            raise MetaAsrError(self.error)
        self._pending = np.concatenate([self._pending, pcm16k])
        while len(self._pending) >= FRAME_SAMPLES:
            frame, self._pending = self._pending[:FRAME_SAMPLES], self._pending[FRAME_SAMPLES:]
            await self._ws.send(frame.tobytes())
        return self._drain()

    def _drain(self) -> list[AsrEvent]:
        out: list[AsrEvent] = []
        while not self._events.empty():
            out.append(self._events.get_nowait())
        return out

    @property
    def closed(self) -> bool:
        return self._reader.done()

    async def close(self) -> list[AsrEvent]:
        if not self._reader.done():
            if len(self._pending):
                await self._ws.send(self._pending.tobytes())
            await self._ws.send(json.dumps({"type": "endStream"}))
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(asyncio.shield(self._reader), timeout=10)
        self._reader.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._reader
        await self._ws.close()
        return self._drain()


class MetaVoiceAsr:
    """Opens one realtime session per call. ``offset_ms`` is the media time at which the session's audio starts."""

    def __init__(self, api_key: str, *, url: str = URL) -> None:
        if not (url.startswith("wss://api.meta.ai/") or url.startswith("ws://127.0.0.1")):
            raise ValueError("the Meta API key is only ever sent to api.meta.ai (or a loopback test server)")
        self._key = api_key
        self._url = url

    async def open(self, language: str, offset_ms: int = 0) -> AsrSession:
        ws = await websockets.connect(f"{self._url}?sessionId=tt-{uuid.uuid4()}", open_timeout=30, ping_interval=None)
        await ws.send(
            json.dumps(
                {
                    "authorization": {"accessToken": f"Bearer {self._key}"},
                    "audioEncoding": "PCM_16KHZ",
                    "model": MODEL,
                    "mode": "ENDPOINTING",
                }
            )
        )
        ack = json.loads(await ws.recv())
        if "sessionId" not in ack:
            await ws.close()
            raise MetaAsrError(f"handshake refused: {ack.get('message', 'no detail')}")
        return MetaVoiceAsrSession(ws, offset_ms)
