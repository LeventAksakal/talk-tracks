---
status: accepted (decision 0012), revised after an independent review on 2026-10-28
date: 2026-10-28
replaces: the coordinator's draft of the same name (2026-10-28)
---

# System design: Talk Tracks on MoQT

The owner's direction: use what MoQT is, rather than build features beside it, so the build shows MoQT's
capabilities and how well they combine with AI APIs. This page says how. It is grounded in four things:

- the transport draft as written: draft-ietf-moq-transport-18, the version our agents speak (decision 0001), and
  -22, the latest;
- what our pinned stack really does: moq-relay 0.17.8 (with moq-net 0.3.16), aiomoqt 0.13.1, and @moq/net 0.4.5 and
  @moq/publish in the browser, all read from source;
- spikes against a private relay (`spikes/moqt/`, results in [§9](#9-spike-results));
- an independent review by three jurors who saw only this page and the specs
  ([§11](#11-independent-review)).

The coordinator's draft read history as "more tracks through ordinary subscriptions". That treats SUBSCRIBE and
FETCH as interchangeable, and the draft says they are not: "Subscribe only requests newly published or received
Objects. Objects from the past are retrieved using FETCH" (D18 §10.7). This design starts from that split.

Citations: **D18** and **D22** are the transport drafts. **MSF** is draft-ietf-moq-msf-01, **WebVTT-MSF** is
draft-wilaw-moq-webvtt-msf-00, **hang** is draft-lcurley-moq-hang-03, **lite** is draft-lcurley-moq-lite-06.
**src** is a file in the pinned source. **S1**–**S6** are the spikes.

---

## 1. The model in one paragraph

A track is a sequence of groups, and a group is a join point (D18 §2.3). A subscription asks for what is published
from now on. A fetch asks for a bounded range that already exists, on one stream, and ends (D18 §10.7, §10.12). A
relay aggregates subscriptions, may cache, and forwards a cache miss upstream (D18 §9.1, §9.4, §10.12.3). So:

- **Live demand is a SUBSCRIBE.** It is the only thing that makes an agent do paid live work.
- **The past is a FETCH.** The relay answers from its cache. A miss goes upstream to the track's own publisher, which
  is the **origin** of that track's history and serves it from durable storage.
- **Time is the group number.** Every AI event track cuts its groups on one room clock, so a viewer turns a seek
  time into the group to fetch by arithmetic, without an index.

## 2. What the spec says, what moq-lite does, what our stack does

Each row is a mechanism the design relies on.

| Mechanism | Spec (draft-18) | moq-relay 0.17.8 towards an IETF client | Browser (@moq/net 0.4.5, moq-lite-06) |
|---|---|---|---|
| Live subscription | SUBSCRIBE with a filter: Next Group Start, Largest Object, AbsoluteStart, AbsoluteRange (§5.1.2) | Only Largest Object is honoured; every other filter is ignored without an error and starts at the latest group (src `ietf/publisher.rs:6780-6789`; S1: asked for group 10, got 51, 52, 53) | `subscribe({priority, maxAge, groups})` (src `track.d.ts:66-85`) |
| Late join | a group is a join point (§2.3); SUBSCRIBE plus a Joining FETCH (§5.1.3, §10.12.2) | Largest Object starts at the next object, so a quiet track sends nothing (S4: 0 groups in 3 s). SUBSCRIBE plus a Joining FETCH relative 0 returns the current group (S4: an 8 s old group in 42 ms) | the latest group, however old: a track quiet for 12 s delivered its latest group in 57–76 ms (S6), as lite §6.2 says |
| Past objects | FETCH: standalone range, or joining (§10.12) | **One group per FETCH.** A range over several groups is refused, code 3 (S1; src `publisher.rs:1391-1406`). Served from the cache; on a miss, a one-group FETCH goes to the publisher (S1, S4) | `fetchGroup(n)`: one group (src `track.d.ts:142`) |
| A FETCH with nobody subscribed | not specified | the relay SUBSCRIBEs upstream, forwards the FETCH, and cancels the SUBSCRIBE when the FETCH completes: it lived 8 ms, 1.5 s and 3.0 s for origins answering at once, after 1.5 s and after 3 s (S4, S6) | same relay path |
| Publisher gone | not specified for FETCH | nothing is served, cache included: `unroutable`, code 16 (S1) | same |
| Relay cache | optional (§9.1), bounded by MAX_CACHE_DURATION (§12.3) | non-latest groups are dropped after 30 s without a read or write (src `model/cache.rs:83`); S2 served a 43 s old group, S3 found a 40 s old one evicted | — |
| Forward=0 (subscribe without delivery) | §5.1 | refused (src `publisher.rs:580-584`) | — |
| TRACK_STATUS | §10.14 | refused, code 3 (S1) | `info()` (moq-lite TRACK_INFO) |
| PUBLISH (publisher-initiated) | §10.10 | refused; the publisher announces a namespace and serves SUBSCRIBEs (src `subscriber.rs:1189-1218`) | — |
| Namespace announcements | PUBLISH_NAMESPACE (§10.15), SUBSCRIBE_NAMESPACE (§10.18) | supported; an announced namespace is a prefix route (src `subscriber.rs:1380-1428`) | `origin.announced(prefix)` |
| Two publishers of one namespace | the relay keeps subscriptions to all publishers and forwards from each (§9.3, §9.5) | **deviates:** one route wins. While the old publisher is alive, new subscriptions go to the newest announcement and existing ones stay put (S2). If the old publisher is killed while one of its subscriptions is open, that subscription stalls until the relay times the dead connection out: 12.4 s by default, about 3.5 s when the publisher advertises a 3 s QUIC idle timeout (S5, S5b) | follows the relay |
| Last subscriber leaves | no relay rule | the relay cancels upstream at once: STOP_SENDING and FIN on draft-18 (src `subscriber.rs:1869-1892`); the publisher was idle 11 ms later (S1; the Lazy agents lane measured 7–21 ms) | `close()` |
| Priorities | lower number first: subscriber priority, then publisher priority, then group order (§7) | IETF priority = 255 − moq-lite priority (src `ietf/priority.rs`); group order is ignored (src `publisher.rs:693-697, 2394`) | higher number first: track priority, then subscription priority, then newest group (src `lite/priority.rs:9-40`); over WebSocket only once data leaves the TCP queue |
| Delivery timeout | SUBGROUP_ and OBJECT_DELIVERY_TIMEOUT (§10.2.3, §10.2.4) | parsed and dropped; a 5 s max age per IETF-sourced track applies to older groups but never drops the latest one (src `subscribe.rs:87,90`; `origin.rs:119-128`; S6) | `maxAge` |
| Changing a subscription | REQUEST_UPDATE (§10.9) | priority only; anything else ends the subscription with UPDATE_FAILED (src `publisher.rs:785-882`) | `update()`; a second subscription with another `maxAge` on one track ended the live one, error 0 (S3) |
| Auth | a token per request (§10.2.2) | one decision per session, through `--auth-url`; then path patterns are checked locally (src `relay auth.rs`) | `?jwt=` |

What this means:

- moq-relay is a **live fan-out relay with a short cache and a one-group FETCH**. It is not a history server, and
  it does not pretend to be. Its author argues for "just use HTTP" for VOD (moq.dev/blog/you-dont-need-it) and puts
  DVR in a separate recording tier (doc.moq.dev, hang Recording).
- The AI tracks' history is therefore served by the **original publisher**, as the spec intends when a relay misses
  (D18 §10.12.3). moq-relay supports exactly that, one group at a time, which is all we need because groups are
  time slices.

## 3. Names, roles and tokens

| Namespace (broadcast path) | Tracks | Publisher | Notes |
|---|---|---|---|
| `talk/R/teacher` | hang `catalog.json` (with the root `clock`), audio, video | the speaker's browser (@moq/publish) | as today |
| `talk/R/slides` | `frames` | the speaker's browser | as today |
| `talk/R/agents/<agent>` | `items` (event timeline in slices, [§4](#4-track-and-group-model)), and `outline` for chapters | the agent process: live output **and** origin of the track's history | **stable name, no instance segment** (today: `.../<agent>/<instance>`) |
| `talk/R/catalog` | `catalog` | the room service ([§5.10](#510-room-catalog)) | MSF catalog |

Tokens, with the same signing as decision 0005; only the patterns change:

| Who | Publish | Subscribe |
|---|---|---|
| Speaker of room R | `talk/R/teacher`, `talk/R/slides` | `talk/R/**` |
| Agents of room R | `talk/R/agents/**` | `talk/R/**` |
| Room service (archiver and catalog) | `talk/R/catalog` | `talk/R/**` |
| Looper of demo room R | `talk/R/teacher`, `talk/R/agents/**`, `talk/R/catalog` | `talk/R/**` |
| Viewers | nothing | `talk/**`, anonymous |

Viewers stay anonymous, so nothing a viewer can request may cost more than a bounded budget
([§5.7](#57-back-fill-of-a-track-switched-on-mid-talk), [§5.12](#512-spend-caps)).

## 4. Track and group model

### 4.1 Groups are time slices on the room clock

Every AI event track (captions, translation, slide descriptions) cuts its groups on the room clock
([§4.5](#45-the-room-clock)): **group `k` holds the items whose room time falls in `[k·S, (k+1)·S)`**, `S` = 4 s.

- **Seek without an index.** The items at room time `t` are in group `⌊t/S⌋`. A track that publishes items late
  declares its maximum lateness `L` in the catalog; a viewer seeking to `t` fetches `⌊t/S⌋ − 1 … ⌊(t+L)/S⌋`. MoQT
  Locations become addressable by time, which moq-relay's one-group FETCH needs, since it cannot answer "the latest
  group before t".
- **Ids never repeat.** The group number comes from the room clock, not a counter, so a restarted agent, a reloaded
  speaker or a new loop of a demo room never reuses one (D18 §2.4.3, option 2).
- **`S` = 4 s is a product choice**, not a relay constraint: small enough that a seek lands close, large enough that
  a slice holds a few lines. moq-relay delivers the latest group however old it is (S6).
- **Groups may be missing.** An idle agent produces none. A FETCH of a missing slice is a back-fill request
  ([§5.7](#57-back-fill-of-a-track-switched-on-mid-talk)) or answered with an error; never with an empty group.

### 4.2 Objects inside a group: an MSF event timeline

Each `items` track is an MSF **event timeline** (MSF §8): every object is a JSON array of records
`{"m": <room time ms>, "data": {...}}` (MSF §8.1).

- **Captions and translations** use the WebVTT-MSF cue shape: `data` is `{"start", "end", "id", "text"}` with
  `m == start` (WebVTT-MSF §3), plus two extension fields, `rev` (revision number) and `final` (boolean), for interim
  results. A viewer merges records by `id` and keeps the highest `rev`.
- **Slide descriptions** use `data` = `{"id", "at", "text"}` with `m == at`, under their own `eventType`.
- **Object 0 is the carry-in:** an independent timeline that makes the group useful on its own (D18 §2.3,
  MSF §8.3). It holds the last two cues before the slice, or the slide on screen with its description.
- **Objects 1 and up are incremental records** in publication order (MSF §8.3).
- **The group ends with End of Group** (D18 §11.2.1.1) when the slice is over. End of Track is sent only when the
  room service closes the room for good, never when a teacher broadcast ends, because a reloading speaker continues
  on the same tracks (D18 §2.4.2).
- **Objects are immutable** (D18 §2.1): every Location is written once, live or by back-fill, and the archive keeps
  exactly what was sent.

**Declared deviations from MSF:**
- MSF §8.3 wants object 0 to hold *all* records accumulated so far. Over a one-hour talk that grows to tens of KB per
  4 s, so our carry-in is bounded to what is on screen. Earlier records are reached by FETCH of earlier slices, which
  is the point of slicing. The carry-in's records therefore start before the slice's template time (MSF §7.1.1).
- `m` is room time ([§4.5](#45-the-room-clock)), not the teacher's PTS (MSF §8.1). The catalog template maps it to
  wall time.

Where an item goes:

- **The open slice** is the one containing the agent's **input watermark**: the newest teacher media time it has
  processed, in room time. It is never the agent's own wall clock, so clock skew between machines cannot push items
  into future groups. An idle agent has no watermark; its edge is then `⌊now/S⌋`, with `now` the room time of the
  newest teacher media (the agent reads the teacher's catalog and audio timestamps, which costs nothing).
- **Write-once in both directions.** Live work that starts or resumes skips any slice already in the archive, and
  back-fill never writes a slice that exists, so a back-fill near a slice boundary and resuming live work cannot both
  produce group `k`.
- **Live:** an item goes into the open slice when it is produced, so groups advance with time (D18 §2.3.1). A cue
  finalised after its slice closed lands in a later slice; `L` bounds how much later.
- **Start mid-slice:** translation starts with SUBSCRIBE plus a Joining FETCH of the captions track, so it receives
  the whole current captions slice and translates it from the start. Captions, which cannot hear the past, mark the
  carry-in with `from` (the room time it started at).
- **Stop:** when the last subscriber leaves, an agent finishes the open slice into its archive (at most 4 s more
  work), so no slice is left half-written. The relay's cache may still hold the cut-off copy it received live and
  serve it as complete (a relay should check objects of unknown status upstream, D18 §10.12.3; moq-relay does not).
  We accept this: the cut-off copy is a prefix of the archived one, the viewer merges by `id`, and the relay drops
  the group after about 30 s without reads.
- **Back-fill:** a slice produced later for a past `k` goes into group `k`, which the agent never produced live. It
  is reachable only by FETCH (D18 §10.7).

### 4.3 The outline

Chapters, glossary and recap are revised as a whole by the LLM, so a slice log would be wrong for them. The
`outline` track is an MSF event timeline with one group per revision: object 0 holds every chapter, glossary entry
and the recap as records `{"m": <start>, "data": {...}}`, which is MSF §8.3's full accumulated timeline, a few KB. A browser joining late gets the latest group, however old (S6); an IETF reader uses SUBSCRIBE plus a Joining
FETCH. Seeking never needs an older outline: the viewer shows the newest one, whose chapters carry their start time.

### 4.4 Wire contract changes

These go through the coordinator, because they change `contracts/`:

- Agent `items` objects become MSF event-timeline records (above). The current envelope's full-state `lines` and
  `slides` lists, `seq` and `instance` go away: the Location (group, object) is the sequence, and the stable name
  replaces the instance.
- The outline becomes an event timeline, one group per revision ([§4.3](#43-the-outline)).
- Every time in every contract (`start`, `end`, `at`, `m`, the recordings' `media_ms`) is room time in ms.

### 4.5 The room clock

**room time (ms) = wall time of the media timestamp − `E`**, where `E` is the room's epoch.

- **The mapping already exists.** @moq/publish stamps every audio and video timestamp with `performance.now()` in
  µs, and advertises the mapping to wall time in the teacher's hang catalog as the root `clock`: `wall` is the
  wall-clock time of PTS zero, that is `performance.timeOrigin` (src `@moq/publish/catalog.d.ts`; hang §4.2).
- **Units.** `clock.wall` counts `clock.timescale` units (default 1 000 000, µs) since the moq epoch,
  2020-01-01T00:00:00Z; `pts` is in the track's timescale (µs for @moq/publish). So
  `wall_unix_ms = 1577836800000 + 1000 × wall / timescale + pts_ms`, as `@moq/hang`'s `wallClockTime()` computes.
  `E` and every room time are Unix ms, and so is the MSF template's `startWallclock`.
- **The epoch.** `E` is fixed once per room by the room service: the wall time of the first teacher media it ever
  saw, rounded down to a multiple of `S`. It is kept in the archive and published in the room catalog. The room
  service starts before the agents; an agent stamps nothing until the catalog gives it `E`, and Docker restarts the
  room service like any agent ([§5.9](#59-relay-restart-durability-and-vm-loss)).
- **Why this holds across reloads.** A reload starts a new page with a later `timeOrigin`, and the new catalog's
  `clock.wall` says so. Room time therefore keeps rising with wall time, the clock and the media come from the same
  broadcast, and a pause shows up as a real gap.
- **Guard against a skewed device, decided once.** A speaker on another device with a slow clock could map onto room
  time already used. The room service checks each new teacher broadcast (identified by its `clock.wall`): if its
  first media maps at or below the archived end, it publishes one shift for that broadcast in the room catalog
  (`tt.shift`, keyed by `clock.wall`, a whole number of slices). Every consumer, the archive and the HLS playlist
  apply the same shift, so all tracks stay aligned. Consumers stamp nothing from a teacher broadcast until the room
  catalog lists its `clock.wall` in `tt.shift` (0 when no shift is needed). The archive writes PROGRAM-DATE-TIME with
  the shift already applied.
- **The looper** publishes the teacher broadcast itself and writes the same root `clock`, with each loop placed at
  `loop_index × loop_length` after the previous one, so demo rooms never repeat a group id either.
- **Holes.** Room time has holes where nobody broadcast. A FETCH of a slice in a hole is answered with an error and
  never back-filled, because no input exists for it. The media archive marks holes for the player
  ([§5.5](#55-rewind-into-history-and-go-live)).
- If the teacher catalog has no `clock` (hang omits it on a device whose clock reads before 2020), consumers refuse
  the broadcast and the speaker console shows an error.

## 5. Flows

### 5.1 Live viewing and late join

- The viewer reads `talk/R/catalog`, then subscribes to the teacher's media and to each track it has switched on.
- **The browser** gets the latest group by default: the current slice with its carry-in. It compares that group's
  number with `⌊now/S⌋` from the teacher clock, so a stale latest group from an idle agent shows as "no live
  output yet", not as current.
- **An agent** reading another agent's track (IETF, draft-18) sends SUBSCRIBE (Largest Object) plus a Joining FETCH
  relative 0 (D18 §5.1.3, §10.12.2). Measured: 42 ms (S4). `StartAt(mode="latest")` alone gets nothing until the
  next object arrives.
- **Scrollback:** the viewer fetches slices k−1 … k−n, one `fetchGroup` each, cached at the relay.

### 5.2 Opt-in tracks

- Switching a track on is a SUBSCRIBE; switching it off is closing the subscription (decision 0010).
- No track is subscribed by default. The catalog lists them all, so the panel can show what exists without
  subscribing.
- **Measured constraint:** one subscription per track per session, with options fixed when it opens. Changing
  `maxAge` failed through the IETF path (S3).

### 5.3 Lazy agents and how demand reaches them

- A SUBSCRIBE reaches the agent as one aggregated upstream SUBSCRIBE (src `broadcast.rs:868-893`): a thousand viewers
  of the Turkish track are one subscription and one paid translation.
- The relay cancels the upstream subscription as soon as the last viewer leaves (11 ms in S1).
- **Chains:** translation and chapters SUBSCRIBE to `talk/R/agents/captions` like any viewer. Their subscription
  keeps captions producing, and the relay aggregates it with the viewers' subscriptions. This is the MoQT
  subscription chain itself; there is no side channel.
- **A FETCH looks like demand on moq-relay.** To forward a FETCH, the relay opens an upstream SUBSCRIBE that lives
  until the FETCH completes: 8 ms for an instant answer, 3 s for a 3 s answer (S6). It arrives about 2 ms before its
  FETCH. A fixed settle time therefore fails for slow back-fill. **Rule, per subscription:**
  - a SUBSCRIBE followed within 50 ms by a standalone FETCH of the same track is **fetch-induced**. It counts as demand
    only if it is still open 1 s after the last FETCH of that track completed, or 10 s after it opened, whichever comes
    first (a real viewer who subscribes during a back-fill is merged onto it, so it outlives the FETCH; the 10 s bound
    keeps a continuous scroller from delaying that viewer forever, at the cost of live work starting for a scroller
    who fetches for more than 10 s without a viewer, within the room cap);
  - any other SUBSCRIBE counts as demand once it has been open for 1 s and no FETCH of that track from that relay
    session has been in flight during the last 1 s (a backstop in case the 50 ms association misses under load; the
    queue bound below caps how long this can delay live work, at about two back-fills);
  - once demand is met it **latches** until the relay cancels the subscription, so later fetches cannot pause live
    work;
  - the back-fill queue holds at most 2 per agent; further back-fill FETCHes get REQUEST_ERROR ("busy") at once, so a
    scroller cannot keep the track's FETCHes in flight indefinitely;
  - the existing wake debounce (`TT_WAKE_DEBOUNCE_S`, 1 s) becomes this rule.
- **Cost:** live output starts at least 1 s after the first viewer subscribes.

### 5.4 Recording without creating demand

- The relay is not a recorder: about 30 s of cache, and nothing once the publisher leaves (S1). A recorder that
  SUBSCRIBEs to agent tracks counts as a viewer and makes every agent eager (the Lazy agents lane found the same).
- **Rule: a track is recorded by its own publisher, as it publishes.** Each agent writes every object it sends to its
  archive, and the relay never sees a recorder. Recording creates no demand because it is not a subscription.
- Speaker media and slide frames come from a browser, which cannot record or serve history. The **archiver**
  subscribes to them. That costs no API money, because no agent's work depends on it.

### 5.5 Rewind into history, and "Go live"

- The viewer seeks to room time t:
  - **Agent tracks:** it fetches `⌊t/S⌋ − 1 … ⌊(t+L)/S⌋`, one `fetchGroup` each.
  - The relay serves its cache. On a miss, it forwards a one-group FETCH to the agent, which is the origin and reads
    the slice from its archive (disk, then the bucket).
  - Ten students rewinding to the same minute cost one read: the relay merges concurrent fetches of a group (src
    `track.rs:306-312`).
- **Media** (speaker audio and video) plays from the archive over HTTP, as **HLS with fMP4 segments**, through
  hls.js (native HLS on Safari and iPhone):
  - **The bar to ship is "hls.js and Safari play it".** CMSF conformance (one CMAF fragment per group, each starting
    at a sync sample; CMSF §3.3–3.4) is a nice-to-have that would let a later MoQ replay skip repackaging.
  - **Codecs:** H.264 video with a keyframe interval of 4 s or less, and audio in its own rendition, aligned with the
    video. Audio is Opus if Safari plays Opus from fMP4 (a day-1 check), else AAC. If @moq/publish cannot be set to
    these, the archiver transcodes, which costs CPU on the VM; that is checked on day 1 too.
  - **Playlist:** `EXT-X-PROGRAM-DATE-TIME` on every segment, `EXT-X-DISCONTINUITY` at each new teacher broadcast, and
    `EXT-X-GAP` over holes. If native Safari does not honour `EXT-X-GAP` (a day-1 check), holes are marked with a
    discontinuity and a jump in PROGRAM-DATE-TIME instead. hls.js handles gaps, new init segments and
    discontinuities; we write none of that.
  - **Mapping:** the viewer converts the playhead to room time through PROGRAM-DATE-TIME (hls.js `playingDate`,
    Safari `getStartDate()` plus `currentTime`): room time = that PROGRAM-DATE-TIME wall time − `E`
    (the shift is already in the playlist), never from `currentTime` alone.
  - This is the one place the design leaves MoQ. See [§6](#6-where-our-stack-falls-short), row 1.
- **Go live:** the viewer drops the fetched state, keeps its live subscriptions, and jumps to the current slice.
  While rewound, the live subscriptions stay open: the viewer opted into those tracks, so keeping them open adds no
  spend.

### 5.6 "What you missed"

- The viewer was away from room time a to b: tab hidden, rewound, or reconnected.
- It shows the outline chapters whose start falls in `[a, b)`. They come from the latest outline snapshot, so this
  costs no API call.
- The caption slices covering a … b are one FETCH each, if the viewer wants the transcript.
- If the outline track has no subscriber, the viewer subscribes to it for the summary. That makes the chapters agent
  produce, which needs captions; the chapters agent's own cap bounds the cost.

### 5.7 Back-fill of a track switched on mid-talk

**FETCH is demand for the past.** In this build it is shown on **translation**: a viewer who switches on Turkish at
minute 20 and scrolls back gets earlier slices translated on demand.

- A FETCH of translation slice `k` that the agent never produced reaches the agent through the relay. The agent
  back-fills it when all of these hold:
  - `k` is before the open slice (a FETCH of the open slice is a live read, never a back-fill);
  - the input exists: captions slice `k` is in the archive;
  - the room's back-fill budget has money left ([§5.12](#512-spend-caps));
  - the room is not a demo room.
- It then FETCHes captions slice `k` through the relay (an archive read at the captions agent; its helper SUBSCRIBE
  lasts milliseconds), translates it, writes it to the archive **write-once** (a conditional create; if another
  process wrote `k` first, it serves that copy), and answers the FETCH from the archive. This is a FETCH chain: the
  past of one track is built from the past of another through the relay, with no side channel. The relay waits for a
  slow origin (3 s measured, S4).
- Otherwise it answers REQUEST_ERROR, never an empty or placeholder group, so the slice can still be produced later
  without changing a published Location (D18 §2.1). Agents never send Prior Group ID Gap for slices that could still
  be back-filled (D18 §12.8).
- The agent's FETCH handler defines its Largest Location as the open slice, so a FETCH of a past slice it never
  published is in range (D18 §10.12.3).
- **Bounded:** at most one back-fill at a time per agent, queued behind live work, with at most 2 waiting
  ([§5.3](#53-lazy-agents-and-how-demand-reaches-them)); only for slices someone fetches.
  A fetched slice is paid once and is an archive read from then on.
- **Stretch goal, not in the build plan:** captions back-filled from archived speaker audio, and translation
  chaining onto it.

### 5.8 Agent restore after a restart

- A new process announces the same stable namespace, so no instance naming is needed. What happens next depends on
  how the old one ended:
  - **Clean leave** (SIGTERM handled, session closed; already in `talk_tracks.moq.connect`): the relay drops the old
    route at once. Existing subscriptions end and resubscribe; new ones go to the new process (S2).
  - **Killed** (crash, OOM, `docker kill`): the relay keeps the dead session until its QUIC idle timeout. With the
    default, subscriptions stalled for **12.4 s** (S5). With the agent advertising a **3 s idle timeout and a 1 s
    keep-alive**, new subscriptions reached the replacement within about 1 s and the open one ended and moved after
    about 3.5 s (S5b). Agents set those values.
- Viewers and downstream agents resubscribe when their subscription ends. @moq/net's `requesting.active` flips to the
  newest route, and IETF readers watch SUBSCRIBE_NAMESPACE.
- The agent seeds itself from its own archive (decision 0009) and starts at the next slice boundary: the partly
  published current slice is left as it is, because another publisher's group cannot be continued. This loses up to
  4 s of output.

### 5.9 Relay restart, durability and VM loss

- **Relay restart** drops every session. Each agent, the room service and the archiver exit when their relay
  session closes (`talk_tracks.moq.until_closed`) and Docker restarts them, which re-announces, re-subscribes upstream
  (with the Joining FETCH) and re-reads the catalogs. Browsers reconnect by themselves. The demo rehearsal includes
  `docker restart` of the relay, with the time until every track is live again measured.
- **Durability (decision 0011 stands):** each agent appends its slices to the room archive on the VM's disk; the
  archiver writes the speaker's media segments and playlist; a copier sends finished files to the bucket within
  seconds.
- **VM loss:** restore the bucket, `compose up`. Agents then serve FETCH from the restored archive under the same
  names and group numbers.

### 5.10 Room catalog

`talk/R/catalog` is an **MSF catalog** (MSF §5), published by the room service (the archiver).

- Root: `"version": "draft-01"`, plus a Talk Tracks extension object `"tt"` with the room epoch `E`.
- One track object per AI track:
  - `name` and `namespace` (an MSF track may name its namespace);
  - `packaging: "eventtimeline"`, `mimeType: "application/json"` and an `eventType`: `urn:msf:captions:webvtt` for
    captions and translations (WebVTT-MSF), `com.talktracks.slides` and `com.talktracks.outline` for ours;
  - `role` (`caption` or `subtitle`), `lang`, `isLive: true`;
  - `template: [0, 4000, [0, 0], [1, 0], E, 4000]`, the slice arithmetic of [§4.1](#41-groups-are-time-slices-on-the-room-clock)
    in MSF's own form (MSF §7.4; the outline has none);
  - `depends`: within one namespace MSF names the tracks the timeline applies to (MSF §5.2.14). Ours crosses
    namespaces (translation depends on captions), so we add `tt.dependsOn` with full paths, a declared extension;
  - `tt.latenessMs` (`L`) and `tt.cost` (`paid` or `free`).
- **Status is not a track attribute**, because MSF forbids changing a declared track (MSF §5.3). Live, idle and
  capped are read from the track itself (the carry-in carries `capped`) and from a small `tt.status` map in the
  root, which the room service fills from the spend ledger and each agent's state file (producing or not, the number
  of FETCHes it served as origin, back-fills, spend).
- The room service learns the room's tracks through SUBSCRIBE_NAMESPACE on `talk/R`, which creates no demand.
- Each change is a new group whose object 0 is the full catalog. MSF allows deltas but does not require them
  (MSF §5.1.6). A browser joining late gets the latest group.

### 5.11 Priorities under congestion

| Track | moq-lite priority (higher first) | IETF priority (lower first) = 255 − moq-lite | Reason |
|---|---|---|---|
| speaker audio | 255 | 0 | the voice comes first |
| captions | 224 | 31 | the words |
| translation | 208 | 47 | the words, translated |
| catalog | 200 | 55 | tiny; the UI needs it |
| speaker video | 160 | 95 | bulky; can drop |
| slides and descriptions | 128 | 127 | |
| outline | 96 | 159 | |
| FETCH (history, back-fill) | 32 | 223 | never ahead of live |

- **IETF side:** agents declare the publisher priority in IETF terms (aiomoqt `PublishSpec.priority`), and
  downstream agents set the subscriber priority. Whether aiomoqt applies its own stream priorities on the wire is not
  verified: its agent API reports "enforced: False" (src `agent/session.py:241-278`).
- **Browser side:** the viewer sets a subscription `priority` per track, and passes the history priority to
  `fetchGroup`.
- **Safari and iPhone use the WebSocket fallback** (WebKit bug 319818, src `connection/browser.js`). There, priority
  acts only once bytes leave the TCP send queue. So history fetches stay small, one slice at a time and at most 2 in
  flight.

### 5.12 Spend caps

- Spend happens in agents only, recorded in the VM ledger (decision 0008, Lazy agents lane). The ledger **reserves
  before each call** and settles after it, so concurrent calls cannot overshoot a cap or the $100 ceiling.
- **MoQT's part is to make spend follow requests:** live work only under a SUBSCRIBE that is demand
  ([§5.3](#53-lazy-agents-and-how-demand-reaches-them)); back-fill only per FETCHed past slice.
- **Back-fill has its own budget, at most 25 % of the room cap**, so anonymous fetching cannot exhaust live work.
  Demo rooms have no back-fill.
- When a cap is reached:
  - the catalog's `tt.status` marks the track `capped`;
  - live slices carry a `capped` carry-in and no new records;
  - FETCH serves what is archived and answers missing slices with REQUEST_ERROR.
- The track stays subscribable, so the UI can say why it is silent.

## 6. Where our stack falls short

| # | Gap | Spec | Workaround | Cost |
|---|---|---|---|---|
| 1 | The browser publisher (speaker media) cannot be a FETCH origin, and moq-relay keeps about 30 s | FETCH to the original publisher (D18 §10.12.3) | media history over HTTP: HLS with CMSF-conformant fMP4 segments, played by hls.js | the viewer has two sources for media; MoQ history covers the AI tracks only |
| 2 | FETCH is one group | ranges (D18 §10.12) | slices make one group the unit of seeking | n `fetchGroup` calls for n slices (cheap, merged at the relay) |
| 3 | FETCH opens an upstream SUBSCRIBE that lives as long as the FETCH (S4, S6) | FETCH is not a subscription | demand = open 1 s with no FETCH of the track in flight in the last 1 s | live output starts ≥1 s after the first viewer |
| 4 | AbsoluteStart, NextGroupStart filters ignored on draft-18 | D18 §5.1.2 | late join = SUBSCRIBE + Joining FETCH relative 0 (D18 §5.1.3) | one more request per join |
| 5 | Forward=0 refused | D18 §5.1 | not needed: the catalog lists tracks without subscribing | — |
| 6 | TRACK_STATUS refused | D18 §10.14 | the catalog carries status; the edge comes from the teacher clock | — |
| 7 | Delivery timeouts ignored | D18 §10.2.3–10.2.4 | none needed: the latest group is always delivered (S6); viewers check its number against now | — |
| 8 | REQUEST_UPDATE: priority only | D18 §10.9 | fixed options per subscription; reopen to change | a resubscribe |
| 9 | Nothing is served after the publisher leaves (S1) | not specified | agents of a finished room stay connected as origins while the room is listed; the looper does so for demo rooms | one idle process per agent per listed room |
| 10 | aiomoqt answers a whole-group FETCH with End Object 2^62+1, and moq-relay then replies "not found" (S4b) | FETCH_OK End Location (D18 §10.13); `{k, last+1}` is valid | our origin sets the End Location to the slice's last object + 1, from the archive | a small override in our FETCH handler; verified in S4c (IETF client) and S3 (browser) |
| 11 | aiomoqt's `close_reader` sends no unsubscribe | D18 §3.3.2 | call `session.unsubscribe(request_id)` (fixed by the Lazy agents lane) | — |
| 12 | Safari and iOS on WebSocket: no datagrams, TCP head-of-line blocking | — | history at the lowest priority, at most 2 fetches in flight | weaker prioritisation for those viewers |
| 13 | One route per namespace instead of subscriptions to every publisher; a killed publisher stalls its open subscriptions until the QUIC idle timeout (S5) | D18 §9.3, §9.5 | agents close cleanly on SIGTERM and advertise a 3 s idle timeout with a 1 s keep-alive (S5b) | ~1–3.5 s of silence after a crash |
| 14 | A FETCH of the slice in which the relay's upstream subscription began never completes: the relay answers it from its partial cached group and never asks the origin, not at the slice's end, not 20 s later, not from another session; other slices take 7–16 ms (Benchmark lane, `wiki/benchmark.md` Results) | FETCH of a past group (D18 §10.12) | viewers take the open slice from their SUBSCRIBE, FETCH only slices below the first slice they received live, and put a ~2 s timeout on every FETCH | the part of that slice published before the relay subscribed cannot be fetched through the relay (when, or whether, it becomes fetchable after eviction is not measured) |

## 7. What the build demonstrates (for the judges)

| MoQT property | Where Talk Tracks shows it | Spec |
|---|---|---|
| Named tracks under namespaces | every AI step is a track a viewer picks; the MSF catalog lists them | D18 §2.4, MSF §5 |
| Subscription aggregation at the relay | one paid translation for any number of viewers | D18 §9.4 |
| Demand-driven publishing | an agent works only while subscribed and idles 11 ms after the last viewer leaves | D18 §9.4–9.5 |
| Composition through the relay | translation and chapters subscribe to captions as viewers do; demand chains upstream | D18 §9.5 |
| Groups as join points | each 4 s slice opens with a self-contained carry-in; late join is instant | D18 §2.3, MSF §8.3 |
| SUBSCRIBE for live, FETCH for the past | live tracks by SUBSCRIBE; rewind and scrollback by one-group FETCH, same track, same names | D18 §10.7, §10.12 |
| Relay cache plus origin | the relay serves recent slices; misses go to the agent, which serves its archive | D18 §9.1, §10.12.3 |
| FETCH as demand for the past | a translation slice nobody paid for is produced when someone fetches it, once, within a budget | D18 §10.12 |
| Location continuity across restarts | slice numbers come from the room clock; a replacement publisher or a reloaded speaker continues them | D18 §2.4.3 |
| Standard formats on top | captions as WebVTT-MSF event timelines; slices as an MSF template; media archive as CMSF segments | MSF §7.4, §8; WebVTT-MSF; CMSF |
| Priorities | voice and captions first under congestion; history last | D18 §7 |

Demo aid: a small inspector panel in a live room shows, per track, whether the agent is producing, the FETCHes it
served as origin against the viewer's own FETCHes (the difference is the relay cache), back-fills, and the ledger
spend, all from the catalog's `tt.status`. The
looped demo rooms replay recordings, so this panel is where judges see the lazy agents and aggregation at work.

## 8. Changes for the other lanes (summary; the full list is in the report)

- **Speaker console (web):** nothing new for the clock: @moq/publish already writes the hang root `clock`. Check it
  is present, and show an error if it is not. Stamp slide frames with their wall time (`performance.timeOrigin +
  performance.now()`).
- **Lazy agents:**
  - stable names; event-timeline objects in 4 s slices; carry-in; End of Group per slice;
  - room time from the teacher catalog's `clock` and the room epoch; the open slice from the input watermark;
  - the demand rule of §5.3; finish the open slice on the last leave;
  - late join via a Joining FETCH;
  - record own output, serve FETCH from the archive with a correct End Location;
  - translation back-fill per §5.7; REQUEST_ERROR when not allowed;
  - 3 s QUIC idle timeout and 1 s keep-alive.
- **Track archive:**
  - no subscriptions to agent tracks;
  - the archive library agents use: write-once slices by (track, group), read a slice, last object of a slice;
  - media archive as CMSF fMP4 segments plus an HLS playlist with PROGRAM-DATE-TIME, DISCONTINUITY and GAP;
  - the room epoch `E`, kept in the archive;
  - the MSF room catalog, with `tt.status` from the ledger.
- **Rewind (web):**
  - agent tracks via `fetchGroup(⌊t/S⌋ − 1 … ⌊(t+L)/S⌋)`, merge cues by `id` and `rev`;
  - media via hls.js (native on Safari);
  - one subscription per track, never updated.
- **Benchmark:** add rows for FETCH served by the cache vs the origin, and bytes per opted-in track per slice.
- **Demo content:** the looper writes the root `clock`, keeps room time rising across loops, publishes sliced
  event-timeline tracks under the same names and serves FETCH from the recording.

## 9. Spike results

Against a private moq-relay 0.17.8 (`spikes/moqt/compose.yml`), aiomoqt pinned to draft-18, Node 22 for
@moq/net 0.4.5 over the relay's WebSocket path. Fake publishers only. The host was heavily loaded (CPU at 100 %
from other stacks), so latencies are upper bounds.

| Spike | What | Result |
|---|---|---|
| S1 `fetch_relay.py` | TRACK_STATUS | refused, code 3 "TRACK_STATUS is not supported" |
| S1 | late join, Largest Object filter, 10 groups/s | publisher at group 49, first group delivered 51 |
| S1 | SUBSCRIBE AbsoluteStart group 10 | ignored: got 51, 52, 53 |
| S1 | FETCH groups 0..9, 40..45, 300..305 | refused, code 3 "FETCH spanning several groups not supported" (11–40 ms) |
| S1 | FETCH of one future group (60 while at 54) | forwarded to the publisher, which answered INVALID_RANGE (code 17), relayed |
| S1 | Joining FETCH relative 5 | failed: the relay joins only the current group |
| S1 | last viewer unsubscribes | publisher `producing` false after **11 ms** |
| S1 | FETCH after the publisher left | code 16 "unroutable" (32 ms) |
| S2 `history_origin.py` | FETCH of one group 43 s old, viewer subscribed | served from the **relay cache** in 90 ms (not forwarded) |
| S2 | FETCH of a recent group | relay cache, 39 ms |
| S2 | quiet track (one object, 10 s silence), Largest Object | nothing in 3 s |
| S2 | second publisher announces the same namespace (group ids from 1000) | new subscribers read **p2**; the existing subscriber stayed on p1 and ended when p1 left (0 objects after) |
| S3 `web_fetch.mjs` | browser client live over WebSocket | subscribed, 9 groups in 4 s |
| S3 | a second subscription on the same track with another `maxAge` | the subscription ended, "remote error: 0" |
| S3 | the live subscription in the second run | ended after ~30 s with "remote error: 0". That run shared the relay with S4b; a clean rerun with relay logs held the subscription for 40 s, so it did not reproduce |
| S3 rerun, stock origin | `fetchGroup` of a cached group / a 40 s old (evicted) group / with no subscription / after the publisher left | 54 ms / moq-lite error 51 "not found" (forwarded to the origin, the S4b bug) / 51 / 54 "unroutable" |
| S3 rerun, fixed origin | the same | 52 ms / **50 ms from the origin, then 48 ms from the cache** (the origin saw one FETCH) / 54 ms (the relay subscribed upstream, then fetched) / 54 "unroutable" |
| S4 `origin_fetch.py` | quiet track 8 s old: Next Group Start / Joining FETCH relative 0 / Largest Object | group 0 in 49 ms / group 0 in 42 ms / nothing in 3 s |
| S4 | FETCH with nobody subscribed | relay SUBSCRIBEd upstream at +21 ms, forwarded the FETCH at +23 ms, cancelled the SUBSCRIBE at +32 ms (it lived 11 ms) |
| S4 | origin answers 3 s late | the relay waited: the reply came at 3.15 s |
| S4b `origin_fetch_unseen.py` | FETCH of a group only the publisher's history holds | "not found" (code 16), with and without a live subscriber, 1- and 60-object groups. aiomoqt reports End Object 2^62+1 for a whole group (`track.py`, `_fetch_range`), and the relay rejects an End Location it reads as at or below the start (src `ietf/subscriber.rs:3124`) |
| S4c `origin_fetch_end.py` | stock track / End Location set from the history / a made-up track name served by session handlers (`register_handler`) from a dict | "not found" ×3 / **served in 34–42 ms** / FETCH with nobody subscribed 41 ms, SUBSCRIBE ok, FETCHes 32–37 ms, a repeat not forwarded (cache), a slice the handler lacks: code 16 |
| S5 `restart_killed.py` | publisher killed with a viewer subscribed; replacement announces 0.05 s later | new subscriptions got **nothing for 12.4 s** (relay log: they joined the stalled upstream subscription); then the dead connection timed out and all subscriptions read the replacement |
| S5b `restart_killed.py`, `SPIKE_IDLE_S=3` | the same, with publishers advertising a 3 s QUIC idle timeout and 1 s keep-alive | new subscriptions read the replacement within ~1 s of the kill; the held subscription ended after ~3.5 s and moved to the replacement |
| S6 `jury_checks.py induced` | FETCH with nobody subscribed, origin answering at once / after 1.5 s / after 3 s | the relay's upstream SUBSCRIBE lived **8 ms / 1510 ms / 3010 ms**: until the FETCH completed |
| S6 `web_quiet.mjs` | browser late-joins an IETF track quiet for 12 s, default and `maxAge` 0 | the latest group delivered in 76 ms and 57 ms |

## 10. Decisions

The owner's choices on 2026-10-28, recorded in
[decision 0012](../decisions/0012-ai-track-history-by-fetch-from-the-agent.md):

1. **Origin of AI-track history:** each agent serves its own track's past by FETCH.
2. **Media rewind:** over HTTP from the archive, as HLS with fMP4 segments played by hls.js (revised after review;
   first chosen as hand-rolled MSE).
3. **Group model:** 4 s time slices on the room clock, with a carry-in object.
4. **Back-fill:** on FETCH, per slice; in this build for translation only, with its own budget (revised after
   review; first chosen for every track).
5. **Room clock:** wall time of the speaker's media from the hang catalog's root `clock`, minus the room epoch
   (revised after review; first chosen as an offset on our own `clock` track).
6. **Formats:** MSF catalog, MSF event timelines, WebVTT-MSF cues (after review).

## 11. Independent review

Three jurors reviewed the first version on 2026-10-28. Each saw only that version of this page and the specs
(MoQT transport -18 and -22, MSF, CMSF, LOC, the catalog format, WebVTT-MSF, moq-lite-06, hang-03), with no access to
the repo, our notes or the spike logs. Their lenses were transport, media and packaging, and system and product. All
three returned **approve with changes**, and again on the revised version, with smaller text-level changes. What
changed in response to both rounds:

| Finding (juror) | Change |
|---|---|
| The clock offset could collide group ids and could bind to the wrong broadcast (transport, media) | the room clock now comes from the teacher's own hang `clock`; a skew guard ([§4.5](#45-the-room-clock)) |
| Placeholder `capped` groups and later back-fill break object immutability (all three) | REQUEST_ERROR instead of placeholders; write-once slices; no gap signalling ([§5.7](#57-back-fill-of-a-track-switched-on-mid-talk)) |
| The settle time fails for slow back-fill (transport, system) | measured in S6; demand rule tied to in-flight FETCHes ([§5.3](#53-lazy-agents-and-how-demand-reaches-them)) |
| Anonymous viewers can spend on back-fill (transport, system) | a separate back-fill budget, one at a time, translation only, none in demo rooms, ledger reserves first ([§5.12](#512-spend-caps)) |
| The 5 s max-age premise contradicted the evidence (all three) | measured in S6; the coupling and the heartbeats are gone ([§4.1](#41-groups-are-time-slices-on-the-room-clock)) |
| End of Track in a room that can resume (transport) | only when the room is closed ([§4.2](#42-objects-inside-a-group-an-msf-event-timeline)) |
| The two placement rules made seek arithmetic false (media) | open slice by input watermark, declared lateness, fetch window ([§4.2](#42-objects-inside-a-group-an-msf-event-timeline)) |
| Hand-rolled MSE is fragile (media) | HLS fMP4 with hls.js ([§5.5](#55-rewind-into-history-and-go-live)) |
| "MSF-shaped" was not MSF (media, transport) | an MSF catalog and event timelines, deviations declared ([§4.2](#42-objects-inside-a-group-an-msf-event-timeline), [§5.10](#510-room-catalog)) |
| A relay restart was not designed (system) | [§5.9](#59-relay-restart-durability-and-vm-loss) |
| The killed-publisher stall is a relay deviation; a shorter QUIC idle timeout should cut it (transport) | measured in S5b; agents advertise 3 s ([§5.8](#58-agent-restore-after-a-restart)) |
| Scope for 7 days; judges cannot see the AI-side MoQT in looped rooms (system) | captions back-fill moved to a stretch goal; the inspector panel ([§7](#7-what-the-build-demonstrates-for-the-judges)) |
| Second round: a back-fill queue could block demand; the skew guard blocked back-fill and was per consumer; an idle agent had no edge; clock units; HLS codecs and mapping; the outline's payload; translation back-fill read disk (all three) | per-subscription demand rule with a latch and a queue bound; one shift decided by the room service; idle edge from the teacher clock; units stated; codec, playlist and mapping rules with day-1 checks; outline as an event timeline; a FETCH chain |
| Section numbers, the priority direction, the S4b cause, the S4 lifetime (transport, system) | corrected in [§2](#2-what-the-spec-says-what-moq-lite-does-what-our-stack-does), [§5.11](#511-priorities-under-congestion) and [§9](#9-spike-results) |
