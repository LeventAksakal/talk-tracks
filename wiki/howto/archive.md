# The track archive

Every room's tracks are kept as plain files on the VM and copied to a cloud bucket (decisions
[0011](../decisions/0011-track-history-in-a-vm-archive-copied-to-a-bucket.md) and
[0012](../decisions/0012-ai-track-history-by-fetch-from-the-agent.md); the design is
[the track system](../design/moq-track-system.md), §5.4–§5.10). Two writers share one folder:

* **Each agent records its own tracks**, object by object as it publishes them, in 4 s **slices** by group number,
  and answers FETCH for its track's past from them (disk, then the bucket). This is the
  [slice store](#agent-tracks-the-slice-store), a library in `talk_tracks.archive.slices`.
* **The room service** (`python -m talk_tracks.archive`) records what browsers publish, which cannot serve history
  itself: the speaker's media as fMP4 segments, played back over HTTP with MSE (decision 0007 stands for media), and
  the slide frames. It publishes each room's [catalog](#the-room-catalog), and copies everything, the agents' slices
  included, to the bucket.

The room service never subscribes to an agent track: a subscription is demand, and would keep a lazy agent (decision
0010) awake. A replacement VM copies the bucket back and carries on under the same names and group numbers.

## One clock: room time

Everything in the archive is placed on the **room time** of [the room clock](../design/moq-track-system.md#45-the-room-clock)
(addendum to decision 0012): the speaker's media timestamp (the µs varint every legacy-container object starts with)
plus the broadcast's `offset_ms`. The speaker console publishes the offset on track `clock` in `talk/<room>/slides`,
`{"epoch_ms", "offset_ms", "session"}`, before it publishes audio. Room time never goes back across reloads or new
broadcasts, and has holes where nobody broadcast.

* The room service holds a teacher broadcast's media until that broadcast's `clock` object arrives, for up to 5 s.
  No `clock` by then (the demo looper, which already writes room time; the dev `teacher` stand-in) means offset 0.
  It reads the clock again whenever the teacher broadcast is announced again.
* **Media** samples are written at room time, in µs, as MP4 timestamps. A player's `currentTime` in seconds is
  room time / 1000.
* **Agent slices** are cut on it by the agents: group `k` covers room time `[4k, 4k+4)` s, so slice `⌊t/4000⌋` holds
  room time `t` ms.
* **Slide frames** are stamped with the newest room time the room service had seen when they arrived (`media_ms`),
  plus the wall clock (`wall_ms`).

To show the room at room time `t`: play media from `t`, and FETCH each agent track's slice `⌊t/4000⌋` (and its
neighbours) through the relay.

### Runs

Each speaker broadcast (a `clock` session) is a **run**: its own folder of media segments, slides and indexes. Runs
are metadata, not separate clocks: all runs of a room are on the one room time and never overlap, so a player plays
them as one timeline with holes. A broadcast without a clock stays in the current run. A run's id is the wall-clock
ms when it started (a decimal string), so runs sort by name; `run.json` names its `session` and `offset_ms`, and
`room.json` the room's `epoch_ms`.

Media time going back within a run is a clock bug, not a late sample: the samples are dropped and a warning is
logged.

## Layout

The archive root is `$TT_DATA/archive` on the VM (`/data/archive` in the containers) and `https://<host>/archive/`
on the web. All paths below are relative to it.

```
rooms.json                                   every archived room
<room>/room.json                             the room's runs
<room>/<run>/run.json                        the run's full index: tracks, segments, slides
<room>/<run>/teacher/catalog.json            the teacher broadcast's hang catalog, as last seen
<room>/<run>/teacher/<track>/init-<n>.mp4    fMP4 init segment (ftyp + moov), first used by segment n
<room>/<run>/teacher/<track>/<n>.m4s         fMP4 media segment n (moof + mdat), n as 6 digits
<room>/<run>/slides/frames.jsonl             one line per slide shown
<room>/<run>/slides/<sha>.<jpg|png>          each distinct slide image once, named by its SHA-256 (first 16 hex)
<room>/agents/<agent>/<track>/<k>.part       an agent's open slice k, k as 8 digits (written by the agent)
<room>/agents/<agent>/<track>/<k>.slice      a finished slice, immutable
<room>/agents/<agent>/<track>/track.json     what the catalog says about the track
```

`<track>` is the teacher track name (`audio`, and `video` when the broadcast has video). `<agent>` is the agent name
(`captions`, `translate-tr`, `describe`, `chapters`, ...). Agent slices are per room, not per run: their group
numbers come from room time (see [slices and room time](#slices-and-room-time)).

A file appears only once complete (written to a temporary name, then renamed), except an open slice (`.part`) and
`slides/frames.jsonl`, which grow by whole lines. Media segments (`.m4s`) and init segments never
change once written; JSON indexes are rewritten in place.

### `rooms.json`

```json
{"format": "talk-tracks-archive", "v": 1,
 "rooms": [{"room": "live", "first_wall_ms": 1761650000000, "last_wall_ms": 1761653600000, "runs": 2}]}
```

### `<room>/room.json`

```json
{"format": "talk-tracks-archive", "v": 1, "room": "live", "epoch_ms": 1761650000000,
 "runs": [{"run": "1761650000000", "session": "1761650000000", "started_wall_ms": 1761650000000,
           "last_wall_ms": 1761653600000, "media_first_ms": 1520, "media_last_ms": 3600480}]}
```

Runs are in order; the last one is the newest (and the one still being written, if the room is live).

### `<room>/<run>/run.json`

```json
{
  "format": "talk-tracks-archive", "v": 1, "room": "live", "run": "1761650000000",
  "session": "1761650000000", "offset_ms": 0,
  "started_wall_ms": 1761650000000, "last_wall_ms": 1761653600000,
  "media_first_ms": 1520, "media_last_ms": 3600480, "media_last_wall_ms": 1761653600000,
  "tracks": [
    {"track": "audio", "kind": "audio", "codec": "opus", "mime": "audio/mp4; codecs=\"opus\"",
     "timescale": 1000000, "sample_rate": 48000, "channels": 1,
     "segments": [{"n": 0, "init": "init-0.mp4", "start_ms": 1520, "end_ms": 7540, "samples": 301, "bytes": 24310},
                  {"n": 1, "init": "init-0.mp4", "start_ms": 7540, "end_ms": 13560, "samples": 301, "bytes": 23990}]},
    {"track": "video", "kind": "video", "codec": "avc1.64001f", "mime": "video/mp4; codecs=\"avc1.64001f\"",
     "timescale": 1000000, "width": 1280, "height": 720, "segments": []}
  ],
  "slides": {"frames": 3, "first_media_ms": 2000, "last_media_ms": 70000}
}
```

* `media_last_wall_ms` is the wall clock of the last teacher media (it decides when a new run starts).
* Segments of a track are in media-time order and back to back: a segment's `end_ms` is the next one's `start_ms`,
  except across a gap (the speaker paused or the archiver was down). `end_ms` is exclusive.
* `init` names the init segment to append before a segment; it changes only if the codec setup changes mid-run.

## Media segments

Fragmented MP4 (ISO BMFF, the CMAF shape), one track per file, so a browser plays it with Media Source Extensions:
one `SourceBuffer` per track, append the init segment, then the media segments.

* **Timescale 1 000 000** (µs): sample times are room time (the teacher's media time plus the broadcast's offset).
  `tfdt` is the first sample's room time; append segments as they are and the `<video>`/`<audio>` element's
  `currentTime` is room time in seconds.
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

## Agent tracks: the slice store

Every AI track except the outline cuts group `k` as room time `[4k, 4k+4)` s. Object 0 is a small carry-in state;
items follow, one per object, and the group ends with End of Group (decision 0012). The agent that publishes a track
records every object it sends, and its FETCH handler reads the slice back, so live and fetched copies are
byte-identical.

```
<room>/agents/<agent>/<track>/00001234.part    slice 1234 while it is open, one line per object
<room>/agents/<agent>/<track>/00001234.slice   slice 1234 once finished (renamed at End of Group)
```

One JSON line per object, in object order. The payload is kept byte for byte: as text when it is UTF-8 (`t`),
otherwise base64 (`b`). Priority (`p`), subgroup (`sg`), extensions (`x`, base64 values) and status (`st`) are
written only when they are not the defaults (128, 0, none, 0):

```json
{"o":0,"t":"{\"kind\":\"carry\",\"lines\":[...]}"}
{"o":1,"t":"{\"kind\":\"item\",\"id\":17,...}","p":224}
{"o":2,"st":3}
```

The last line of a finished slice is its End of Group (`st` 3), or End of Track (`st` 4) for the last slice of a
talk. An empty slice (a capped answer, say) is that one line.

The library, `talk_tracks.archive.slices` (no transport code; the agents' publish path calls it):

| Call | When |
|---|---|
| `TrackArchive(room, agent, track, bucket=archive_bucket(), info=TrackInfo(kind, lang=..., depends=[...]))` | once per published track |
| `.write(k, SliceObject(object_id, payload, ...))` | beside each object sent; ids rise within a group; a back-fill may write a past group beside the live one |
| `.end_group(k, end_of_track=False)` | when the slice is over; returns the finished `Slice` |
| `await .read(k)` | in the FETCH handler: disk (finished or open), then the bucket (then kept on disk); `None` means never produced, so back-fill |
| `.latest_group()` | on restart: seed from that slice, continue at the next one |
| `.discard(k)` | before back-filling a slice a killed process left open |
| `.set_status("idle" \| "live" \| "capped")` | for the catalog |

`SliceObject` uses aiomoqt's field names (`FetchObject(group_id=k, **obj.fields())`); `Slice.last_object_id` is the
End Location's object for FETCH_OK. Writing a finished slice, or one another process left open, raises
`SliceExists`: objects are immutable. One process writes a track at a time (stable names), so writers never contend.

### Slices and room time

Slice numbers come from room time, which never goes back, so they never repeat in a room. Writing a slice that
exists (`SliceExists`) is therefore a bug: two publishers of one track, or a clock that went back.

## Slides

`slides/frames.jsonl` has one line per slide change (a repeated frame with the same id and image is not written
again):

```json
{"media_ms": 2000, "wall_ms": 1761650002000, "id": 0, "at_ms": 0, "mime": "image/png", "file": "3f9a0c1d2e4b5a69.png"}
```

`file` is relative to the `slides/` folder; `at_ms` is the frame's own field from the slides track.

## The room catalog

The room service publishes `talk/<room>/catalog`, track `catalog`: one JSON object per group, a new group on every
change and every 4 s (under moq-relay's 5 s max age, so a late joiner always gets the latest). Shaped after the MoQ
streaming format's catalog (draft-ietf-moq-msf-01 §5):

```json
{"version": 1, "room": "live", "epoch_ms": 1761650000000, "end_ms": 3604000, "archive": "/archive/live/room.json",
 "tracks": [
  {"namespace": "talk/live/teacher", "name": "audio", "kind": "audio", "packaging": "legacy", "codec": "opus",
   "status": "live", "cost": "free"},
  {"namespace": "talk/live/slides", "name": "frames", "kind": "slides", "packaging": "snapshot", "status": "live",
   "cost": "free"},
  {"namespace": "talk/live/agents/translate-tr", "name": "items", "kind": "translation", "label": "Türkçe",
   "lang": "tr", "packaging": "slices", "sliceMs": 4000, "depends": ["talk/live/agents/captions/items"],
   "cost": "paid", "status": "idle"}]}
```

* Speaker tracks come from the hang catalog while `talk/<room>/teacher` is announced; slides while
  `talk/<room>/slides` is.
* Agent tracks are listed while `talk/<room>/agents/<agent>` is announced and the track has a `track.json` (written
  by `TrackArchive(..., info=...)`, its status by `set_status`). Nothing here subscribes to an agent track.
* `archive` is where the media rewind starts (HTTP, MSE).
* `epoch_ms` (the wall time of the room's first broadcast) and `end_ms` (the latest room time archived: the speaker's
  media, or the end of the newest agent slice) are what the speaker console reads to choose a new broadcast's
  offset. The room service publishes the catalog of every archived room, on air or not, so a returning speaker
  finds them.
* Demo rooms the room service skips (`TT_ARCHIVE_SKIP`) get no catalog from it; their looper publishes one.

## Serving

Caddy serves the root under `/archive/` with range requests and the site's cross-origin isolation headers
(`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, plus
`Cross-Origin-Resource-Policy: same-origin`). Media and init segments are `immutable`; JSON and JSONL are
`no-cache` (revalidated by ETag), and compressed on the fly.

## Running it

`python -m talk_tracks.archive` in the agents image (service `archive` in both compose files):

| Setting | Default | What it does |
|---|---|---|
| `TT_RELAY` / `--relay` | | The relay to follow |
| `TT_TOKEN` / `--token` | unset | A relay token that may publish `talk/*/catalog` (on the VM: `TT_ARCHIVE_TOKEN` in `.env`) |
| `TT_ARCHIVE_DIR` / `--out` | `data/archive` | The archive root (`/data/archive` in the containers) |
| `TT_ARCHIVE_ROOMS` / `--rooms` | `*` | Room patterns to archive, comma-separated |
| `TT_ARCHIVE_SKIP` / `--skip` | (compose: the demo room) | Room patterns not to archive: a looped demo room's recording already is its archive, and its video would grow the archive by about 1 GB an hour |
| `TT_ARCHIVE_BUCKET` / `--bucket` | unset | `gs://<bucket>[/<folder>]` to copy to (folder default `archive`); unset, nothing is copied |
| `--no-catalog` | off | Record only; publish no room catalogs |

Agents write their slices where `TT_ARCHIVE_DIR` points, by default `archive/` beside their state folder
(`TT_STATE_DIR`): `/data/archive` on the VM (their `$TT_DATA` mount), `/app/data/archive` locally, where compose
mounts `data/archive/` read-write. They read missing slices from `TT_ARCHIVE_BUCKET` (the same variable).

Locally, `archive-files` serves `data/archive/` over HTTP on port `TT_ARCHIVE_PORT` (default 8090), as Caddy serves
it under `/archive/` on the VM.

When the relay session closes, the archiver exits and Docker restarts it. It picks up the room's last run from the
indexes and carries on: segment numbers continue, a new init segment is written.

### The bucket copy

* Each finished file (a media segment, an init segment, a slide image, an agent's finished slice) is uploaded as soon
  as it is closed. The room service finds the agents' slices by their folders' modification times, once a second.
  Indexes, `frames.jsonl` and `track.json` are uploaded at most every 2 s while they change. Open slices (`.part`)
  are not copied.
* At start the archiver lists the bucket and uploads whatever is missing or a different size, so uploads queued when
  it stopped are not lost. Failed uploads are retried with backoff; the archive on disk never waits for them.
* Credentials are the VM's service account, from the metadata server. It needs **`roles/storage.objectUser` on the
  one bucket** (not the project): create to add files, delete to replace the indexes. The VM's access scopes must
  allow Cloud Storage writes (`storage-rw` or `cloud-platform`; the default scope is read-only).
* At most a few seconds of history are lost with the VM: each agent's open slice (4 s), the open media segment (6 s)
  and what is in flight.
* Agents read from the bucket too (a slice missing on disk); the same role covers it.

## Restore a lost VM

About 15 minutes by hand. History comes back from the bucket; what is not in the bucket must come from elsewhere
(see the list at the end).

1. **A new VM** as in [deploy](deploy.md): Docker with compose, ports TCP 80 and 443 and UDP 443 open, the same
   service account with Cloud Storage write scope, and the DNS record pointed at its address.
2. **Clone and configure**:

   ```bash
   git clone <repo> ~/talk-tracks
   mkdir -p ~/tt-data/archive ~/tt-keys ~/tt-secrets && chmod 700 ~/tt-secrets
   # deploy/.env as before (TT_HOST, TT_KEYS, TT_DATA, TT_ARCHIVE_BUCKET, ...), mode 600
   ```

3. **Copy the history back** (the archive is in the bucket's `archive/` folder):

   ```bash
   gcloud storage rsync --recursive gs://$BUCKET/archive ~/tt-data/archive
   ```

4. **Images and web app**: build the agents image on the VM
   (`cd ~/talk-tracks/agents && docker build -q -t talk-tracks-agents:dev .`), copy the relay and auth images and
   `web/dist` from a local build as in [deploy](deploy.md#update), and create the Caddy volumes
   (`docker volume create moq_caddy_data && docker volume create moq_caddy_config`; Caddy gets a new certificate).
5. **Start**: `docker compose -f deploy/compose.vm.yml up -d`, plus `--profile live` for the live agents.
6. **Check**:
   * `curl -s https://<host>/archive/rooms.json` lists the rooms, and a room's `room.json` its runs;
   * the archiver's log says `bucket copy: 0 files to catch up` (`docker compose -f deploy/compose.vm.yml logs archive`);
   * a FETCH of an old slice is answered (the agent reads it from the restored disk), and agents continue at the next
     slice.

Not in the bucket, so restored from elsewhere:

* `~/tt-keys`: the signing key never leaves the VM. A new key pair means new tokens for the speaker, the looper and
  the agents and the room service (`TT_LOOPER_TOKEN`, `TT_AGENT_TOKEN`, `TT_ARCHIVE_TOKEN` in `.env`), signed as in
  [tokens](tokens.md).
* `~/tt-secrets/meta.env`: from the owner.
* `~/tt-data/demo/`: the demo recordings. Copy them to the bucket once (`gcloud storage rsync --recursive
  ~/tt-data/demo gs://$BUCKET/demo`) and back the same way.
* `~/tt-data/ledger.jsonl`: the spend ledger. Copy it to the bucket after spending runs, or start the new ledger
  with a carry-over line for the total spent, as was done for the laptop.
