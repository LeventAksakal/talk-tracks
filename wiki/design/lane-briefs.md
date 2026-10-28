# MoQT design lane: locked design, per-lane changes (2026-10-28)

Branch `claude/lane-moqt-design-49736b` (pushed, not merged). The design is LOCKED: three independent jurors, who saw
only the design and the specs, approved it after three rounds, and the owner took every decision.
- Design: `wiki/design/moq-track-system.md` (the authority; section numbers below refer to it).
- Decision: `wiki/decisions/0012-ai-track-history-by-fetch-from-the-agent.md` (with "Revision 2026-10-28"). It
  supersedes 0007 and part of 0011, and refines 0009.
- Ticket 0019: closed. Please add a 0019 row to `tickets/README.md` when you merge.
- Earlier versions of this note (the `clock` track, the offset, MSE) are void.

## Model
- SUBSCRIBE = live demand. FETCH = the past. Each agent is the origin of its own track's history: the relay serves its
  cache, and misses come to the agent, which reads its archive.
- AI tracks are MSF event timelines cut in 4 s slices: group k holds the records whose room time is in [4k, 4k+4) s.
- Room time (Unix ms) = wall time of the speaker's media − E. Wall time comes from the teacher's hang catalog root
  `clock`: wall_unix_ms = 1577836800000 + 1000·clock.wall/clock.timescale + pts_ms. E is the room epoch, published in
  the room catalog. One `tt.shift` per teacher broadcast (keyed by clock.wall, 0 normally) is applied by everyone.
  Nobody stamps until the catalog lists that broadcast's shift.

## Namespaces and tokens (unchanged patterns)
| Namespace | Tracks | Publisher |
|---|---|---|
| `talk/R/teacher` | hang catalog.json (root clock), audio, video | speaker browser (@moq/publish) |
| `talk/R/slides` | frames | speaker browser |
| `talk/R/agents/<agent>` | `items` (event timeline, sliced), `outline` (chapters agent) | agent: live and origin. Stable name, no instance |
| `talk/R/catalog` | catalog (MSF) | room service (archiver) |
Room service token: publish `talk/R/catalog`, subscribe `talk/R/**`. The looper adds publish `talk/R/catalog`.

## Speaker console (web)
- Nothing to build for the clock: @moq/publish writes the root `clock`. Check that it is present; show an error if it
  is missing (a device clock before 2020).
- Stamp slide frames with their wall time (performance.timeOrigin + performance.now()).
- Day 1: can @moq/publish be set to H.264 with keyframes every ≤4 s? Which audio codec does it emit?

## Lazy agents
1. Stable names `talk/R/agents/<agent>`; drop `<instance>`.
2. Payload (§4.2): each object is a JSON array of MSF records `{"m": room_ms, "data": {...}}`.
   - Captions and translations: data = WebVTT-MSF cue `{start, end, id, text}` + `rev`, `final`; m == start.
   - Slide descriptions: `{id, at, text}`.
   - Object 0 = bounded carry-in (last two cues / the current slide). Objects 1.. = incremental records.
   - End of Group at the end of each slice. End of Track only when the room service closes the room.
3. Open slice = the input watermark (the newest teacher media processed, in room time). While idle: ⌊now/4000⌋ from
   the newest teacher timestamps. Never the agent's own wall clock.
4. Demand rule (§5.3), replacing the plain TT_WAKE_DEBOUNCE_S:
   - a SUBSCRIBE followed within 50 ms by a standalone FETCH of the same track is fetch-induced. It becomes demand
     when still open 1 s after the last FETCH of the track completed, or 10 s after it opened, whichever is first;
   - any other SUBSCRIBE becomes demand after 1 s open with no FETCH of the track in flight during the last 1 s;
   - demand latches until the relay cancels the subscription.
5. Translation joins with SUBSCRIBE + Joining FETCH relative 0 on captions, so it gets the whole current captions
   slice and translates it from the slice's start. Captions mark the carry-in `from` when starting mid-slice.
6. On the last leave: finish the open slice into the archive (≤4 s more work), then idle.
7. Record your own output to the archive (write-once per (track, group)). Live work skips slices already archived.
8. FETCH handler: serve a slice from the archive. Set FETCH_OK's End Location to last object + 1 (fix_end in
   spikes/moqt/common.py). Largest = the open slice.
9. Back-fill: translation only (§5.7).
   - Back-fill slice k when k < open slice, captions slice k exists (FETCH it through the relay), there is
     back-fill budget left (≤25 % of the room cap), and the room is not a demo room.
   - One back-fill at a time, at most 2 waiting; otherwise REQUEST_ERROR "busy".
   - Write-once via a conditional create; if someone wrote first, serve their copy.
   - Anything not allowed gets REQUEST_ERROR. Never an empty or placeholder group, never Prior Group ID Gap.
10. Ledger: reserve before each call, settle after.
11. QUIC: idle_timeout 3 s, keep_alive 1 s (MOQTClient(configuration=QuicConfiguration(...))); reference in
    connect_pub, spikes/moqt/restart_killed.py. Measured: the killed-agent stall fell from 12.4 s to about 1–3.5 s.
12. Write a state file for the room service: producing, the count of FETCHes served as origin, back-fills, spend.
13. Stamp nothing until the room catalog gives E and the broadcast's tt.shift.

## Track archive (room service and archiver)
- Never subscribe to agent tracks.
- Archive library for agents: write-once slice (track, group), read a slice, last object of a slice.
- E: set once per room (wall time of the first teacher media, rounded down to 4 s), persisted.
- tt.shift: for each new teacher broadcast whose first media maps at or below the archived end, publish one shift
  (whole slices), keyed by clock.wall, and 0 otherwise.
- MSF room catalog (§5.10): version "draft-01"; per track: name, namespace, packaging "eventtimeline", mimeType
  application/json, eventType (urn:msf:captions:webvtt; com.talktracks.slides; com.talktracks.outline), role, lang,
  isLive, template [0,4000,[0,0],[1,0],E,4000] (not on the outline), tt.dependsOn, tt.latenessMs, tt.cost. Root: tt
  (E, shift, status from the ledger and the agents' state files). A new group per change; object 0 = full catalog.
- Media: fMP4 segments + an HLS playlist.
  - Video H.264 with keyframes every ≤4 s; a separate, aligned audio rendition (Opus if Safari plays it, else AAC;
    transcode if needed).
  - EXT-X-PROGRAM-DATE-TIME (shift applied) on every segment, DISCONTINUITY per teacher broadcast, GAP over holes
    (fallback if Safari ignores GAP).
  - The ship bar is "hls.js and Safari play it"; CMSF conformance is a nice-to-have.
- Drop the "new run on a 30 s backward jump" rule; room time never goes back.
- Restarted by Docker on relay loss, like the agents.

## Rewind / viewer (web)
- One subscription per track per session, never updated.
- Live: take the open slice from SUBSCRIBE. Show a latest group as stale if its k < ⌊now/4000⌋.
- Seek to room time t: fetchGroup(⌊t/4000⌋−1 … ⌊(t+L)/4000⌋), with L = tt.latenessMs. Only slices below the first
  slice received live (Benchmark finding: the relay never completes a FETCH of the slice where its subscription
  began). A ~2 s timeout on every FETCH, at most 2 in flight, priority 32 (lowest). Merge cues by id, highest rev.
- Media: hls.js, natively on Safari. Room time = PROGRAM-DATE-TIME wall time − E (hls.js playingDate; Safari
  getStartDate() + currentTime), never currentTime alone.
- "What you missed": the outline's chapters in [a, b) plus the caption slices. Subscribe to the outline if needed.
- Inspector panel (live rooms, for judges): per track, producing, origin-served FETCHes vs your own, back-fills and
  spend, all from catalog tt.status.

## Demo content (looper)
- Write the hang root `clock` on the teacher broadcast; keep room time rising across loops (loop_index × length).
- Publish sliced event-timeline tracks under the stable names and serve FETCH from the recording. No back-fill.
- Publish the MSF room catalog for demo rooms.

## Benchmark
- Add rows: FETCH served by the cache vs the origin; bytes per opted-in track per slice. Your stall finding is gap 14 in
  the design's §6.

## Day-1 checks (owner-visible risks)
- Does Safari play Opus from fMP4? Does native Safari honour EXT-X-GAP?
- Can @moq/publish be set to H.264 with keyframes every ≤4 s? If not, the archiver transcodes; measure its CPU on the VM.
- Rehearse `docker restart` of the relay; time until every track is live again.

## Catalog field names (locked by the coordinator, 2026-10-28)

Revised the same day to match the record contract (`06e22ce`): `epoch` became `E`, the `capped` flag folded into
`status`, and `media` was added.

The design leaves these names open. Every lane uses exactly these:

- **Parsing:** the viewer and the room service parse the room catalog as raw JSON. `@moq/msf` 0.3.1's `CatalogSchema`
  drops undeclared fields (namespace, mimeType, eventType, lang, label, template and every `tt`), so it is not used to
  read ours.
- **Root `tt`:**
  - `E`: the room epoch, Unix ms, a multiple of 4000. Absent until the first teacher media; nobody stamps before it;
  - `shift`: `{<clock.wall as a decimal string>: shift_ms}`, one entry per teacher broadcast. Values are ms, a
    multiple of 4000, not a slice count;
  - `status`: keyed by the bare agent name (`captions`, `translate-tr`), not its namespace;
  - `media`: the speaker's HLS playlist path, `/archive/<room>/index.m3u8`.
- **Each `tt.status.<agent>`:**

  | Field | Meaning |
  |---|---|
  | `status` | `idle`, `live` or `capped` (the room's cap stopped it) |
  | `producing` | whether the agent is producing |
  | `fetches_served` | FETCHes it answered as origin |
  | `backfills` | slices it back-filled |
  | `spend_usd` | what it has spent in this room |
  | `updated_ms` | when this entry was last written |

  The room service builds it from each track's `track.json` (`TrackArchive.report`). An entry whose `updated_ms`
  is older than 15 s counts as idle, and the ledger's cap overrides the status.
- **Each track's `tt`:**
  - `dependsOn`: a list of `<namespace>/<track>`, for example `talk/R/agents/captions/items` and `talk/R/slides/frames`;
  - `latenessMs`;
  - `cost`: `paid` or `free`.
