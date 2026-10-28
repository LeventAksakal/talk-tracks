"""HLS playlists over the archived fMP4 segments: what hls.js and Safari play to rewind the speaker (design §5.5).

Per room, beside ``room.json``:

* ``index.m3u8``: the multivariant playlist, video with the speaker's audio as its own rendition (an audio group), or
  audio alone;
* ``video.m3u8`` and ``audio.m3u8``: every run's segments in room time, one rendition of each kind per run.

Every segment carries ``EXT-X-PROGRAM-DATE-TIME`` = E + room time (the broadcast's shift included), so a player maps
its playhead to room time by subtracting E. Each new teacher broadcast starts with ``EXT-X-DISCONTINUITY`` and its own
``EXT-X-MAP``; a hole of ``GAP_MIN_MS`` up to ``HOLE_GAP_MAX_MS`` is covered by ``EXT-X-GAP`` segments, and a longer one
(a talk resumed the next day) is only the jump in PROGRAM-DATE-TIME after the discontinuity, so a playlist stays
small. The playlists are EVENT playlists: appended to while the teacher is live, ended (``EXT-X-ENDLIST``) when not.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from .store import RunIndex, SegmentEntry, TrackEntry

GAP_MIN_MS = 1_000
HOLE_GAP_MAX_MS = 600_000
GAP_STEP_MS = 4_000
MIN_TARGET_S = 6
INDEX, AUDIO, VIDEO = "index.m3u8", "audio.m3u8", "video.m3u8"


def pdt(wall_ms: int) -> str:
    return datetime.fromtimestamp(wall_ms / 1000, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def pick(run: RunIndex, kind: Literal["audio", "video"]) -> TrackEntry | None:
    """The run's rendition of ``kind``: the largest video, the audio track named ``audio`` first."""
    found = [t for t in run.tracks if t.kind == kind and t.segments]
    if not found:
        return None
    if kind == "video":
        return max(found, key=lambda t: ((t.width or 0) * (t.height or 0), t.track))
    return min(found, key=lambda t: (t.track != "audio", t.track))


def _seconds(ms: int) -> str:
    return f"{ms / 1000:.3f}"


def media_playlist(
    epoch_ms: int, runs: Sequence[RunIndex], kind: Literal["audio", "video"], *, live: bool
) -> str | None:
    chosen = [(run, track) for run in runs if (track := pick(run, kind)) is not None]
    if not chosen:
        return None
    longest = max(s.end_ms - s.start_ms for _, t in chosen for s in t.segments)
    target = max(MIN_TARGET_S, -(-longest // 1000))
    body: list[str] = []
    prev: tuple[int, str] | None = None  # (end in room time, uri) of the segment before
    for i, (run, track) in enumerate(chosen):
        folder = f"{run.run}/teacher/{track.track}/"
        init: str | None = None
        for n, segment in enumerate(track.segments):
            uri = f"{folder}{segment.n:06d}.m4s"
            if prev is not None:
                body += _gap(epoch_ms, prev, segment)
            if n == 0 and i > 0:
                body.append("#EXT-X-DISCONTINUITY")
            if segment.init != init:
                init = segment.init
                body.append(f'#EXT-X-MAP:URI="{folder}{init}"')
            body.append(f"#EXT-X-PROGRAM-DATE-TIME:{pdt(epoch_ms + segment.start_ms)}")
            body.append(f"#EXTINF:{_seconds(segment.end_ms - segment.start_ms)},")
            body.append(uri)
            prev = (segment.end_ms, uri)
    head = [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        f"#EXT-X-TARGETDURATION:{target}",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:EVENT",
        "#EXT-X-INDEPENDENT-SEGMENTS",
    ]
    return "\n".join([*head, *body, *([] if live else ["#EXT-X-ENDLIST"])]) + "\n"


def _gap(epoch_ms: int, prev: tuple[int, str], segment: SegmentEntry) -> list[str]:
    """``EXT-X-GAP`` segments over the hole before ``segment``, at most ``GAP_STEP_MS`` each. Their URI is the
    segment before, which a player never loads (it may, harmlessly, if it ignores the tag)."""
    end, uri = prev
    hole = segment.start_ms - end
    if not GAP_MIN_MS <= hole <= HOLE_GAP_MAX_MS:
        return []
    lines: list[str] = []
    t = end
    while t < segment.start_ms:
        step = min(GAP_STEP_MS, segment.start_ms - t)
        lines += [f"#EXT-X-PROGRAM-DATE-TIME:{pdt(epoch_ms + t)}", "#EXT-X-GAP", f"#EXTINF:{_seconds(step)},", uri]
        t += step
    return lines


def _peak_bps(runs: Sequence[RunIndex], kind: Literal["audio", "video"]) -> int:
    peak = 0
    for run in runs:
        track = pick(run, kind)
        for s in track.segments if track else []:
            peak = max(peak, s.bytes * 8 * 1000 // max(1, s.end_ms - s.start_ms))
    return peak


def master_playlist(runs: Sequence[RunIndex]) -> str | None:
    audio = next((t for run in reversed(runs) if (t := pick(run, "audio")) is not None), None)
    video = next((t for run in reversed(runs) if (t := pick(run, "video")) is not None), None)
    if audio is None and video is None:
        return None
    lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"]
    bandwidth = max(1, _peak_bps(runs, "audio") + _peak_bps(runs, "video"))
    if video is None:
        assert audio is not None
        lines += [f'#EXT-X-STREAM-INF:BANDWIDTH={bandwidth},CODECS="{audio.codec}"', AUDIO]
    else:
        codecs = video.codec if audio is None else f"{video.codec},{audio.codec}"
        stream = f'#EXT-X-STREAM-INF:BANDWIDTH={bandwidth},CODECS="{codecs}"'
        if video.width and video.height:
            stream += f",RESOLUTION={video.width}x{video.height}"
        if audio is not None:
            lines.append(
                f'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Speaker",DEFAULT=YES,AUTOSELECT=YES,'
                f'CHANNELS="{audio.channels or 1}",URI="{AUDIO}"'
            )
            stream += ',AUDIO="audio"'
        lines += [stream, VIDEO]
    return "\n".join(lines) + "\n"


def playlists(epoch_ms: int, runs: Sequence[RunIndex], *, live: bool) -> dict[str, str]:
    """The room's playlists by file name; those with nothing to list are left out."""
    files = {
        INDEX: master_playlist(runs),
        AUDIO: media_playlist(epoch_ms, runs, "audio", live=live),
        VIDEO: media_playlist(epoch_ms, runs, "video", live=live),
    }
    return {name: text for name, text in files.items() if text is not None}
