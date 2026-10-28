"""Fragmented MP4 (ISO BMFF) for one track: an init segment and media segments a browser appends with MSE.

Just the boxes the archive needs, written by hand so the bytes are exact and need no encoder: ``ftyp`` + ``moov``
for the init segment, ``moof`` + ``mdat`` for each media segment. One track per file, timescale in µs, so sample
times are the teacher's media times with no offset. Codecs: Opus (``Opus`` + ``dOps``) and H.264 (``avc1`` +
``avcC``), both straight from the legacy container's payloads.
"""

from __future__ import annotations

import struct
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

TIMESCALE = 1_000_000
TRACK_ID = 1
SYNC_FLAGS = 0x02000000  # sample_depends_on = 2: decodes on its own
NON_SYNC_FLAGS = 0x01010000  # sample_depends_on = 1, sample_is_non_sync_sample
OPUS_SILENCE = {1: b"\xf8\xff\xfe", 2: b"\xfc\xff\xfe"}  # one 20 ms CELT frame of silence, mono and stereo
_MATRIX = struct.pack(">9I", 0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000)


@dataclass(frozen=True)
class TrackConfig:
    """What the init segment says about a track, taken from the hang catalog."""

    kind: Literal["audio", "video"]
    codec: str  # "opus" or a WebCodecs avc1 string
    description: bytes = b""  # OpusHead (optional) or the avcC record (required for video)
    sample_rate: int = 48_000
    channels: int = 1
    width: int = 0
    height: int = 0

    @property
    def mime(self) -> str:
        return f'{self.kind}/mp4; codecs="{self.codec}"'


@dataclass(frozen=True)
class Sample:
    time_us: int
    duration_us: int
    data: bytes
    sync: bool


def box(kind: bytes, *parts: bytes) -> bytes:
    payload = b"".join(parts)
    return struct.pack(">I", 8 + len(payload)) + kind + payload


def full_box(kind: bytes, version: int, flags: int, *parts: bytes) -> bytes:
    return box(kind, struct.pack(">I", (version << 24) | flags), *parts)


# --- init segment ---------------------------------------------------------------------------------------------


def dops(config: TrackConfig) -> bytes:
    """The ``dOps`` box: big-endian fields of the OpusHead (RFC 7845), or a plain one for the channel count."""
    head = config.description
    if len(head) >= 19 and head[:8] == b"OpusHead":
        channels, pre_skip, rate, gain, family = struct.unpack_from("<BHIhB", head, 9)
        body = struct.pack(">BBHIhB", 0, channels, pre_skip, rate, gain, family)
        if family != 0:
            body += head[19 : 21 + channels]  # stream count, coupled count, channel mapping
        return box(b"dOps", body)
    return box(b"dOps", struct.pack(">BBHIhB", 0, config.channels, 0, config.sample_rate, 0, 0))


def opus_channels(config: TrackConfig) -> int:
    head = config.description
    return head[9] if len(head) >= 19 and head[:8] == b"OpusHead" else config.channels


def sample_entry(config: TrackConfig) -> bytes:
    reserved = b"\x00" * 6 + struct.pack(">H", 1)  # data_reference_index 1
    if config.kind == "audio":
        if config.codec != "opus":
            raise ValueError(f"audio codec not supported: {config.codec}")
        audio = struct.pack(">IIHHHHI", 0, 0, opus_channels(config), 16, 0, 0, 48_000 << 16)
        return box(b"Opus", reserved, audio, dops(config))
    if not config.codec.startswith("avc1") or not config.description:
        raise ValueError(f"video must be H.264 with an avcC record, got {config.codec}")
    video = struct.pack(
        ">HHIIIHHIIIH32sHh",
        0,
        0,
        0,
        0,
        0,
        config.width,
        config.height,
        0x00480000,
        0x00480000,
        0,
        1,
        b"",
        0x0018,
        -1,
    )
    return box(b"avc1", reserved, video, box(b"avcC", config.description))


def init_segment(config: TrackConfig) -> bytes:
    audio = config.kind == "audio"
    mvhd = full_box(
        b"mvhd",
        0,
        0,
        struct.pack(">IIIIIH10s", 0, 0, 1000, 0, 0x00010000, 0x0100, b""),
        _MATRIX,
        b"\x00" * 24,
        struct.pack(">I", TRACK_ID + 1),
    )
    tkhd = full_box(
        b"tkhd",
        0,
        0x3,  # enabled, in movie
        struct.pack(">IIIII8sHHHH", 0, 0, TRACK_ID, 0, 0, b"", 0, 0, 0x0100 if audio else 0, 0),
        _MATRIX,
        struct.pack(">II", 0 if audio else config.width << 16, 0 if audio else config.height << 16),
    )
    mdhd = full_box(b"mdhd", 0, 0, struct.pack(">IIIIHH", 0, 0, TIMESCALE, 0, 0x55C4, 0))  # language "und"
    handler, name = (b"soun", b"SoundHandler\x00") if audio else (b"vide", b"VideoHandler\x00")
    hdlr = full_box(b"hdlr", 0, 0, struct.pack(">I4s12s", 0, handler, b""), name)
    media_header = full_box(b"smhd", 0, 0, struct.pack(">HH", 0, 0)) if audio else full_box(b"vmhd", 0, 1, b"\x00" * 8)
    dinf = box(b"dinf", full_box(b"dref", 0, 0, struct.pack(">I", 1), full_box(b"url ", 0, 1)))
    stbl = box(
        b"stbl",
        full_box(b"stsd", 0, 0, struct.pack(">I", 1), sample_entry(config)),
        full_box(b"stts", 0, 0, struct.pack(">I", 0)),
        full_box(b"stsc", 0, 0, struct.pack(">I", 0)),
        full_box(b"stsz", 0, 0, struct.pack(">II", 0, 0)),
        full_box(b"stco", 0, 0, struct.pack(">I", 0)),
    )
    trak = box(b"trak", tkhd, box(b"mdia", mdhd, hdlr, box(b"minf", media_header, dinf, stbl)))
    mvex = box(b"mvex", full_box(b"trex", 0, 0, struct.pack(">IIIII", TRACK_ID, 1, 0, 0, 0)))
    ftyp = box(b"ftyp", b"iso6", struct.pack(">I", 0), b"iso6", b"cmfc", b"isom", b"mp41")
    return ftyp + box(b"moov", mvhd, trak, mvex)


# --- media segments -------------------------------------------------------------------------------------------


def media_segment(sequence: int, samples: Sequence[Sample]) -> bytes:
    """``moof`` + ``mdat`` for samples back to back in decode order: the first one's time is ``tfdt``."""
    if not samples:
        raise ValueError("a media segment needs at least one sample")
    entries = b"".join(
        struct.pack(">III", s.duration_us, len(s.data), SYNC_FLAGS if s.sync else NON_SYNC_FLAGS) for s in samples
    )

    def moof(data_offset: int) -> bytes:
        trun = full_box(b"trun", 0, 0x000701, struct.pack(">Ii", len(samples), data_offset), entries)
        traf = box(
            b"traf",
            full_box(b"tfhd", 0, 0x020000, struct.pack(">I", TRACK_ID)),  # default-base-is-moof
            full_box(b"tfdt", 1, 0, struct.pack(">Q", samples[0].time_us)),
            trun,
        )
        return box(b"moof", full_box(b"mfhd", 0, 0, struct.pack(">I", sequence)), traf)

    size = len(moof(0))
    mdat = box(b"mdat", *(s.data for s in samples))
    return moof(size + 8) + mdat


# --- codec details ----------------------------------------------------------------------------------------------


def opus_duration_us(packet: bytes) -> int:
    """How long an Opus packet plays, from its TOC byte (RFC 6716 section 3.1)."""
    if not packet:
        return 0
    config = packet[0] >> 3
    if config < 12:
        frame = (10_000, 20_000, 40_000, 60_000)[config % 4]
    elif config < 16:
        frame = (10_000, 20_000)[config % 2]
    else:
        frame = (2_500, 5_000, 10_000, 20_000)[config % 4]
    code = packet[0] & 0x3
    frames = 1 if code == 0 else 2 if code in (1, 2) else (packet[1] & 0x3F if len(packet) > 1 else 1)
    return frame * frames


def avc_is_keyframe(access_unit: bytes, avcc: bytes) -> bool:
    """True when the AVCC access unit holds an IDR slice (NAL type 5)."""
    length_size = (avcc[4] & 0x3) + 1 if len(avcc) > 4 else 4
    i = 0
    while i + length_size <= len(access_unit):
        n = int.from_bytes(access_unit[i : i + length_size], "big")
        i += length_size
        if i < len(access_unit) and access_unit[i] & 0x1F == 5:
            return True
        i += n
    return False
