# pyright: reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportAttributeAccessIssue=false
"""Teacher audio in, 16 kHz mono PCM out, at real time.

@moq/publish writes the "legacy" container: a QUIC variable-length integer holding the media time in microseconds,
then one Opus packet, one 20 ms frame per object and per group. Groups can arrive out of order under load, and Opus
silence suppression leaves gaps in media time, so the assembler reorders in a small window and fills gaps with
silence. Meta's realtime ASR needs audio at real time and closes the stream when it is not.
"""

from __future__ import annotations

import heapq
from dataclasses import dataclass, field

import av
import numpy as np
from numpy.typing import NDArray

SAMPLE_RATE = 16_000
FRAME_US = 20_000
REORDER_FRAMES = 5  # hold up to 100 ms to put late groups back in order
MAX_FILL_US = 30_000_000  # a gap longer than this is a restart, not silence: resync instead of filling


def read_varint(data: bytes) -> tuple[int, int]:
    """QUIC variable-length integer: the top two bits of the first byte give the length."""
    n = 1 << (data[0] >> 6)
    value = data[0] & 0x3F
    for i in range(1, n):
        value = (value << 8) | data[i]
    return value, n


def write_varint(value: int) -> bytes:
    for length, limit in ((1, 1 << 6), (2, 1 << 14), (4, 1 << 30), (8, 1 << 62)):
        if value < limit:
            prefix = {1: 0, 2: 1, 4: 2, 8: 3}[length] << (8 * length - 2)
            return (prefix | value).to_bytes(length, "big")
    raise ValueError("varint too large")


def split_legacy(payload: bytes) -> tuple[int, bytes]:
    """(media time in microseconds, Opus packet)."""
    media_us, used = read_varint(payload)
    return media_us, payload[used:]


@dataclass
class OpusDecoder:
    _ctx: av.AudioCodecContext | None = field(default=None, init=False)
    _resampler: av.AudioResampler | None = field(default=None, init=False)

    def _reset(self) -> None:
        ctx = av.CodecContext.create("libopus", "r")
        ctx.sample_rate = 48_000
        ctx.layout = "stereo"
        self._ctx = ctx  # pyright: ignore[reportAttributeAccessIssue]
        self._resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)

    def decode(self, packet: bytes) -> NDArray[np.int16]:
        if not packet:  # an empty packet puts PyAV's Opus decoder into end-of-stream mode
            return np.zeros(0, dtype=np.int16)
        if self._ctx is None or self._resampler is None:
            self._reset()
        assert self._ctx is not None and self._resampler is not None
        try:
            frames = self._ctx.decode(av.Packet(packet))  # pyright: ignore[reportAttributeAccessIssue]
        except (av.error.EOFError, av.error.InvalidDataError):
            self._reset()
            return np.zeros(0, dtype=np.int16)
        out: list[NDArray[np.int16]] = []
        for frame in frames:
            for resampled in self._resampler.resample(frame):
                out.append(np.asarray(resampled.to_ndarray(), dtype=np.int16).reshape(-1))
        return np.concatenate(out) if out else np.zeros(0, dtype=np.int16)


class OpusEncoder:
    """48 kHz mono PCM in, one Opus packet per 20 ms frame out. For test publishers that stand in for a browser."""

    FRAME = 960

    def __init__(self) -> None:
        ctx = av.CodecContext.create("libopus", "w")
        ctx.sample_rate, ctx.layout, ctx.format = 48_000, "mono", "s16"
        ctx.open()
        self._ctx = ctx
        self._pts = 0

    def encode(self, frame48k: NDArray[np.int16]) -> list[bytes]:
        frame = av.AudioFrame.from_ndarray(frame48k.reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate = 48_000
        frame.pts = self._pts
        self._pts += len(frame48k)
        return [bytes(p) for p in self._ctx.encode(frame)]


class AudioAssembler:
    """Reorders frames by media time, decodes them and fills gaps, yielding (pcm, media end in ms)."""

    def __init__(self, decoder: OpusDecoder | None = None) -> None:
        self._decoder = decoder or OpusDecoder()
        self._heap: list[tuple[int, int, bytes]] = []
        self._tie = 0
        self._next_us: int | None = None

    def push(self, payload: bytes) -> list[tuple[NDArray[np.int16], int]]:
        media_us, packet = split_legacy(payload)
        out: list[tuple[NDArray[np.int16], int]] = []
        newest = max((t for t, _, _ in self._heap), default=self._next_us)
        if newest is not None and media_us < newest - MAX_FILL_US:
            # Far behind everything so far: the speaker's publisher restarted its clock. Finish the old run first.
            out = [self._emit() for _ in range(len(self._heap))]
            self._next_us = None
        self._tie += 1
        heapq.heappush(self._heap, (media_us, self._tie, packet))
        while len(self._heap) > REORDER_FRAMES:
            out.append(self._emit())
        return [x for x in out if len(x[0])]

    def flush(self) -> list[tuple[NDArray[np.int16], int]]:
        out = [self._emit() for _ in range(len(self._heap))]
        return [x for x in out if len(x[0])]

    def _emit(self) -> tuple[NDArray[np.int16], int]:
        media_us, _, packet = heapq.heappop(self._heap)
        decoded = self._decoder.decode(packet)
        if self._next_us is not None and media_us < self._next_us:
            return np.zeros(0, dtype=np.int16), self._next_us // 1000  # too late to place: drop (no concealment)
        gap = 0 if self._next_us is None else media_us - self._next_us
        pcm = decoded
        if 0 < gap <= MAX_FILL_US:
            pcm = np.concatenate([np.zeros(gap * SAMPLE_RATE // 1_000_000, dtype=np.int16), decoded])
        duration_us = max(FRAME_US, len(decoded) * 1_000_000 // SAMPLE_RATE)
        self._next_us = media_us + duration_us
        return pcm, self._next_us // 1000
