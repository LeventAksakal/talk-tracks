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

Revised the same day to match the record contract (`06e22ce`): `epoch` became `E`, and the `capped` flag folded into
`status`.

The design leaves these names open. Every lane uses exactly these:

- **Parsing:** the viewer and the room service parse the room catalog as raw JSON. `@moq/msf` 0.3.1's `CatalogSchema`
  drops undeclared fields (namespace, mimeType, eventType, lang, label, template and every `tt`), so it is not used to
  read ours.
- **Root `tt`:**
  - `E`: the room epoch, Unix ms, a multiple of 4000;
  - `shift`: `{<clock.wall as a decimal string>: shift_ms}`, one entry per teacher broadcast. Values are ms, a
    multiple of 4000, not a slice count;
  - `status`: keyed by the bare agent name (`captions`, `translate-tr`), not its namespace.

  No `media` field: the speaker's HLS playlist is at `/archive/<room>/index.m3u8` by convention. The room service
  publishes no catalog before E exists, so `E` is always present.
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

---

## Foundation lanes (2026-10-30)

The player and "every interaction is a track" foundation: decisions
[0017](../decisions/0017-viewer-is-a-media-player-and-every-interaction-is-a-track.md),
[0018](../decisions/0018-speaker-sends-slides-ink-laser-and-camera.md),
[0019](../decisions/0019-subtitles-in-any-language-the-model-supports.md). The design is
[ui-design.md](../product/ui-design.md) (§3.4 is the track table, §14 the lane table); the clickable mockup's link is
in the project `CLAUDE.md` under Artifacts. Everything above this line still holds unless a section below changes it.

**Rules for every foundation lane** (on top of [team.md](../team.md)):
- Read ui-design.md §3.4 and your section below before writing code. Return questions to the coordinator; never ask
  the owner.
- Commit and push often on your branch. No long sleeps, no sub-agents unless the work needs them. Stop and report
  when blocked.
- Checks, once, on your final change set, logged to a file: web lanes `npm run typecheck`, `lint`, `test`, `build`
  in `web/`; agent lanes `uv run pytest`, `ruff`, `pyright` in `agents/`. While iterating, run only the test file you
  touched. The coordinator runs the full gate before merging.
- Tests check what a user can do and what changes, never copy or CSS.

**Order:** Contracts first. Player and Any-language translation start at once (the player's first step needs no
contracts). Console and Event track archive start when Contracts is merged. Comments starts after Player, Console
and Archive are merged, if the Nov 2 checks are not at risk.

### Event track contracts (first, about half a day)
- **Goal:** the new tracks of ui-design §3.4 exist as models and JSON Schemas, so every lane builds on the same shapes.
- **Owns:** `contracts/`, the Python models in `agents/src/talk_tracks/` (`contracts.py`, `records.py`, `schema.py`,
  `room_catalog.py` as needed), `web/src/contracts/`.
- **Build:** MSF event-timeline records for `slide` (deck id, index), `ink` (stroke begin/points/end with tool, colour
  and width; erase; clear; positions as fractions of the slide), `pointer` (laser positions about 20/s while held;
  off), `deck` (slide images and their ids), `comments` (comment, reply, edit, hide; anchor = slide index plus a
  region or text range; author display name), `room` (on air, paused, ended). Define each track's carry-in (object 0)
  as in §3.4. Extend the room catalog to list the speaker's sources (camera, slides) and the event tracks. Propose
  namespaces and track names (a starting point: speaker event tracks under `talk/R/slides`, comments under
  `talk/R/comments` published by the room service) and write them into §"Namespaces" of this file.
- **Done when:** schemas generated from the Python models, TypeScript types and validators updated, round-trip tests
  pass, and the coordinator has the list of changed names to pass to the other lanes.

### Player
- **Goal:** the viewer becomes the media player of ui-design §3–§4.8 (comments UI comes later).
- **Owns:** `web/src/player/` (new), `web/src/pages/WatchPage.tsx`, `DemoPage.tsx`, styles. Reuse `web/src/playback/`
  (the Rewind lane's engine) through its public API; change it only through the coordinator.
- **Step 1, before any canvas or overlay code (owner's rule):** read the official docs (MDN and the specs they link)
  for every API in ui-design §11, and how `@moq/watch` renders live video and what clock it exposes. Write the
  findings and the chosen overlay approach (DOM/CSS, a second canvas, or OffscreenCanvas in a worker; how overlays get
  the room time of the frame on screen for both the live canvas and the archive media element) as a short decision
  draft in `wiki/decisions/` (status: proposed). The coordinator reviews it before step 2.
- **Step 2:** control bar; progress bar with YouTube-style chapter segments, hover preview (time, chapter, slide
  thumbnail), Go live with the offset; CC menu with language search (`Intl.DisplayNames`), dual subtitles, style
  presets and sliders with live preview; draggable subtitle overlay remembered per device; layouts (single, split,
  picture-in-picture, swap); side panel tabs (Transcript, Chapters with So far, Glossary, Notes); Stats for nerds;
  keyboard shortcuts of §4.10; the states of §5; the phone layout of §6.
- **Step 3 (after Contracts):** draw slide, ink and pointer tracks on the overlay layer, live and in rewind.
- **Done when:** a demo room plays in the new player on desktop and phone, rewinds with every track in sync, and
  the web checks pass. Screenshot of each state for the coordinator.

### Speaker console
- **Goal:** the console of ui-design §7, publishing the tracks of decision 0018.
- **Owns:** `web/src/speaker/`, `web/src/pages/TalkPage.tsx`.
- **Build:** pre-flight (mic level, camera self-view, deck loaded, token check); camera via `@moq/publish` H.264;
  PDF deck rendered to images in the browser (pick a PDF renderer and say why); presenter view with current and next
  slide and private notes (notes never published); slide keys and presenter clickers; ink tools (pen, highlighter,
  eraser, clear) and laser on the slide, published as the Contracts lane's tracks; invite with room name, QR, copy
  link and full screen; audience counts and spend per feature; End talk with one confirmation.
- **Done when:** a talk given from the console replays in the Player with slides, ink and laser in sync with the
  audio and camera; web checks pass.

### Event track archive and replay
- **Goal:** the speaker's event tracks are archived and served by FETCH the way AI tracks are (decision 0012), so a
  replay is the same tracks read from history.
- **Owns:** `agents/src/talk_tracks/archive/`, the room service, `deploy/` archive config.
- **Build:** archive `slide`, `ink`, `pointer`, `deck` and `room` tracks per 4 s slice with their carry-ins; serve
  FETCH for them (decide who is the origin for speaker tracks, since the speaker's browser cannot serve history); give
  the looped demo rooms slide tracks from their lecture slides (from the demo-content scripts) so judges see slides
  in the player.
- **Done when:** a recorded talk replays slides, ink and pointer from the archive in sync with its media; a demo
  room shows its slides; pytest, ruff and pyright pass.

### Any-language translation
- **Goal:** decision 0019: a lazy translation track per requested BCP 47 tag.
- **Owns:** `agents/src/talk_tracks/` translate agent, demand handling, catalog entries, caps.
- **Build:** find how a subscribe for a language nobody announced reaches the translate agent through moq-relay
  (one broadcast that accepts any track name, or another way; measure it), start translating on the first subscribe,
  stop when the last leaves, back-fill on FETCH as today, spend against the room cap. Keep the demo rooms' pre-made
  tr/es/ar tracks. Give the Player lane the list of supported languages and how to name a track.
- **Done when:** subscribing to a new language in a live room yields subtitles within a few seconds, idles at zero
  cost without subscribers, and is refused cleanly when the cap is reached; agent checks pass. Real API calls only on
  the VM through its ledger; `--fake` locally.

### Comments (after the foundation, if time)
- **Goal:** ui-design §4.9.
- **Owns:** a small room service endpoint for comments, `web/src/player/` Discussion tab and slide highlights, the
  console's question list.
- **Build:** listeners post through the room service (rate-limited, display name, no account); it publishes on the
  comments track; threads, speaker replies shown first, speaker hide, replay at room time, filters and search.
- **Done when:** comments made live appear in the replay at their time, anchored on the right slide region.
