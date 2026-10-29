# Architecture moments and failover rehearsal

Talk Tracks demonstrates four core media-over-QUIC (MoQ) architecture properties in production (decision 0015):

1. **Lazy idle and mid-talk agent join:** unviewed agent tracks cost $0 and produce 0 slices; the first subscriber wakes the pipeline within ~1.2 s; a downstream agent (`translate-tr`) joining mid-talk discovers the track via catalog and translates the current slice from its start using a Joining FETCH relative 0.
2. **Seamless handover under planned stop (`SIGTERM`) vs crash (`SIGKILL`):** planned stops close the open slice cleanly on disk with zero `.part` files; hard crashes keep `.part` intact while the relay's advertised 3 s QUIC idle timeout frees the publisher lock within ~2.9 s (avoiding 10-12 s hangs), resuming with strictly monotonic cue IDs while downstream agents stay running with zero restarts.
3. **Selective history and HLS archive v2:** unproduced pre-join slices are back-filled on demand via MoQ `FETCH` in ~50-60 ms; repeated requests hit `moq-relay`'s shared group cache in ~20 ms (<30 ms) with zero extra LLM invocations; the storage engine persists CMAF MP4 segments with `EXT-X-PROGRAM-DATE-TIME` tags.
4. **Spend caps and token enforcement:** signed ES256 judge tokens enforce room scope and validity windows; a 25% back-fill cap blocks expensive history fetches before live spend; live processing hard-stops at the room cap ($0.80 on $1.00 budget with $0.40/call), transitioning catalog status to `status: "capped"` and refusing post-cap back-fills with `REQUEST_ERROR`.

---

## Automated rehearsal (`rehearse.py`)

The automated rehearsal script provisions a self-contained, portless Docker Compose stack (`-p tt-moments`) using `--fake` models only ($0.00 Meta API cost), executes all four moments against real `moq-relay` 0.17.8 and `moq auth serve` 0.14.8 binaries, and validates contract invariants end-to-end.

### Prerequisites

- Docker daemon running locally with Linux containers.
- Required local images:
  - `talk-tracks-relay:0.17.8`
  - `talk-tracks-auth:0.14.8`
  - `talk-tracks-agents:dev`
- Python 3.12+ environment with `uv` in `agents/`.

### Running the rehearsal

From `agents/`:

```bash
# Run rehearsal and print Markdown summary table
uv run python -m talk_tracks.rehearse

# Run rehearsal and save full JSON telemetry
uv run python -m talk_tracks.rehearse --json-out rehearsal-report.json

# Run with a custom isolated project name
uv run python -m talk_tracks.rehearse --project my-moments
```

### Supported CLI flags

| Flag | Default | Description |
|---|---|---|
| `-h`, `--help` | — | Show help message and exit. |
| `--project PROJECT` | `tt-moments` | Docker Compose project prefix. Isolates networks and volumes (`<project>_tt_data`). |
| `--json-out JSON_OUT` | `None` | Optional path to write the structured JSON report containing nanosecond timestamps and counters. |

The script automatically generates ES256 keys, signs ephemeral tokens, creates an isolated Docker volume, starts the relay and agents, drives MoQ subscriptions via an in-container probe worker, asserts all invariants, and runs `docker compose down -v` on exit.

---

## Measured verification timings

Measured on 2026-10-29 against Docker on Linux (WSL2 kernel 6.6.87, 16 vCPUs, 15 GiB RAM) using `talk-tracks-relay:0.17.8`, `talk-tracks-auth:0.14.8`, and `talk-tracks-agents:dev`:

| Moment | Sub-moment | Measured metric | Threshold / Invariant |
|---|---|---|---|
| **1. Lazy idle & mid-talk join** | 1a. Lazy idle (0 viewers) | 0 slices produced over 4501 ms on air | `status=idle`, `producing=false`, 0 slices |
| | 1b. Captions wake on 1st viewer | Carry-in: 1170 ms<br>1st interim cue: 1170 ms<br>1st final cue: 4161 ms<br>Catalog `live`: 1526 ms | Demand debounce ~1.0 s, catalog updated |
| | 1c. Mid-talk `translate-tr` join | Catalog listed: 4595 ms from `up -d` (2871 ms from container `StartedAt`)<br>Wake -> carry-in: 1128 ms<br>Joining FETCH: 7 objects of slice 4<br>Wake -> 1st `[tr]` cue: 5093 ms | Current slice translated from start; no past context drop |
| **2. Planned stop vs crash failover** | 2a. Planned handover (`SIGTERM`) | `docker stop`: 2734 ms<br>Session withdrawn: 981 ms<br>`00000007.slice` closed cleanly on disk (0 `.part` files)<br>From `start` to resubscribed: 7749 ms<br>Carry-in: slice 7 -> 10<br>Cue ids: 25885 -> 40585 (strictly rising)<br>`translate-tr` restarts: 0 | Clean slice close, zero orphaned `.part` files, monotonic slices and decimal cue ids |
| | 2b. Crash handover (`SIGKILL`) | `docker kill -s KILL`: 1882 ms<br>QUIC idle timeout freed dead track: **2961 ms**<br>Total session withdrawn from kill: 4220 ms<br>`00000012.part` preserved intact on disk<br>Carry-in seeded from next slice: 12 -> 14<br>Cue ids: 44085 -> 56605 (monotonic)<br>`translate-tr` resumed: 11357 ms<br>`translate-tr` restarts: 0 | Dead track freed in ~3.0 s (well under 12.4 s QUIC/TCP idle ceiling); downstream pipeline stays up |
| **3. Selective history & HLS v2** | 3a. Selective history (`FETCH`) | Unproduced slice 2 back-fill: **60.7 ms** (`backfills`: 0 -> 1)<br>2nd FETCH cache hit: **21.1 ms** (`backfills` stayed 1) | 2nd FETCH hit < 30 ms; served directly from `moq-relay` cache |
| | 3b. HLS archive v2 output | `room.json` format: v=2 (`E=1793294172000`)<br>Audio segments: 15 `.m4s` CMAF boxes<br>`EXT-X-PROGRAM-DATE-TIME`: 15 tags<br>Init segment boxes: `['ftyp', 'moov']`<br>Media segment boxes: `['moof', 'mdat']`<br>Slide frames: 4 PNG frames | CMAF compliant; syncable audio and slide timeline |
| **4. Spend cap & token cutoff** | 4a. Token authorization cutoffs | Wrong room token refused: **69.9 ms**<br>Expired token handshake refused: **15.9 ms** | Handshake-level reject by `moq auth serve` |
| | 4b. Spend cap enforcement | 25% backfill cap ($0.25 < $0.40/call) refused in: **31.4 ms** (`spend_usd=0.0`)<br>Live calls stopped after exactly 2 cues ($0.80 <= $1.00 room cap)<br>Catalog status: `status="capped"`, `producing=false`<br>Post-cap back-fill refused in: **14.4 ms** (`REQUEST_ERROR`)<br>Fake ledger audit: $0.80 room total, real `ledger.jsonl` untouched | Hard stop at budget ceiling; 0 extra LLM calls made |

---

## Live VM / submission-video demo script

Follow this runbook when recording the submission video or presenting live to judges on the VM (`ssh $VM`).

### Setup and baseline check

1. Open the public web interface (`https://talk-tracks.org`) in Chrome.
2. In a terminal, SSH to the VM and verify the running containers:
   ```bash
   ssh $VM
   docker compose -f ~/talk-tracks/deploy/compose.vm.yml ps
   ```
3. Show that the demo room (`talk/demo`) is looping with HLS replay and agent tracks are published.

---

### Moment 1: Lazy agent idle & mid-talk join

**What judges see:** Agents do not spend computing power or model budget on silent or unviewed rooms. Starting a translation mid-lecture joins cleanly without replaying from the beginning of time.

1. **Show lazy idle:**
   - In terminal, inspect the catalog for an unattended live room (e.g. `talk/judge-test`):
     ```bash
     curl -s https://talk-tracks.org/api/rooms/judge-test/catalog | jq .tt.status
     ```
   - Point out: `status: "idle"`, `producing: false`, `slices: 0`. The captions and translate containers are active but consuming 0 LLM tokens and writing 0 media slices.
2. **Wake captions:**
   - Open `https://talk-tracks.org/?room=judge-test` in a browser tab.
   - Within ~1.2 s (demand debounce), the viewer subscribes upstream.
   - Show terminal logs: `captions` logs `reading inputs`. Slices begin advancing on 4-second boundaries.
3. **Mid-talk join for translation:**
   - In the UI, click to enable Turkish (`tr`) captions mid-talk (or launch `docker compose up -d translate-tr`).
   - Open Chrome DevTools Network / WebTransport console.
   - Observe that `translate-tr` sends a `SUBSCRIBE` with a Joining `FETCH` relative 0 for `talk/judge-test/agents/captions/items`.
   - Point out that the Turkish subtitles begin translating the *current* open slice from its start (first interim cue in ~1.8 s) rather than re-running the entire past audio transcript.

---

### Moment 2: Planned stop vs crash failover

**What judges see:** If an agent container restarts or crashes mid-slice, downstream agents and viewers recover automatically without losing state or hanging.

1. **Planned restart (`SIGTERM`):**
   - Run:
     ```bash
     docker stop talk-tracks-captions-1
     ```
   - Show in logs: `captions` catches `SIGTERM`, flushes the current slice cleanly, writes `0000000X.slice`, and exits with code 0 (zero `.part` files).
   - Start it back up:
     ```bash
     docker start talk-tracks-captions-1
     ```
   - Show that `captions` reads `data/state/` and resumes at the next sequential slice number. Cue IDs strictly increment (no duplicate IDs sent to the viewer).
2. **Hard crash (`SIGKILL`) & 3-second QUIC timeout:**
   - Kill captions abruptly mid-slice:
     ```bash
     docker kill -s KILL talk-tracks-captions-1
     ```
   - In `relay` logs (`docker logs -f talk-tracks-relay-1`), highlight:
     `QUIC idle timeout expired: track talk/rehearse/agents/captions/items unannounced`.
   - The relay withdraws the track lock in **~2.9 seconds** (not 12-15 seconds).
   - Start the container:
     ```bash
     docker start talk-tracks-captions-1
     ```
   - Notice that the open `.part` file was preserved on disk, the new instance seeds from `TrackArchive` starting at the next index, and downstream `translate-tr` never crashes or restarts (`RestartCount: 0`).

---

### Moment 3: Selective history & HLS archive v2

**What judges see:** A viewer seeking into the past fetches historical agent outputs on demand; repeated fetches hit the relay cache with zero backend work. The archive produces standards-compliant CMAF HLS.

1. **FETCH back-fill on demand:**
   - In the viewer, drag the scrub bar back 30 seconds to an unviewed Turkish segment.
   - In `translate-tr` logs, show:
     `FETCH items group 2: back-filling slice from captions slice 2... served in 60 ms`.
     `catalog.tt.status["translate-tr"].backfills` increments from 0 to 1.
2. **Relay cache hit (<30 ms):**
   - Open a second browser tab (or run `moq fetch`) requesting that same past group:
   - In logs, show: relay serves the cached group in **<25 ms**. Zero lines are logged by `translate-tr`, and `backfills` stays at 1.
3. **Inspect HLS v2 archive:**
   - In SSH terminal:
     ```bash
     ls -la /data/archive/judge-test/
     cat /data/archive/judge-test/audio.m3u8 | head -n 20
     ```
   - Point out:
     - `room.json` with schema version 2 and epoch `E`.
     - `audio.m3u8` containing `#EXT-X-PROGRAM-DATE-TIME: 2026-10-29T...` on every 4.0 s segment.
     - `init-0.mp4` containing `ftyp` and `moov` top-level boxes.
     - `.m4s` segments containing `moof` and `mdat` boxes.

---

### Moment 4: Spend cap & judge token cutoff

**What judges see:** Hard economic boundaries. Rooms cannot overrun their budget, and signed judge tokens cannot access unauthorized rooms or outlive their expiration.

1. **Token authentication cutoffs:**
   - Attempt to connect with an expired token or publish to `talk/other-room`:
     ```bash
     # Probe or moq-cli with bad token
     moq publish --relay moqt://relay:4443 --token $EXPIRED_TOKEN talk/room/teacher
     ```
   - Show relay log: `the auth server refused the session: token expired` (rejected in ~16 ms).
2. **25% backfill budget protection:**
   - In a room with $1.00 budget and $0.40 cost per call, the backfill budget is 25% ($0.25).
   - Requesting a historical back-fill before live calls spend anything triggers:
     `FETCH items refused: worst case $0.40 would pass backfill budget $0.25`.
   - Refused in ~31 ms with 0 spend incurred.
3. **Live spend cutoff at room budget:**
   - Allow live translation to run.
   - Call 1 ($0.40) and Call 2 ($0.40) succeed ($0.80 total).
   - On Call 3, the ledger checks worst-case cost ($0.80 + $0.40 = $1.20 > $1.00 cap).
   - Show `translate` log:
     `WARNING talk_tracks: translate capped: room judge-cap1 spent $0.8000; worst case $0.4000 would pass its cap $1.00`.
   - Show catalog status: `status: "capped"`, `spend_usd: 0.80`, `producing: false`.
   - Attempting a subsequent `FETCH` returns `REQUEST_ERROR: the room reached its spend cap`.
   - Inspect ledger:
     ```bash
     cat /data/fake-ledger.jsonl | jq .
     ```
     Spend is bounded at exactly $0.80.
