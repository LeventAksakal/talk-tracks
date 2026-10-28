# The track archive

Every room's tracks are kept as plain static files on the VM, served by Caddy under `/archive/` and copied to a cloud
bucket (decisions [0007](../decisions/0007-rewind-from-a-static-track-archive.md),
[0009](../decisions/0009-agents-restart-from-durable-track-history.md) and
[0011](../decisions/0011-track-history-in-a-vm-archive-copied-to-a-bucket.md)). Three readers use the same files:

* a **rewinding viewer** seeks anywhere in a room and plays media and agent tracks from the files;
* a **restarting agent** seeds itself from the newest snapshot of its own track;
* a **replacement VM** copies the bucket back and carries on.

The archiver (`python -m talk_tracks.archive`) follows every room under `talk/**` on the relay, as rooms appear, and
writes what it receives. It never publishes.

## One clock: media time

Everything in the archive is placed on the **room's media time**: the speaker's clock, read from the teacher
broadcast (the µs varint every legacy-container object starts with). This is the clock the recorder already uses
([demo rooms](demo-rooms.md#the-recording)), and the one agents already write into their states (caption
`start_ms`/`end_ms`, slide `at_ms`, chapter `start_ms`).

* **Media** samples keep their own media time, in µs, as MP4 timestamps. A player's `currentTime` in seconds is
  media time / 1000.
* **Agent snapshots and slide frames** are stamped with the newest teacher media time the archiver had seen when they
  arrived (`media_ms`), plus the wall clock (`wall_ms`). Stamped on arrival, a rewind shows each track exactly as late
  as it was live.
* Snapshots that arrive before any teacher media in a run are stamped with the run's last known media time (0 for a
  new run). A viewer shows them from the run's first media time on.

To show the room at media time `t`: play media from `t`, and for each agent show its last snapshot with
`media_ms <= t`. A snapshot is self-contained, so that one line is the whole state of the track.

### Runs

A room's life is split into **runs**, each with one continuous media clock. A new run starts when:

* the speaker's media time jumps back by more than 30 s (the publisher restarted its clock), or
* teacher media comes back after more than 10 minutes without any (a new talk in the same room).

Within a run, media time never goes backwards: late samples are dropped, and a snapshot is never stamped before the
one before it. A run's id is the wall-clock ms when it started (a decimal string, like agent instance names), so
runs sort by name.

## Layout

The archive root is `$TT_DATA/archive` on the VM (`/data/archive` in the containers) and `https://<host>/archive/`
on the web. All paths below are relative to it.

```
rooms.json                                   every archived room
<room>/room.json                             the room's runs
<room>/latest/<agent>.json                   the newest snapshot of each agent (restore)
<room>/<run>/run.json                        the run's full index: tracks, segments, agents, chunks, slides
<room>/<run>/teacher/catalog.json            the teacher broadcast's hang catalog, as last seen
<room>/<run>/teacher/<track>/init-<n>.mp4    fMP4 init segment (ftyp + moov), first used by segment n
<room>/<run>/teacher/<track>/<n>.m4s         fMP4 media segment n (moof + mdat), n as 6 digits
<room>/<run>/agents/<agent>/<n>.jsonl        snapshot chunk n, one RecordedSnapshot per line, n as 6 digits
<room>/<run>/slides/frames.jsonl             one line per slide shown
<room>/<run>/slides/<sha>.<jpg|png>          each distinct slide image once, named by its SHA-256 (first 16 hex)
```

`<track>` is the teacher track name (`audio`, and `video` when the broadcast has video). `<agent>` is the agent name
(`captions`, `translate-tr`, `describe`, `chapters`, ...).

A file appears only once complete (written to a temporary name, then renamed), except the one open snapshot chunk
per agent and `slides/frames.jsonl`, which grow by whole lines. Media segments (`.m4s`) and init segments never
change once written; JSON indexes are rewritten in place.

### `rooms.json`

```json
{"format": "talk-tracks-archive", "v": 1,
 "rooms": [{"room": "live", "first_wall_ms": 1761650000000, "last_wall_ms": 1761653600000, "runs": 2}]}
```

### `<room>/room.json`

```json
{"format": "talk-tracks-archive", "v": 1, "room": "live",
 "runs": [{"run": "1761650000000", "started_wall_ms": 1761650000000, "last_wall_ms": 1761653600000,
           "media_first_ms": 1520, "media_last_ms": 3600480}]}
```

Runs are in order; the last one is the newest (and the one still being written, if the room is live).

### `<room>/<run>/run.json`

```json
{
  "format": "talk-tracks-archive", "v": 1, "room": "live", "run": "1761650000000",
  "started_wall_ms": 1761650000000, "last_wall_ms": 1761653600000,
  "media_first_ms": 1520, "media_last_ms": 3600480,
  "tracks": [
    {"track": "audio", "kind": "audio", "codec": "opus", "mime": "audio/mp4; codecs=\"opus\"",
     "timescale": 1000000, "sample_rate": 48000, "channels": 1,
     "segments": [{"n": 0, "init": "init-0.mp4", "start_ms": 1520, "end_ms": 7540, "samples": 301, "bytes": 24310},
                  {"n": 1, "init": "init-0.mp4", "start_ms": 7540, "end_ms": 13560, "samples": 301, "bytes": 23990}]},
    {"track": "video", "kind": "video", "codec": "avc1.64001f", "mime": "video/mp4; codecs=\"avc1.64001f\"",
     "timescale": 1000000, "width": 1280, "height": 720, "segments": []}
  ],
  "agents": [
    {"info": {"name": "captions", "label": "Captions (English)", "model": "..."},
     "chunks": [{"n": 0, "snapshots": 42, "first_media_ms": 0, "last_media_ms": 9800,
                 "first_wall_ms": 1761650000100, "last_wall_ms": 1761650010050, "open": false},
                {"n": 1, "snapshots": 7, "first_media_ms": 10400, "last_media_ms": 12100,
                 "first_wall_ms": 1761650010400, "last_wall_ms": 1761650012100, "open": true}]}
  ],
  "slides": {"frames": 3, "first_media_ms": 2000, "last_media_ms": 70000}
}
```

* Segments of a track are in media-time order and back to back: a segment's `end_ms` is the next one's `start_ms`,
  except across a gap (the speaker paused or the archiver was down). `end_ms` is exclusive.
* `init` names the init segment to append before a segment; it changes only if the codec setup changes mid-run.
* Chunks of an agent are in order and do not overlap. At most one chunk per agent is `open` (still growing); it is
  the last one.

## Media segments

Fragmented MP4 (ISO BMFF, the CMAF shape), one track per file, so a browser plays it with Media Source Extensions:
one `SourceBuffer` per track, append the init segment, then the media segments.

* **Timescale 1 000 000** (µs): sample times are the teacher's media time exactly, with no offset. `tfdt` is the
  first sample's media time; append segments as they are and the `<video>`/`<audio>` element's `currentTime` is
  media time in seconds.
* **Audio**: Opus, sample entry `Opus` with a `dOps` box (from the catalog's `description` when it has one,
  otherwise mono or the catalog's channel count at 48 kHz, pre-skip 0). Every packet is a sync sample.
* **Video**: H.264 (`avc1`, the avcC record from the catalog's `description`), sync samples at IDR frames. A video
  segment always opens with a keyframe. There are no B-frames (the looper requires none, decode order is
  presentation order).
* **Size**: a segment closes at the first sync sample at least **6 s** after its start, or when the track has been
  silent for 3 s (the speaker paused or left). Speaker audio is about 32 kbit/s: about 24 KB per segment, 15 MB an
  hour. Video at 1–2 Mbit/s is 0.75–1.5 MB per segment.
* Only `legacy`-container tracks are archived; a track in another container is skipped with a warning.

A broadcast without `catalog.json` (the dev `teacher` stand-in) is archived as one Opus track `audio`, mono, 48 kHz.

## Agent snapshot chunks

Each line is a `RecordedSnapshot`, the same model as a demo recording's `agents/<agent>.jsonl`
(`contracts/recorded-snapshot.schema.json`): `media_ms`, `wall_ms`, `instance`, `seq`, `usage`, `state`.

* Only state changes are kept: the archiver follows each agent's newest instance and drops heartbeats (a repeated
  `seq`), as the recorder does.
* A chunk closes **10 s** (wall clock) after its first line, or at 4 MB, so a finished chunk reaches the bucket
  within seconds even when the speaker is silent. Captions are the largest track (a snapshot carries the last 40
  lines): roughly 10–40 MB an hour.
* To find the state at `t`: take the last chunk with `first_media_ms <= t`, read it, and keep the last line with
  `media_ms <= t`.

## Slides

`slides/frames.jsonl` has one line per slide change (a repeated frame with the same id and image is not written
again):

```json
{"media_ms": 2000, "wall_ms": 1761650002000, "id": 0, "at_ms": 0, "mime": "image/png", "file": "3f9a0c1d2e4b5a69.png"}
```

`file` is relative to the `slides/` folder; `at_ms` is the frame's own field from the slides track.

## Restore: `<room>/latest/<agent>.json`

The newest snapshot of each agent in the room, across runs, rewritten on every state change:

```json
{"format": "talk-tracks-archive", "v": 1, "room": "live", "run": "1761650000000",
 "info": {"name": "captions", "label": "Captions (English)", "model": "..."},
 "snapshot": {"media_ms": 12100, "wall_ms": 1761650012100, "instance": "1761650000000", "seq": 49,
              "usage": {"requests": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0},
              "state": {"kind": "captions", "lang": "en", "lines": [], "interim": ""}}}
```

A restarted agent reads it (`talk_tracks.archive.restore.latest`) and carries on from that state with its ids
continuing. The captions agent does this through `statefile.load_captions`: it takes whichever of its local state
file and the archive has the newer lines.

## Serving

Caddy serves the root under `/archive/` with range requests and the site's cross-origin isolation headers
(`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, plus
`Cross-Origin-Resource-Policy: same-origin`). Media and init segments are `immutable`; JSON and JSONL are
`no-cache` (revalidated by ETag), and compressed on the fly.
