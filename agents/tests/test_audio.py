# pyright: reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportAttributeAccessIssue=false
import av
import numpy as np

from talk_tracks.audio import AudioAssembler, read_varint, split_legacy, write_varint


def opus_frames(n: int, tone_hz: float = 440.0) -> list[bytes]:
    enc = av.CodecContext.create("libopus", "w")
    enc.sample_rate, enc.layout, enc.format = 48_000, "mono", "s16"  # pyright: ignore[reportAttributeAccessIssue]
    enc.open()  # pyright: ignore[reportAttributeAccessIssue]
    out: list[bytes] = []
    t = np.arange(960 * n) / 48_000
    pcm = (np.sin(2 * np.pi * tone_hz * t) * 8000).astype(np.int16)
    for i in range(n):
        frame = av.AudioFrame.from_ndarray(pcm[i * 960 : (i + 1) * 960].reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate = 48_000
        frame.pts = i * 960
        out.extend(bytes(p) for p in enc.encode(frame))  # pyright: ignore[reportAttributeAccessIssue]
    return out


def payload(media_us: int, packet: bytes) -> bytes:
    return write_varint(media_us) + packet


def test_varint_round_trip() -> None:
    for v in (0, 63, 64, 16383, 16384, 1_000_000, 1_073_741_823, 5_000_000_000):
        enc = write_varint(v)
        assert read_varint(enc) == (v, len(enc))


def test_split_legacy() -> None:
    assert split_legacy(payload(123_456, b"abc")) == (123_456, b"abc")


def test_in_order_frames_decode_to_16k() -> None:
    frames = opus_frames(30)
    asm = AudioAssembler()
    total = 0
    for i, f in enumerate(frames):
        total += sum(len(chunk) for chunk, _ in asm.push(payload(i * 20_000, f)))
    total += sum(len(chunk) for chunk, _ in asm.flush())
    assert abs(total - 30 * 320) <= 320 * 2  # about 600 ms at 16 kHz, minus codec delay


def test_late_group_is_reordered_not_dropped() -> None:
    frames = opus_frames(12)
    asm = AudioAssembler()
    order = [0, 1, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11]
    total = 0
    for i in order:
        total += sum(len(c) for c, _ in asm.push(payload(i * 20_000, frames[i])))
    total += sum(len(c) for c, _ in asm.flush())
    assert total >= 11 * 320


def test_gap_in_media_time_is_filled_with_silence() -> None:
    frames = opus_frames(4)
    asm = AudioAssembler()
    chunks: list[tuple[int, int]] = []
    for media_us, f in ((0, frames[0]), (20_000, frames[1]), (1_000_000, frames[2]), (1_020_000, frames[3])):
        chunks.extend((len(c), end) for c, end in asm.push(payload(media_us, f)))
    chunks.extend((len(c), end) for c, end in asm.flush())
    total = sum(n for n, _ in chunks)
    assert total >= 16_000  # one second of media time came out as one second of samples
    assert chunks[-1][1] == 1_040


def test_publisher_restart_resyncs_instead_of_dropping_everything() -> None:
    frames = opus_frames(16)
    asm = AudioAssembler()
    ends: list[int] = []
    for i in range(8):  # 40 s into the talk
        ends.extend(end for _, end in asm.push(payload(40_000_000 + i * 20_000, frames[i])))
    for i in range(8):  # the speaker's page reloaded: its clock starts at zero again
        ends.extend(end for _, end in asm.push(payload(i * 20_000, frames[8 + i])))
    ends.extend(end for _, end in asm.flush())
    assert ends[-1] == 160  # the new clock is followed, not dropped as late
