---
status: accepted (decision 0012)
date: 2026-10-28
replaces: the coordinator's draft of the same name (2026-10-28)
---

# System design: Talk Tracks on MoQT

The owner's direction: use what MoQT is, rather than build features beside it, so the build shows MoQT's
capabilities and how well they combine with AI APIs. This page proposes how. It is grounded in three things:

- the transport draft as written: draft-ietf-moq-transport-18, the version our agents speak (decision 0001), and
  -22, the latest;
- what our pinned stack really does: moq-relay 0.17.8 (with moq-net 0.3.16), aiomoqt 0.13.1, and @moq/net 0.4.5 in
  the browser, all read from source;
- spikes against a private relay (`spikes/moqt/`, results in [§9](#9-spike-results)).

The coordinator's draft read history as "more tracks through ordinary subscriptions". That treats SUBSCRIBE and
FETCH as interchangeable, and the draft says they are not: "Subscribe only requests newly published or received
Objects. Objects from the past are retrieved using FETCH" (D18 §10.7). This design starts from that split.

Citations: **D18** and **D22** are the transport drafts (section numbers as in the HTML renderings). **MSF** is
draft-ietf-moq-msf-01. **src** is a file in the pinned source. **S1**–**S4** are the spikes.

---

## 1. The model in one paragraph

A track is a sequence of groups, and a group is a join point (D18 §2.3). A subscription asks for what is published
from now on. A fetch asks for a bounded range that already exists, on one stream, and ends (D18 §10.7, §10.12). A
relay aggregates subscriptions, may cache, and forwards a cache miss upstream (D18 §9.1, §9.4, §10.12.3). So:

- **Live demand is a SUBSCRIBE.** It is the only thing that reaches an agent and makes it spend.
- **The past is a FETCH.** The relay answers from its cache. A miss goes upstream to the track's own publisher, which
  is the **origin** of that track's history and serves it from durable storage.
- **Time is the group number.** Every AI track cuts its groups on one room clock, so a viewer turns a
  seek time into the group to fetch by arithmetic, without an index.

## 2. What the spec says, what moq-lite does, what our stack does

Each row is a mechanism the design relies on.

| Mechanism | Spec (draft-18) | moq-relay 0.17.8 towards an IETF client | Browser (@moq/net 0.4.5, moq-lite-06) |
|---|---|---|---|
| Live subscription | SUBSCRIBE with a filter: Next Group Start, Largest Object, AbsoluteStart, AbsoluteRange (§5.1.2) | Only Largest Object is honoured; every other filter is ignored without an error and starts at the latest group (src `ietf/publisher.rs:6780-6789`; S1: asked for group 10, got 51, 52, 53) | `subscribe({priority, maxAge, groups})`; `maxAge` 0 takes only the latest group (src `track.d.ts:66-85`) |
| Late join | a group is a join point (§2.3); a Joining FETCH covers the current group (§10.12.2) | Largest Object starts at the next object, so a quiet track sends nothing (S4: 0 groups in 3 s). Next Group Start, ignored, gives the latest group; so does SUBSCRIBE plus a Joining FETCH relative 0 (S4: both returned the 8 s old group, in 49 ms and 42 ms) | the latest group by default |
| Past objects | FETCH: standalone range, or joining (§10.12) | **One group per FETCH.** A range over several groups is refused, code 3 (S1; src `publisher.rs:1391-1406`). Served from the cache; on a miss, a one-group FETCH goes to the publisher (S1, S4) | `fetchGroup(n)`: one group (src `track.d.ts:142`) |
| A FETCH with nobody subscribed | not specified | the relay SUBSCRIBEs upstream to serve it (S4: SUBSCRIBE after 21 ms, cancelled after 79 ms) | same relay path |
| Publisher gone | not specified for FETCH | nothing is served, cache included: `unroutable`, code 16 (S1) | same |
| Relay cache | optional (§9.1), bounded by MAX_CACHE_DURATION (§12.3) | non-latest groups are dropped after 30 s without a read or write (src `model/cache.rs:83`); in S2 a 43 s old group was still served from cache | — |
| Forward=0 (subscribe without delivery) | §5.1 | refused (src `publisher.rs:580-584`) | — |
| TRACK_STATUS | §10.14 | refused, code 3 (S1) | `info()` (moq-lite TRACK_INFO) |
| PUBLISH (publisher-initiated) | §10.4 | refused; the publisher announces a namespace and serves SUBSCRIBEs (src `subscriber.rs:1189-1218`) | — |
| Namespace announcements | PUBLISH_NAMESPACE, SUBSCRIBE_NAMESPACE (§10.6, §10.10) | supported; an announced namespace is a prefix route (src `subscriber.rs:1380-1428`) | `origin.announced(prefix)` |
| Two publishers of one namespace | SUBSCRIBE to all matching publishers (§9.5) | while the old publisher is alive, the **newest announcement wins** for new subscriptions; existing ones stay on the old publisher and end when it leaves (S2). If the old publisher is **killed** while a subscription to its track is open, new subscriptions join that stalled track until the relay times the dead connection out, 12.4 s in S5 | follows the relay |
| Last subscriber leaves | no relay rule (none in D18 or D22) | the relay cancels upstream at once: STOP_SENDING and FIN on draft-18 (src `subscriber.rs:1869-1892`); the publisher was idle 11 ms later (S1; the Lazy agents lane measured 7–21 ms) | `close()` |
| Priorities | subscriber priority, then publisher priority, then group order (§7.2) | subscriber priority becomes the QUIC stream priority; group order is ignored (src `publisher.rs:693-697, 2394`) | track priority, then subscription priority, then newest group first (src `lite/priority.rs:9-40`); over WebSocket only once data leaves the TCP queue |
| Delivery timeout | SUBGROUP_ and OBJECT_DELIVERY_TIMEOUT (§8) | parsed and dropped; a 5 s max age per IETF-sourced track bounds staleness instead (src `subscribe.rs:87,90`; `origin.rs:119-128`) | `maxAge` |
| Changing a subscription | REQUEST_UPDATE: filter, forward, priority, timeouts (§10.9) | priority only; anything else ends the subscription with UPDATE_FAILED (src `publisher.rs:785-882`) | `update()`; a second subscription with another `maxAge` on one track ended the live one, error 0 (S3) |
| Auth | a token per request (§10.2.2) | one decision per session, through `--auth-url`; then path patterns are checked locally (src `relay auth.rs`) | `?jwt=` |

What this means:

- moq-relay is a **live fan-out relay with a short cache and a one-group FETCH**. It is not a history server, and
  it does not pretend to be. Its author argues for "just use HTTP" for VOD (moq.dev/blog/you-dont-need-it) and puts
  DVR in a separate recording tier (doc.moq.dev, hang Recording).
- The history in this design is therefore served by the **original publisher**, as the spec intends when a relay
  misses (D18 §10.12.3). moq-relay supports exactly that, one group at a time, which is all we need because groups
  are time slices.

## 3. Names, roles and tokens

| Namespace (broadcast path) | Tracks | Publisher | Notes |
|---|---|---|---|
| `talk/R/teacher` | hang catalog, audio, video | the speaker's browser (moq-lite) | as today |
| `talk/R/slides` | `frames` | the speaker's browser | as today |
| `talk/R/agents/<agent>` | `items` (sliced, [§4](#4-track-and-group-model)), and `outline` for chapters | the agent process: live output **and** origin of the track's history | **stable name, no instance segment** (today: `.../<agent>/<instance>`) |
| `talk/R/catalog` | `catalog` | the room service ([§5.10](#510-room-catalog)) | MSF-shaped JSON |

Tokens, with the same signing as decision 0005; only the patterns change:

| Who | Publish | Subscribe |
|---|---|---|
| Speaker of room R | `talk/R/teacher`, `talk/R/slides` | `talk/R/**` |
| Agents of room R | `talk/R/agents/**` | `talk/R/**` |
| Room service (archiver and catalog) | `talk/R/catalog` | `talk/R/**` |
| Looper of demo room R | `talk/R/teacher`, `talk/R/agents/**`, `talk/R/catalog` | `talk/R/**` |
| Viewers | nothing | `talk/**`, anonymous |

## 4. Track and group model

### 4.1 Groups are time slices on the room clock

Every AI track except the outline cuts its groups on the room clock ([§4.5](#45-the-room-clock)): **group `k` covers
room time `[k·S, (k+1)·S)`**, with `S` = 4 s.

- **Seek without an index.** The state at media time `t` is in group `⌊t/S⌋`, plus its neighbours for context. MoQT
  Locations become addressable by time, which moq-relay's one-group FETCH needs, since it cannot answer "the latest
  group before t".
- **Ids continue across restarts.** The group number comes from the room clock, not a counter, so a restarted agent,
  a reloaded speaker or a new loop of a demo room never reuses one. This is what D18 §2.4.3 warns about for a publisher that crashes and
  resumes. It also gives decision 0009's "ids continue" at the transport level.
- **`S` is under moq-relay's 5 s max age.** The latest group is then always fresh enough to be delivered to a late
  joiner, without the 2 s heartbeat groups agents publish today.
- **Groups may be missing.** An idle agent produces none. A FETCH of a missing slice is the back-fill trigger
  ([§5.7](#57-back-fill-of-a-track-switched-on-mid-talk)).

### 4.2 Objects inside a group

- **Object 0 is the carry-in:** a small, bounded state that makes the group independently useful (D18 §2.3). It holds
  the last 2 caption lines, the slide on screen with its description, or the current chapter title. A late joiner
  shows it immediately.
- **Objects 1 and up are items in publication order:** a caption line (interim versions, then the final one), a
  translated line, a slide description. Each item carries its id and its media times, as `CaptionLine` and the other
  contracts already do.
- **The group ends with End of Group** (status 0x3, D18 §11.2.1.1) when the slice is over. The last group of a talk
  ends with End of Track (status 0x4).
- **Objects are immutable** (D18 §2.1). Live and fetched copies of a group are byte-identical, so the archive stores
  exactly what was sent, interim captions included (about 1–2 KB per slice).

Two rules decide where an item goes:

- **Live:** an item goes into the slice that is open when it is produced, so groups advance with time (D18 §2.3.1).
  A translation of a line spoken late in slice k may land in k+1. The viewer fetches neighbours and merges items by
  id.
- **Back-fill:** an item produced later for a past slice k goes into group k, which the agent never produced live.
  It is reachable only by FETCH, never by a live SUBSCRIBE (D18 §10.7).

### 4.3 The outline

Chapters, glossary and recap are revised as a whole by the LLM, so a slice log would be wrong for them. The
`outline` track is a **snapshot track** in the hang `snapshot` sense: each revision is a new group holding one
object with the full outline, a few KB. Late join gets the latest group. Seeking never needs an older outline; the
viewer always shows the newest one, whose chapters carry their `start_ms`.

### 4.4 Wire contract changes

These go through the coordinator, because they change `contracts/`:

- The envelope gains `slice` (k) and `kind: "carry" | "item"`; the full-state `lines` and `slides` lists become one
  item per object.
- `seq` and `instance` go away: the Location (group, object) is the sequence, and the stable name replaces the
  instance.
- The outline envelope stays a snapshot.
- Every media time in every contract (`start_ms`, `end_ms`, `at_ms`, `media_ms`) is room time ([§4.5](#45-the-room-clock)).
- New: the `clock` object below.

### 4.5 The room clock

The speaker's media timestamps come from @moq/publish, which stamps audio from `performance.now()` at capture
start (src `@moq/publish` capture worklet, `zero: performance.now()`). They restart near 0 whenever the speaker
reloads or starts a second broadcast in the room, so slice k of the new broadcast would collide with slice k of the
old one. The owner chose one room clock carried by an offset (2026-10-28, addendum to decision 0012):

**room time = speaker media timestamp + `offset_ms`**, where the speaker console chooses `offset_ms` once per
broadcast and publishes it. Every consumer adds the same offset, so agents, the archive, the media rewind and the
viewer share one clock.

- **The `clock` track.** The speaker console publishes track `clock` in its `talk/R/slides` broadcast (already in
  the speaker's token), **before** it starts publishing audio. One JSON object per group, a new group on change and
  every 4 s (relay max age 5 s):
  `{"epoch_ms": E, "offset_ms": O, "session": "<broadcast start, wall ms>"}`.
- **Choosing the offset.** `E` is the wall time of the room's first broadcast. On a later broadcast the console reads
  `E` and the room's latest room time `end_ms` from the catalog ([§5.10](#510-room-catalog)). Then
  `O = max(performance.timeOrigin − E, end_ms + 4000 − performance.now())`, rounded to whole ms. Room time follows
  wall time since `E`, so a reload shows as a real gap. The `max` keeps it monotonic even if a second device's clock
  runs behind, and puts the new broadcast's first slice after the last archived one. The first broadcast of a room
  sets `E = Date.now()`.
- **Consumers wait for the clock.** An agent or the archiver stamps nothing from a teacher broadcast until it has
  that broadcast's `clock` object, and re-reads it when the teacher broadcast is re-announced. A teacher broadcast
  with no `clock` track (the demo looper, which already writes room time) means offset 0.
- **Gaps.** Room time has holes where nobody broadcast. Slices there are missing; FETCH of one returns "not found"
  without back-fill, because the archive has no audio for it. The rewind player skips holes in the fMP4 timeline.
- **Limitation.** This works around @moq/publish, which offers no way to set the timestamp origin. Patching it, or
  asking upstream for an origin option, would remove the offset and the `clock` track: ticket 0019.

## 5. Flows

### 5.1 Live viewing and late join

- The viewer reads `talk/R/catalog`, then subscribes to the teacher's media and to each track it has switched on.
- **The browser** (moq-lite) gets the latest group by default: the current slice, with its carry-in object.
- **An agent** reading another agent's track (IETF, draft-18) sends SUBSCRIBE (Largest Object) plus a Joining FETCH
  relative 0 (D18 §10.12.2). This is the spec's late-join pattern, and it is supported and measured (S4: 42 ms).
  Today's `StartAt(mode="latest")` alone gets nothing until the next object arrives.
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
- The agent reads aiomoqt's `PublishedTrack.producing` (`track.py:553`) and works only while it is true. The relay
  cancels the upstream subscription as soon as the last viewer leaves (11 ms in S1).
- **Chains:** translation and chapters SUBSCRIBE to `talk/R/agents/captions` like any viewer. Their subscription
  keeps captions producing, and the relay aggregates it with the viewers' subscriptions. This is the MoQT subscription
  chain itself; there is no side channel.
- **A FETCH is not demand, but moq-relay makes it look like demand.** To forward a FETCH, the relay opens an upstream
  SUBSCRIBE and cancels it about 80 ms later (S4). An agent must therefore not start paid live work on a subscription
  younger than a short **settle time, 1 s**. A fetch-only reader then costs nothing.
- **Workaround cost:** live output starts 1 s later for the first viewer.

### 5.4 Recording without creating demand

- The relay is not a recorder: about 30 s of cache, and nothing once the publisher leaves (S1). A recorder that
  SUBSCRIBEs to agent tracks counts as a viewer and makes every agent eager (the Lazy agents lane found the same).
- **Rule: a track is recorded by its own publisher, as it publishes.** Each agent writes every object it sends to its
  archive slice file, and the relay never sees a recorder. Recording creates no demand because it is not a
  subscription.
- Speaker media and slide frames come from a browser, which cannot record or serve history. The **archiver**
  subscribes to them. That costs no API money, because no agent's work depends on it.

### 5.5 Rewind into history, and "Go live"

- The viewer seeks to media time t:
  - **Agent tracks:** it fetches `⌊t/S⌋` and its neighbours, one `fetchGroup` each.
  - The relay serves its cache. On a miss, it forwards a one-group FETCH to the agent, which is the origin and reads
    the slice from its archive (disk, then the bucket).
  - Ten students rewinding to the same minute cost one read: the relay merges concurrent fetches of a group (src
    `track.rs:306-312`).
- **Media** (speaker audio and video): played from the archive's fMP4 segments over HTTP, with MSE, as decision 0007
  had it. This is the one place the design leaves MoQ. See [§6](#6-where-our-stack-falls-short), row 1.
  - The archive's fMP4 is written on room time, so MSE `currentTime` is room ms / 1000, the same clock as the
    slices, and the media position and every track line up.
- **Go live:** the viewer drops the fetched state, keeps (or re-opens) its live subscriptions, and jumps to the
  current slice. While rewound, the live subscriptions stay open: the viewer opted into those tracks, so keeping them
  open adds no spend.

### 5.6 "What you missed"

- The viewer was away from slice a to slice b: tab hidden, rewound, or reconnected.
- It shows the outline chapters whose `start_ms` falls in `[a·S, b·S)`. They come from the live outline snapshot, so
  this costs no API call.
- The caption slices a … b are one FETCH each, if the viewer wants the transcript.
- A per-viewer recap would be a paid call per viewer, so the design does not make one.

### 5.7 Back-fill of a track switched on mid-talk

- **FETCH is demand for the past.** A FETCH of a slice the agent never produced reaches the agent through the relay.
  The agent produces that slice now:
  - translation fetches the captions slice;
  - captions reads the archived speaker audio from local disk.
- The agent stores the slice and answers the FETCH. The relay waited 3 s for a slow origin in S4, so a back-fill
  call of 1–3 s fits.
- **Chained back-fill is the same mechanism one hop down.** Translation's FETCH of a missing captions slice
  back-fills captions first.
- **Bounded:** back-fill runs only for slices a viewer actually fetches, which is a scrolled-to or rewound window,
  not the whole talk. It is charged to the room's cap ([§5.12](#512-spend-caps)). When the cap is reached, the
  answer is an empty group with a `capped` carry-in.
- **A fetched slice is paid once.** It is in the archive from then on, and later FETCHes of it are cache or archive
  reads.

### 5.8 Agent restore after a restart

- A new process announces the same stable namespace, so no instance naming is needed. What happens next depends on
  how the old one ended:
  - **Clean leave** (SIGTERM handled, session closed): the relay drops the old route at once. Existing subscriptions
    end and resubscribe; new ones go to the new process (S2).
  - **Killed** (crash, OOM, `docker kill`): the relay keeps the dead session until its QUIC idle timeout. A viewer's
    open subscription keeps the track alive there, and every new subscription joins that stalled track, even after
    the replacement has announced. In S5 the track was silent for **12.4 s**; then the dead connection timed out,
    the held subscription ended, and all subscriptions moved to the new process within 0.3 s.
  - So agents must close their session on SIGTERM (a planned restart costs well under a second), and a crash costs
    ~12–15 s of silence on that agent's tracks, on top of the container restart.
- Viewers and downstream agents resubscribe when their subscription ends. @moq/net's `requesting.active` flips to the
  newest route, and IETF readers watch SUBSCRIBE_NAMESPACE.
- The agent seeds itself from its own archive: the last slice's carry-in and items (decision 0009). It then starts
  at the next slice boundary.
  - The partly published current slice is skipped, because another publisher's group k cannot be continued.
  - This loses up to S = 4 s of output, within 0009's "1–3 s plus the restart".
- No state file is needed. The archive is the state.

### 5.9 Durability (decision 0011 stands)

- Each agent appends its slices to the room archive on the VM's disk, one file per track. The format is the Track
  archive lane's, extended with the group number.
- The archiver writes the speaker's media segments.
- A copier sends finished slices and segments to the bucket within seconds.
- After losing the VM: restore the bucket, `compose up`. Agents then serve FETCH from the restored archive under the
  same names and group numbers.

### 5.10 Room catalog

- `talk/R/catalog` is one JSON track, shaped after MSF §5. It lists each track with:
  - name and namespace;
  - kind and language;
  - packaging: `"slices"` with `sliceMs: 4000`, or `"snapshot"`;
  - `depends` (MSF §5.2.14; for example translation depends on captions);
  - a status: idle, live or capped;
  - a cost class: paid on use, or free.
- At room level it carries the room clock: `epoch_ms` (the first broadcast's wall time) and `end_ms` (the latest
  room time archived), which a reconnecting speaker console needs to choose its offset ([§4.5](#45-the-room-clock)).
- It is published by the **room service**, the archiver. It learns the room's tracks through SUBSCRIBE_NAMESPACE on
  `talk/R`, which creates no demand, and the status from the agents' own announcements.
- **Snapshot semantics:** a new group per change, plus a fresh group every 4 s so it stays inside the relay's 5 s
  max age for late joiners. It is a few hundred bytes.
- MSF's catalog is object 0 of a group plus deltas, and it is read with SUBSCRIBE plus a Joining FETCH (MSF §5). We
  keep the snapshot form because browsers get the latest group by default.

### 5.11 Priorities under congestion

| Track | moq-lite priority (higher first) | Reason |
|---|---|---|
| speaker audio | 255 | the voice comes first |
| captions | 224 | the words |
| translation | 208 | the words, translated |
| catalog | 200 | tiny; the UI needs it |
| speaker video | 160 | bulky; can drop |
| slides and descriptions | 128 | |
| outline | 96 | |
| FETCH (history, back-fill) | 32 | never ahead of live |

- **IETF side:** agents declare a publisher priority (aiomoqt `PublishSpec.priority`), which the relay uses as the
  track's tie-break, and downstream agents set a subscriber priority. Whether aiomoqt applies its own stream
  priorities on the wire is not verified: its agent API reports "enforced: False" (src `agent/session.py:241-278`).
- **Browser side:** the viewer sets a subscription `priority` per track, and passes the history priority to
  `fetchGroup`.
- **Safari and iPhone use the WebSocket fallback** (WebKit bug 319818, src `connection/browser.js`). There, priority
  acts only once bytes leave the TCP send queue. So history fetches stay small, one slice at a time and at most 2 in
  flight, and video follows the browser's own bandwidth signal.

### 5.12 Spend caps

- Spend happens in agents only, recorded in the VM ledger (decision 0008, Lazy agents lane).
- **MoQT's part is to make spend follow requests:**
  - live work only while there is a settled SUBSCRIBE;
  - back-fill only per FETCHed slice.
- When a room's cap is reached:
  - the catalog marks the track `capped`;
  - live slices carry a `capped` carry-in and no new items;
  - FETCH serves what is archived and answers missing slices with an empty `capped` group.
- The track stays subscribable, so the UI can say why it is silent.

## 6. Where our stack falls short

| # | Gap | Spec | Workaround | Cost |
|---|---|---|---|---|
| 1 | The browser publisher (speaker media) cannot be a FETCH origin, and moq-relay keeps about 30 s | FETCH to the original publisher (§10.12.3) | media history over HTTP (fMP4 + MSE, decision 0007) from the archiver's segments | the viewer has two sources for media; MoQ history covers the AI tracks only. A full MoQ media origin would need a re-publisher and a WebCodecs player for fetched groups: out of scope |
| 2 | FETCH is one group | ranges (§10.12) | slices make one group the unit of seeking | n `fetchGroup` calls for n slices (cheap, merged at the relay) |
| 3 | FETCH alone opens an upstream SUBSCRIBE (S4) | FETCH is not a subscription | agents ignore a subscription younger than 1 s | 1 s more before live output starts for the first viewer |
| 4 | AbsoluteStart, NextGroupStart filters ignored on draft-18 | §5.1.2 | late join = SUBSCRIBE + Joining FETCH relative 0 (§10.12.2), supported | one more request per join |
| 5 | Forward=0 refused | §5.1 | not needed: the catalog lists tracks without subscribing | — |
| 6 | TRACK_STATUS refused | §10.14 | the catalog carries status; `fetchGroup` of the current slice for the edge | — |
| 7 | Delivery timeouts ignored; a fixed 5 s max age for IETF-sourced tracks | §8 | `S` = 4 s; the catalog republished every 4 s | the slice length is tied to a relay constant |
| 8 | REQUEST_UPDATE: priority only | §10.9 | fixed options per subscription; reopen to change | a resubscribe (S3: ~100 ms) |
| 9 | Nothing is served after the publisher leaves (S1) | not specified | agents of a finished room stay connected as origins while the room is listed; the looper does so for demo rooms. Alternative, shown in S4c: one history process announces a finished room's agent namespaces and answers SUBSCRIBE and FETCH from the archive with session handlers | one idle process per agent per room, or one history process for all finished rooms |
| 10 | aiomoqt answers a whole-group FETCH with an End Location the relay reads as empty: "not found" (S4b) | §10.13 | our origin sets FETCH_OK's End Location to the slice's last object + 1, from the archive | a small override in our FETCH handler; **verified** in S4c (IETF client) and S3 (browser) |
| 11 | aiomoqt's `close_reader` sends no unsubscribe | §3.3.2 | call `session.unsubscribe(request_id)` (already fixed by the Lazy agents lane) | — |
| 13 | A killed publisher keeps its track's subscribers until the relay's QUIC idle timeout, even after a replacement announces (S5) | not specified | agents close their session on SIGTERM; crashes accepted | ~12–15 s of silence on that agent's tracks after a crash |
| 12 | Safari and iOS on WebSocket: no datagrams, TCP head-of-line blocking | — | history at the lowest priority, at most 2 fetches in flight | weaker prioritisation for those viewers |

## 7. What the build demonstrates (for the judges)

| MoQT property | Where Talk Tracks shows it | Spec |
|---|---|---|
| Named tracks under namespaces | every AI step is a track a viewer picks; the catalog lists them | D18 §2.4 |
| Subscription aggregation at the relay | one paid translation for any number of viewers | D18 §9.4 |
| Demand-driven publishing | an agent spends only while subscribed and idles 11 ms after the last viewer leaves | D18 §9.4–9.5 |
| Composition through the relay | translation and chapters subscribe to captions as viewers do; demand chains upstream | D18 §9.5 |
| Groups as join points | each 4 s slice opens with a self-contained carry-in; late join is instant | D18 §2.3 |
| SUBSCRIBE for live, FETCH for the past | live tracks by SUBSCRIBE; rewind and scrollback by one-group FETCH, same track, same names | D18 §10.7, §10.12 |
| Relay cache plus origin | the relay serves recent slices; misses go to the agent, which serves its archive | D18 §9.1, §10.12.3 |
| FETCH as demand for the past | a slice nobody paid for is generated when someone fetches it, once, within the cap | D18 §10.12 |
| Location continuity across restarts | slice numbers come from the room clock; a replacement publisher or a reloaded speaker continues them | D18 §2.4.3 |
| Priorities | voice and captions first under congestion; history last | D18 §7 |
| End of group and end of track | slices close with End of Group; a finished talk ends with End of Track | D18 §11.2.1.1 |

## 8. Changes for the other lanes (summary; the full list is in the report)

- **Lazy agents:**
  - stable names;
  - slices on the room clock: read the speaker's `clock` track before stamping;
  - the 1 s settle time;
  - late join via a Joining FETCH;
  - each agent records its own output and serves FETCH from the archive;
  - back-fill on FETCH, within the cap;
  - token patterns unchanged.
- **Track archive:**
  - no subscriptions to agent tracks;
  - an archive library that agents write and read (slice files by group number);
  - the archiver records speaker media and slides, publishes the catalog, and copies to the bucket.
- **Rewind:**
  - agent tracks via `fetchGroup(⌊t/S⌋)`;
  - media via HTTP and MSE, on the room clock, skipping holes;
  - one subscription per track, never updated.
- **Speaker console (web):** choose the offset per broadcast and publish the `clock` track before audio
  ([§4.5](#45-the-room-clock)); stamp slide `at_ms` in room time.
- **Benchmark:** add a row for FETCH-from-origin latency, cached and uncached, and bytes for selective subscription
  per slice.
- **Demo content:** the looper publishes sliced tracks under the same names and serves FETCH from the recording.

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
| S4 | FETCH with nobody subscribed | relay SUBSCRIBEd upstream at +21 ms, forwarded the FETCH at +23 ms, cancelled at +32 ms; the subscription lasted 79 ms |
| S4 | origin answers 3 s late | the relay waited: the reply came at 3.15 s |
| S4b `origin_fetch_unseen.py` | FETCH of a group only the publisher's history holds | "not found" (code 16), with and without a live subscriber, 1- and 60-object groups. Cause in source: the relay rejects a FETCH_OK whose End Location is at or below the start (src `ietf/subscriber.rs:3124`); aiomoqt sends End Object 2^62+1 for a whole group (`track.py`, `_fetch_range`), which a QUIC varint cannot carry |
| S4c `origin_fetch_end.py` | stock track / End Location set from the history / a made-up track name served by session handlers (`register_handler`) from a dict | "not found" ×3 / **served in 34–42 ms** / FETCH with nobody subscribed 41 ms, SUBSCRIBE ok, FETCHes 32–37 ms, a repeat of slice 8 not forwarded (cache), a slice the handler lacks: code 16 |
| S5 `restart_killed.py` | publisher killed with a viewer subscribed; replacement announces 0.05 s later | new subscriptions got **nothing for 12.4 s** (relay log: they joined the stalled upstream subscription); then the dead connection timed out and all subscriptions read the replacement (first object 32–220 ms) |

All planned spikes have run. Not measured: the relay cache's real retention under load (S2 served a 43 s old group
from the cache; the S3 rerun saw a 40 s old one evicted, as the 30 s idle rule predicts).

## 10. Decisions

The owner chose the recommended option for each of the four questions on 2026-10-28, recorded in
[decision 0012](../decisions/0012-ai-track-history-by-fetch-from-the-agent.md):

1. **Origin of AI-track history:** each agent serves its own track's past by FETCH.
2. **Media rewind:** over HTTP from the archive's fMP4 segments, with MSE.
3. **Group model:** 4 s time slices on the room clock, with a carry-in object.
5. **Room clock** (addendum): speaker media timestamp + an offset the speaker console publishes per broadcast.
4. **Back-fill:** on FETCH, per slice, within the room cap.
