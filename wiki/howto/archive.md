# The track archive

Every room's tracks are kept as plain files on the VM and copied to a cloud bucket (decisions
[0011](../decisions/0011-track-history-in-a-vm-archive-copied-to-a-bucket.md) and
[0012](../decisions/0012-ai-track-history-by-fetch-from-the-agent.md); the design is
[the track system](../design/moq-track-system.md), §5.4–§5.10). Two writers share one folder:

* **Each agent records its own tracks**, object by object as it publishes them, in 4 s **slices** by group number,
  and answers FETCH for its track's past from them (disk, then the bucket). This is the
  [slice store](#agent-tracks-the-slice-store), a library in `talk_tracks.archive.slices`.
* **The room service** (`python -m talk_tracks.archive`) records what browsers publish, which cannot serve history
  itself: the speaker's media as fMP4 segments with [HLS playlists](#hls-playlists), played back over HTTP with
  hls.js or Safari's own player, and the slide frames. It sets the room's clock, publishes each room's
  [catalog](#the-room-catalog), and copies everything, the agents' slices included, to the bucket.

The room service never subscribes to an agent track: a subscription is demand, and would keep a lazy agent (decision
0010) awake. A replacement VM copies the bucket back and carries on under the same names and group numbers.

## One clock: room time

Everything in the archive is placed on the **room time** of [the room clock](../design/moq-track-system.md#45-the-room-clock),
in ms:

> room time = wall time of the media timestamp − `E` + the broadcast's shift

* **Wall time** comes from the teacher's hang catalog: its root `clock` `{"wall", "timescale"}` gives the wall time
  of PTS zero (`timescale` units since 2020-01-01T00:00:00Z, µs by default, as @moq/publish writes it). A sample's
  wall time in Unix ms is `1577836800000 + 1000 × wall / timescale + pts_ms`, where `pts` is the µs varint every
  legacy-container object starts with.
* **`E`**, the room's epoch, is the wall time of the first teacher media the room service ever saw in the room,
  rounded down to a multiple of 4 s. It is set once, kept in `room.json` and published in the catalog (`tt.epoch`).
* **The shift** is decided once per teacher broadcast (one `clock.wall`), when its first media arrives: 0, unless that
  media maps onto room time already used, by the speaker's media or by any agent's slice (a device with a slow
  clock). Then it is the whole slices that put it after the last used slice; a slice partly used counts as used. It
  is kept in `room.json` and published in the catalog (`tt.shift`, keyed by `clock.wall`) at once: every consumer
  applies the same shift, and stamps nothing from a broadcast until the catalog lists it.
* **A broadcast without `clock`** in its catalog is refused: none of its tracks is read, and an error is logged.

Room time never goes back, across reloads and new broadcasts, and has holes where nobody broadcast.

* **Media** samples are written at room time, in µs, as MP4 timestamps (`tfdt`).
* **Agent slices** are cut on it by the agents: group `k` covers room time `[4k, 4k+4)` s, so slice `⌊t/4000⌋` holds
  room time `t` ms.
* **Slide frames** are stamped with the newest room time of the current broadcast when they arrive (`room_ms`), plus
  the wall clock (`wall_ms`).
* **A player** maps its playhead to room time through `EXT-X-PROGRAM-DATE-TIME` (hls.js `playingDate`, Safari
  `getStartDate()` plus `currentTime`): room time = that date − `E`. The shift is already in the playlist.

To show the room at room time `t`: play media at `E + t` and FETCH each agent track's slices `⌊t/4000⌋ − 1 …
⌊(t+L)/4000⌋` through the relay (`L` is the track's `tt.latenessMs`).

### Runs

Each teacher broadcast (one `clock.wall`) is a **run**: its own folder of media segments, slides and indexes. Runs
are metadata, not separate clocks: all runs of a room are on the one room time and never overlap, so a player plays
them as one timeline with holes. A speaker whose network drops and who reconnects from the same page keeps the
broadcast, and its run. A run's id is the Unix ms of its broadcast's PTS zero (a decimal string, raised past the
previous run's if needed), so runs sort by name; `run.json` names its `broadcast` and `shift_ms`.

Media time going back within a run is a clock bug, not a late sample: the samples are dropped and a warning is
logged.

## Layout

The archive root is `$TT_DATA/archive` on the VM (`/data/archive` in the containers) and `https://<host>/archive/`
on the web. All paths below are relative to it.

```
rooms.json                                   every archived room
<room>/room.json                             the room's epoch, shifts and runs
<room>/index.m3u8                            HLS multivariant playlist: start rewind here
<room>/video.m3u8, <room>/audio.m3u8         HLS media playlists over every run
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
change once written; JSON indexes and playlists are rewritten in place.

### `rooms.json`

```json
{"format": "talk-tracks-archive", "v": 2,
 "rooms": [{"room": "live", "first_wall_ms": 1761650000000, "last_wall_ms": 1761653600000, "runs": 2}]}
```

### `<room>/room.json`

```json
{"format": "talk-tracks-archive", "v": 2, "room": "live", "epoch_ms": 1761650000000,
 "shift": {"183813200000000": 0, "183813203600000": 4000},
 "runs": [{"run": "1761650000000", "broadcast": "183813200000000", "shift_ms": 0,
           "started_wall_ms": 1761650000950, "last_wall_ms": 1761650030000,
           "media_first_ms": 950, "media_last_ms": 30000}]}
```

Runs are in order; the last one is the newest (and the one still being written, if the room is live). `shift` maps
each broadcast's `clock.wall` to its shift in ms.

### `<room>/<run>/run.json`

```json
{
  "format": "talk-tracks-archive", "v": 2, "room": "live", "run": "1761650000000",
  "broadcast": "183813200000000", "origin_ms": 1761650000000, "shift_ms": 0,
  "started_wall_ms": 1761650000950, "last_wall_ms": 1761650030000,
  "media_first_ms": 950, "media_last_ms": 30000,
  "tracks": [
    {"track": "audio", "kind": "audio", "codec": "opus", "mime": "audio/mp4; codecs=\"opus\"",
     "timescale": 1000000, "sample_rate": 48000, "channels": 1,
     "segments": [{"n": 0, "init": "init-0.mp4", "start_ms": 950, "end_ms": 4010, "samples": 153, "bytes": 12310},
                  {"n": 1, "init": "init-0.mp4", "start_ms": 4010, "end_ms": 8010, "samples": 200, "bytes": 15990}]},
    {"track": "video", "kind": "video", "codec": "avc1.64001f", "mime": "video/mp4; codecs=\"avc1.64001f\"",
     "timescale": 1000000, "width": 1280, "height": 720, "segments": []}
  ],
  "slides": {"frames": 3, "first_ms": 2000, "last_ms": 70000}
}
```

* All `_ms` fields except the `wall_ms` ones are room time. `origin_ms` is the wall time of the broadcast's PTS zero.
* Segments of a track are in room-time order and back to back: a segment's `end_ms` is the next one's `start_ms`,
  except across a gap (the speaker paused or the archiver was down). `end_ms` is exclusive.
* `init` names the init segment to play a segment with; it changes when the codec setup changes, or when the archiver
  restarted mid-run.

## Media segments

Fragmented MP4 (ISO BMFF, the CMAF shape), one track per file: audio and video are separate renditions, played
together through the [HLS playlists](#hls-playlists).

* **Timescale 1 000 000** (µs): sample times are room time; `tfdt` is the first sample's room time.
* **Audio**: Opus, sample entry `Opus` with a `dOps` box (from the catalog's `description` when it has one,
  otherwise mono or the catalog's channel count at 48 kHz, pre-skip 0). Every packet is a sync sample.
* **Video**: H.264 (`avc1`), sync samples at IDR frames. With a `description` in the catalog (the looper) it is the
  avcC record and samples are already length-prefixed. Without one (@moq/publish: Annex B), each access unit is
  converted: start codes become 4-byte lengths, SPS, PPS and access unit delimiters move out of the samples, and the
  avcC record is built from the newest SPS and PPS (a keyframe carries them; a change starts a new init segment).
  Video before the first SPS and PPS is dropped. A video segment always opens with a keyframe. There are no B-frames
  (decode order is presentation order). @moq/publish sends a keyframe every 2 s by default (the console sets 4 s),
  so nothing is transcoded.
* **Audio only** is a valid room: today's console sends no video, and `index.m3u8` then lists the audio playlist
  alone.
* **Size**: segments are cut on the **4 s grid** of room time (the slices): audio at the first sample in the next
  4 s slice, video at the first keyframe in it, so a video segment is 4 s with keyframes every 2 s. A segment also
  closes when its track has been silent for 3 s (the speaker paused or left). Speaker audio is about 32 kbit/s: about
  16 KB per segment, 15 MB an hour. Video at 1–2 Mbit/s is 0.5–1 MB per segment.
* Gaps in the speaker's audio up to 10 s (silence suppression) are filled with Opus silence; a longer gap starts a
  new segment after a hole.
* Only `legacy`-container tracks are archived; a track in another container is skipped with a warning.
* The archiver used about 10 % of one core while recording a 15 fps broadcast on a laptop (the work is per frame, not
  per pixel).

## HLS playlists

The room service rewrites each room's playlists whenever a segment is added (`no-cache` on the web, so a player
always sees the newest):

* `index.m3u8`, the multivariant playlist: the video rendition with the speaker's audio as an alternate audio
  rendition (`EXT-X-MEDIA:TYPE=AUDIO`, group `audio`), or the audio alone when no broadcast had video. `CODECS` and
  `RESOLUTION` are the newest run's.
* `video.m3u8` and `audio.m3u8`: every run's segments, in room time. Each run uses one rendition of each kind (the
  largest video; the audio track named `audio`).

```
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:EVENT
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="1761650000000/teacher/audio/init-0.mp4"
#EXT-X-PROGRAM-DATE-TIME:2025-10-28T11:13:20.950Z
#EXTINF:3.060,
1761650000000/teacher/audio/000000.m4s
...
#EXT-X-PROGRAM-DATE-TIME:2025-10-28T11:13:50.000Z
#EXT-X-GAP
#EXTINF:4.000,
1761650000000/teacher/audio/000007.m4s
#EXT-X-DISCONTINUITY
#EXT-X-MAP:URI="1761650060000/teacher/audio/init-0.mp4"
#EXT-X-PROGRAM-DATE-TIME:2025-10-28T11:14:24.120Z
...
#EXT-X-ENDLIST
```

* **`EXT-X-PROGRAM-DATE-TIME`** on every segment is `E` + its room time (the shift included).
* **`EXT-X-DISCONTINUITY`** starts each new broadcast, followed by its own `EXT-X-MAP`.
* **`EXT-X-GAP`** covers each hole of 1 s to 10 minutes, in steps of at most 4 s (their URI is the segment before,
  which a player does not load). A longer hole (the talk resumed the next day) is only the jump in
  PROGRAM-DATE-TIME after the discontinuity, so a playlist stays small.
* **EVENT playlists**: appended to while the teacher is live, `EXT-X-ENDLIST` when the teacher is gone or has sent
  no media for 30 s (moq-relay does not always report a publisher that left); new media removes it again. A player that
  loaded an ended playlist does not see a later broadcast until it reloads it; the live talk itself is on MoQ.
* **Checked with hls.js 1.5** (Chrome): two broadcasts, the second shifted, play as one timeline; a seek into a hole
  lands on the next broadcast, and `playingDate` − `E` is room time. **Not yet checked on Safari** (native HLS: Opus
  in fMP4, `EXT-X-GAP`): that needs a Mac or an iPhone. If Safari does not play Opus from fMP4 the audio is
  transcoded to AAC; if it ignores `EXT-X-GAP`, holes become a discontinuity with a jump in PROGRAM-DATE-TIME.

## Agent tracks: the slice store

Every AI track except the outline cuts group `k` as room time `[4k, 4k+4)` s. Object 0 is a small carry-in state;
items follow, one per object, and the group ends with End of Group (decision 0012). The agent that publishes a track
records every object it sends, and its FETCH handler reads the slice back, so live and fetched copies are
byte-identical.

```
<room>/agents/<agent>/<track>/00001234.part    slice 1234 while it is open, one line per object
<room>/agents/<agent>/<track>/00001234.slice   slice 1234 once finished (linked from .part at End of Group)
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
| `.create(k, [SliceObject, ...], end_of_track=False)` | a whole slice at once, only if nobody wrote it (back-fill): returns `(slice on disk, created)`; when another process wrote it first, finished or still open, serve that copy |
| `await .read(k)` | in the FETCH handler: disk (finished or open), then the bucket (then kept on disk); `None` means never produced, so back-fill |
| `await .last_object(k)` | the slice's last published object, end marker left out (a snapshot track's state at the slice's end); `None` when it has none |
| `.latest_group()` | on restart: seed from that slice, continue at the next one |
| `.discard(k)` | before back-filling a slice a killed process left open |
| `.report(status, producing=, fetches_served=, backfills=, spend_usd=)` | for the catalog's `tt.status`: on every change and as a heartbeat at least every 5 s (a `track.json` older than 15 s counts as idle); `status` is `idle`, `live` or `capped`, the counts are this track's totals in the room |

`SliceObject` uses aiomoqt's field names (`FetchObject(group_id=k, **obj.fields())`); `Slice.last_object_id` is the
End Location's object for FETCH_OK. **Each slice is written once:** the first writer wins, atomically (a hard link
onto the final name; where hard links are not supported, a rename guarded by an existence check). Checked on
ext4, overlayfs, the Docker Desktop bind mount (9p) and NTFS: 16 processes racing for one slice, one writer, one copy
served. Writing a finished slice, or one another process holds open, raises `SliceExists`, and so does
`end_group` when another process finished the slice first; its `existing` is the copy to serve. Objects are
immutable.

`TrackInfo(kind, label, lang, depends, cost, lateness_ms)` is written to `track.json` with `status`: `kind` is
`captions`, `translation`, `slides` or `outline`, from which the catalog derives the MSF `eventType` and `role`;
`depends` lists the tracks it reads as `<agent>/<track>`; `lateness_ms` is `L`.

### Slices and room time

Slice numbers come from room time, which never goes back, so a room never reuses one: the room service shifts a
broadcast whose media would land on a used slice. Two writers of one slice (a back-fill and resuming live work near
a slice boundary) are settled by the write-once rule: the first wins, the other serves its copy.

## Slides

`slides/frames.jsonl` has one line per slide change (a repeated frame with the same id and image is not written
again). A slide shown before the broadcast's first media waits for it (only the latest such frame):

```json
{"room_ms": 2000, "wall_ms": 1761650002000, "id": 0, "at_ms": 0, "mime": "image/png", "file": "3f9a0c1d2e4b5a69.png"}
```

`file` is relative to the `slides/` folder; `at_ms` is the frame's own field from the slides track.

## The room catalog

The room service publishes `talk/<room>/catalog`, track `catalog`: an MSF catalog (draft-ietf-moq-msf-01 §5), one
whole catalog per group (object 0), a new group on every change and every 4 s (under moq-relay's 5 s max age, so a
late joiner always gets the latest). A new broadcast's shift is published at once, not at the next tick. Nothing is
published before the room has an epoch. The document is built by `talk_tracks.room_catalog`, which the looper uses
for the demo rooms too, with the field names locked in [the lane briefs](../design/lane-briefs.md) ("Catalog field
names"). Read it as raw JSON: `@moq/msf` 0.3.1 drops the fields it does not declare.

```json
{"version": "draft-01",
 "tt": {"epoch": 1761650000000, "shift": {"183813200000000": 0, "183813203600000": 4000},
        "status": {"captions": {"status": "live", "producing": true, "fetches_served": 12,
                                "backfills": 0, "spend_usd": 0.0421, "updated_ms": 1761650030000}}},
 "tracks": [
  {"name": "items", "namespace": "talk/live/agents/captions", "packaging": "eventtimeline",
   "mimeType": "application/json", "eventType": "urn:msf:captions:webvtt", "role": "caption", "lang": "en",
   "label": "", "isLive": true, "template": [0, 4000, [0, 0], [1, 0], 1761650000000, 4000],
   "tt": {"dependsOn": [], "latenessMs": 8000, "cost": "paid"}},
  {"name": "items", "namespace": "talk/live/agents/translate-tr", "packaging": "eventtimeline",
   "mimeType": "application/json", "eventType": "urn:msf:captions:webvtt", "role": "subtitle", "lang": "tr",
   "label": "Türkçe", "isLive": true, "template": [0, 4000, [0, 0], [1, 0], 1761650000000, 4000],
   "tt": {"dependsOn": ["talk/live/agents/captions/items"], "latenessMs": 12000, "cost": "paid"}},
  {"name": "outline", "namespace": "talk/live/agents/chapters", "packaging": "eventtimeline",
   "mimeType": "application/json", "eventType": "com.talktracks.outline", "lang": "", "label": "", "isLive": true,
   "tt": {"dependsOn": ["talk/live/agents/captions/items"], "latenessMs": 0, "cost": "paid"}}]}
```

* **Tracks** are the AI tracks: listed while `talk/<room>/agents/<agent>` is announced and the track has a
  `track.json` (written by `TrackArchive(..., info=...)`). Nothing here subscribes to an agent track.
* `eventType` is `urn:msf:captions:webvtt` for captions and translations (`role` `caption` and `subtitle`),
  `com.talktracks.slides` for slide descriptions and `com.talktracks.outline` for the outline. `template` (MSF §7.4)
  says group `k` starts at `E + 4000 k` ms; the outline, one group per revision, has none.
* **`tt`** at the root: `epoch` (E), `shift` (ms per broadcast, keyed by `clock.wall`) and `status`. In a track:
  `dependsOn` (full track paths: `<agent>/<track>` in `TrackInfo.depends` becomes `talk/<room>/agents/<agent>/<track>`;
  a full path such as `talk/<room>/slides/frames` is kept), `latenessMs` and `cost`.
* **`tt.status.<agent>`** sums what each of its tracks last wrote with `TrackArchive.report`: `status` (the highest of
  `idle`, `live`, `capped`), `producing`, `fetches_served`, `backfills`, `spend_usd` and `updated_ms` (the
  newest). A `track.json` older than 15 s counts as idle and not producing. When the spend ledger shows the room at
  its cap, or the build at its ceiling, every paid agent's `status` is `capped`. Status is in the root because MSF forbids
  changing a declared track.
* The speaker's media is at `/archive/<room>/index.m3u8` ([HLS playlists](#hls-playlists)).
* The room service publishes the catalog of every archived room, on air or not. Demo rooms it skips
  (`TT_ARCHIVE_SKIP`) get no catalog from it; their looper publishes one.

## Serving

Caddy serves the root under `/archive/` with range requests and the site's cross-origin isolation headers
(`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, plus
`Cross-Origin-Resource-Policy: same-origin`). Media and init segments are `immutable`; JSON, JSONL and playlists are
`no-cache` (revalidated by ETag), and compressed on the fly. Playlists are served as `application/vnd.apple.mpegurl`,
segments as `video/iso.segment`.

## Running it

`python -m talk_tracks.archive` in the agents image (service `archive` in both compose files):

| Setting | Default | What it does |
|---|---|---|
| `TT_RELAY` / `--relay` | | The relay to follow |
| `TT_TOKEN` / `--token` | unset | A relay token that may publish `talk/*/catalog` (on the VM: `TT_ARCHIVE_TOKEN` in `.env`) |
| `TT_ARCHIVE_DIR` / `--out` | `data/archive` | The archive root (`/data/archive` in the containers) |
| `TT_ARCHIVE_ROOMS` / `--rooms` | `*` | Room patterns to archive, comma-separated |
| `TT_ARCHIVE_SKIP` / `--skip` | (compose: the demo room) | Room patterns not to archive: a looped demo room's recording already is its archive, and its video would grow the archive by about 1 GB an hour. Its archive is one file instead: `archive/<room>/lecture.mp4`, a hard link to the looper's `demo/<room>/lecture.mp4`, which the viewer plays at room time modulo the loop length (`web/src/playback/loopArchive.ts`). Caddy caches `.mp4` forever, so a replaced lecture needs a new file name |
| `TT_ARCHIVE_BUCKET` / `--bucket` | unset | `gs://<bucket>[/<folder>]` to copy to (folder default `archive`); unset, nothing is copied |
| `--no-catalog` | off | Record only; publish no room catalogs |
| `TT_LEDGER`, `TT_CAPS_DIR` | `data/ledger.jsonl`, `data/caps` | The agents' spend ledger and judge caps, read for `capped` (on the VM the archiver mounts `$TT_DATA` like the agents) |
| `TT_ROOM_CAP_USD`, `TT_SPEND_CEILING_USD` | 2, 100 | The default room cap and the build's ceiling |

Agents write their slices where `TT_ARCHIVE_DIR` points, by default `archive/` beside their state folder
(`TT_STATE_DIR`): `/data/archive` on the VM (their `$TT_DATA` mount), `/app/data/archive` locally, where compose
mounts `data/archive/` read-write. They read missing slices from `TT_ARCHIVE_BUCKET` (the same variable).

Locally, `archive-files` serves `data/archive/` over HTTP on port `TT_ARCHIVE_PORT` (default 8090), as Caddy serves
it under `/archive/` on the VM.

When the relay session closes, the archiver exits and Docker restarts it. It picks up each room's epoch, shifts and
last run from the indexes and carries on: the same broadcast continues its run, segment numbers continue, a new init
segment is written.

### The bucket copy

Currently off: `TT_ARCHIVE_BUCKET` is unset on the VM and its storage scope is read-only, so nothing below happens
and the archive lives on the VM disk only. The rest of this section is how it works once switched on.

* Each finished file (a media segment, an init segment, a slide image, an agent's finished slice) is uploaded as soon
  as it is closed. The room service finds the agents' slices by their folders' modification times, once a second.
  Indexes, `frames.jsonl` and `track.json` are uploaded at most every 2 s while they change. Open slices (`.part`)
  are not copied.
* Files that never change (slices, media and init segments, slide images) are uploaded **create-only**
  (`ifGenerationMatch=0`): an object already in the bucket is never replaced. A 412 means another writer got there
  first; it is logged and their copy is kept, as on disk.
* At start the archiver lists the bucket and uploads whatever is missing or a different size, so uploads queued when
  it stopped are not lost. Failed uploads are retried with backoff; the archive on disk never waits for them.
* Credentials are the VM's service account, from the metadata server. It needs **`roles/storage.objectUser` on the
  one bucket** (not the project): create to add files, delete to replace the indexes. The VM's access scopes must
  allow Cloud Storage writes (`storage-rw` or `cloud-platform`; the default scope is read-only).
* At most a few seconds of history are lost with the VM: each agent's open slice (4 s), the open media segment (4 s)
  and what is in flight.
* Agents read from the bucket too (a slice missing on disk); the same role covers it.

## Deploy the room service to the VM

The coordinator deploys; this is the checklist for the locked design (room clock, MSF catalog, HLS). The general
steps are in [deploy](deploy.md#update). Nothing below goes in git: the bucket name, hostname and tokens stay in
`deploy/.env` on the VM.

**What changes**

| Where | Change |
|---|---|
| `deploy/compose.vm.yml`, service `archive` | mounts `${TT_DATA}:/data` (was only `${TT_DATA}/archive`), so it reads the spend ledger; new env `TT_LEDGER`, `TT_CAPS_DIR`, `TT_ROOM_CAP_USD`, `TT_SPEND_CEILING_USD`; `TT_ARCHIVE_SKIP` defaults to `TT_DEMO_ROOMS` |
| `deploy/Caddyfile`, `/archive/*` | `*.m3u8` is `no-cache` and `application/vnd.apple.mpegurl`; `*.m4s` is `video/iso.segment` |
| `deploy/.env` | `TT_ARCHIVE_TOKEN`: a token that may publish `talk/*/catalog` and subscribe `talk/**` (unset only if the relay lets anyone publish) |
| the agents image | rebuilt from `main`: the archiver is `python -m talk_tracks.archive` in it |
| `$TT_DATA/archive` | format `v: 2`. An earlier archive (`v: 1`, from before the room clock) is not read: move it aside first |

**Steps**

1. Before anything, keep what runs now, for a roll-back:

   ```bash
   ssh $VM 'docker tag talk-tracks-agents:dev talk-tracks-agents:before-archive-v2'
   ssh $VM 'cd ~/talk-tracks && git rev-parse HEAD > ~/tt-data/before-archive-v2.commit'
   ```

2. Move an old-format archive aside (its media predates E and cannot be placed on room time). Agents' slices in it
   go too; they are from before decision 0012's names as well:

   ```bash
   ssh $VM 'grep -ls "\"v\": 1" ~/tt-data/archive/*/room.json ~/tt-data/archive/rooms.json'
   ssh $VM 'docker compose -f ~/talk-tracks/deploy/compose.vm.yml stop archive; mv ~/tt-data/archive ~/tt-data/archive-v1'
   ```

   If there is no `archive` folder at all, run `ssh $VM 'mkdir ~/tt-data/archive'` before starting anything: otherwise
   Docker creates it as root through Caddy's mount and the archiver cannot write to it.

   If the bucket copy is on, its `archive/` folder holds the same old files; a later restore would bring them back.
   Move them in the bucket too (`gcloud storage mv gs://$BUCKET/archive gs://$BUCKET/archive-v1`), or restore
   with care.
3. Sign `TT_ARCHIVE_TOKEN` if `.env` lacks it ([sign a token](deploy.md#sign-a-token-on-the-vm), with
   `--publish "talk/*/catalog" --subscribe "talk/**"` and a long expiry), then pull, rebuild and start as in
   [deploy](deploy.md#update) (which also covers re-signing `TT_LOOPER_TOKEN` and removing the old looper container
   when the demo rooms change), then `docker compose -f deploy/compose.vm.yml up -d --force-recreate caddy archive`:
   the Caddyfile is a single-file mount, which `git pull` replaces, so only a new container is sure to read it.

**Check after the deploy**

* `docker compose -f deploy/compose.vm.yml logs archive` shows `connected to relay`, `archiving into /data/archive`,
  and, once a speaker broadcasts, `epoch E = ...`, `broadcast ..., shift 0 ms` and `run ...`. A `refusing the
  teacher broadcast: its catalog has no clock` means the speaker's page publishes no hang `clock`.
* After 20 s of a test broadcast in room `R`:
  * `curl -sI https://<host>/archive/R/index.m3u8` is 200 with `application/vnd.apple.mpegurl` and `no-cache`; a
    segment (`curl -sI` on a `.m4s` named in `audio.m3u8`) is `video/iso.segment` and `immutable`;
  * `index.m3u8` plays in Safari or hls.js, and its PROGRAM-DATE-TIME is the broadcast's wall time (this is also the
    day-1 Safari check: Opus in fMP4, `EXT-X-GAP`);
  * `~/tt-data/archive/R/room.json` has `epoch_ms` and one `shift` entry, `0` unless the speaker's device clock is
    behind the archive.
* The room catalog: a viewer of `talk/R/catalog` gets `version: "draft-01"` with `tt.E` (or `epoch` until
  `room_catalog.py` is renamed) and the shift, and, once agents call `TrackArchive.report`, their `tt.status`.
  No command in `agents/src/talk_tracks/cli.py` prints it: the `catalog` command publishes a catalog and `watch`
  prints only the agents' tracks. Read it by subscribing to track `catalog` of `talk/R/catalog` with a small aiomoqt
  script (the agents' `Relay.located(path, track)` in `moq.py` yields each object), or, without one, check that
  `~/tt-data/archive/R/room.json` has the epoch and shifts the catalog is built from.
* After an hour: `du -sh ~/tt-data/archive` grows about 15 MB an hour per audio-only room (more with video).
  The bucket copy is currently off (`TT_ARCHIVE_BUCKET` is unset and the VM's storage scope is read-only), so
  nothing is uploaded and nothing is logged about it; with it on, the log shows no repeated failures.

**Roll back**

1. `docker compose -f deploy/compose.vm.yml stop archive`.
2. Put the code and image back: `git checkout $(cat ~/tt-data/before-archive-v2.commit) -- deploy` in
   `~/talk-tracks` and `docker tag talk-tracks-agents:before-archive-v2 talk-tracks-agents:dev`.
3. Swap the data back: `mv ~/tt-data/archive ~/tt-data/archive-v2 && mv ~/tt-data/archive-v1 ~/tt-data/archive`.
   The old archiver cannot read `v: 2` files and would start those rooms afresh, so never run it on the new folder.
4. `docker compose -f deploy/compose.vm.yml up -d --force-recreate caddy archive` (Caddy for the old Caddyfile).

**A relay restart** (rehearsed locally 2026-10-28: relay, archiver and four `--fake` agents in Docker, a teacher
that keeps its page clock across reconnects, `docker restart` on the relay), times from the restart:

| What | Back after |
|---|---|
| the relay (`docker restart`) | 2.6 s |
| archiver and agents: session closed, process exits, Docker restarts it, reconnected | 4.3 s |
| agents announced again (seen by the archiver) | 4.3 s |
| room catalog published again (same E, same shift) | 5.4 s |
| teacher media archived again | when the speaker's page reconnects, plus up to one keyframe |

The archiver resumed the same run (`resuming run ...`): one E, one shift entry, no second run or discontinuity, and
the outage is an `EXT-X-GAP` stretch in the playlists. In the rehearsal the speaker came back after 31 s, not 5 s,
because the test client's first reconnect was attempted while the relay was down and waited for QUIC's 30 s idle
timeout; a browser's reconnect timing is its own (check it on day 1). Captions flowing again was not timed.

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
   * `curl -s https://<host>/archive/rooms.json` lists the rooms, a room's `room.json` its runs, and its
     `index.m3u8` plays in a browser;
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
