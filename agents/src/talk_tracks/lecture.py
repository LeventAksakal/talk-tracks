# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportAttributeAccessIssue=false
"""A lecture file as a teacher broadcast: what the browser player and the agents read. Transport-free.

The teacher broadcast ``talk/<room>/teacher`` carries three tracks, in the hang format that ``@moq/watch`` plays:

* ``catalog.json``: the hang catalog (plain JSON, one object per group), naming the two media tracks below;
* ``video``: H.264 in the hang *legacy* container, one group per GOP (it opens with the keyframe), each object a QUIC
  varint of the media time in µs followed by one access unit in AVCC form; the catalog's ``description`` holds the
  avcC record, so WebCodecs needs no in-band parameter sets;
* ``audio``: Opus in the same legacy container, one 20 ms packet per object and per group: exactly what the speaker's
  browser publishes and what the agents already read.

The lecture file must be MP4 with H.264 (no B-frames) and Opus at 48 kHz; ``prepare-lecture`` in
``deploy/compose.local.yml`` makes one from any input with ffmpeg.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, Literal

import av

from .audio import write_varint

VIDEO_TRACK = "video"
AUDIO_TRACK = "audio"
CATALOG_TRACK = "catalog.json"


@dataclass(frozen=True)
class VideoInfo:
    codec: str  # WebCodecs codec string, e.g. avc1.64001f
    avcc: bytes  # the avcC record (the decoder description)
    width: int
    height: int
    fps: float | None


@dataclass(frozen=True)
class AudioInfo:
    sample_rate: int
    channels: int
    opus_head: bytes


@dataclass(frozen=True)
class LectureInfo:
    duration_ms: int
    video: VideoInfo | None
    audio: AudioInfo | None


@dataclass(frozen=True)
class MediaPacket:
    kind: Literal["video", "audio"]
    file_us: int  # presentation time from the start of the file
    keyframe: bool
    data: bytes


def avc_codec(avcc: bytes) -> str:
    """``avc1.PPCCLL`` from an avcC record: profile, constraint flags and level of the first SPS."""
    if len(avcc) < 4 or avcc[0] != 1:
        raise ValueError("H.264 without an avcC record: prepare the lecture as MP4 first")
    return f"avc1.{avcc[1]:02x}{avcc[2]:02x}{avcc[3]:02x}"


def _us(pts: int | None, time_base: Any) -> int:
    if pts is None or time_base is None:
        return 0
    return max(0, int(pts * Fraction(time_base.numerator, time_base.denominator) * 1_000_000))


def probe(path: Path) -> LectureInfo:
    with av.open(str(path)) as container:
        video: VideoInfo | None = None
        audio: AudioInfo | None = None
        for stream in container.streams.video[:1]:
            if stream.codec_context.name != "h264":
                raise ValueError(f"video must be H.264, got {stream.codec_context.name}: prepare the lecture first")
            avcc = bytes(stream.codec_context.extradata or b"")
            rate = stream.average_rate
            video = VideoInfo(
                avc_codec(avcc),
                avcc,
                stream.codec_context.width,
                stream.codec_context.height,
                float(rate) if rate else None,
            )
        for stream in container.streams.audio[:1]:
            if stream.codec_context.name != "opus" or stream.codec_context.sample_rate != 48_000:
                raise ValueError("audio must be Opus at 48 kHz: prepare the lecture first")
            audio = AudioInfo(48_000, stream.codec_context.channels, bytes(stream.codec_context.extradata or b""))
        if video is None and audio is None:
            raise ValueError(f"{path} has no video or audio")
        duration_us = 0
        for packet in container.demux():
            if packet.pts is not None and packet.size:
                end = packet.pts + (packet.duration or 0)
                duration_us = max(duration_us, _us(end, packet.time_base))
    return LectureInfo(duration_us // 1000, video, audio)


def packets(path: Path) -> Iterator[MediaPacket]:
    """Every video and audio packet in file (decode) order, with its presentation time."""
    with av.open(str(path)) as container:
        streams = [*container.streams.video[:1], *container.streams.audio[:1]]
        for packet in container.demux(*streams):
            if not packet.size:
                continue
            kind: Literal["video", "audio"] = "video" if packet.stream.type == "video" else "audio"
            yield MediaPacket(kind, _us(packet.pts, packet.time_base), bool(packet.is_keyframe), bytes(packet))


def legacy_frame(media_us: int, data: bytes) -> bytes:
    """The hang legacy container: a QUIC varint of the media time in µs, then the codec payload."""
    return write_varint(media_us) + data


def catalog(info: LectureInfo, extra: dict[str, object] | None = None) -> dict[str, object]:
    """The hang catalog of the teacher broadcast, as ``@moq/hang`` 0.5 validates it (``catalog/root.js``).

    ``extra`` adds application sections (the root is a loose object, so a player ignores what it does not know).
    """
    root: dict[str, object] = {}
    if info.video is not None:
        v = info.video
        rendition: dict[str, object] = {
            "codec": v.codec,
            "container": {"kind": "legacy"},
            "description": v.avcc.hex(),
            "codedWidth": v.width,
            "codedHeight": v.height,
        }
        if v.fps:
            rendition["framerate"] = v.fps
        root["video"] = {"renditions": {VIDEO_TRACK: rendition}, "display": {"width": v.width, "height": v.height}}
    if info.audio is not None:
        a = info.audio
        audio: dict[str, object] = {
            "codec": "opus",
            "container": {"kind": "legacy"},
            "sampleRate": a.sample_rate,
            "numberOfChannels": a.channels,
        }
        if a.opus_head:
            audio["description"] = a.opus_head.hex()
        root["audio"] = {"renditions": {AUDIO_TRACK: audio}}
    return {**root, **(extra or {})}
