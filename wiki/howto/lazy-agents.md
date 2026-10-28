# Lazy agents and spend caps

An agent does paid work only while its track has a subscriber (decision 0010), and every room has a spend cap
(decision 0008). This page records how the relay signals demand, how the agents use it, and how caps are set.

## What the relay tells a publisher (measured)

Measured on 2026-10-28 against moq-relay 0.17.8 in Docker (local bridge network, `--auth-public '**'`), with an
aiomoqt 0.13.1 publisher on `talk/probe/agents/x/1` track `state` that logs aiomoqt's `PublishedTrack.producing`
every 10 ms. Subscribers were aiomoqt (IETF draft-18 over raw QUIC) and `moq fetch` from moq-cli 0.14.8 (moq-lite
over raw QUIC, the protocol family the browser speaks).

| Case | What the publisher saw | Time |
|---|---|---|
| First viewer subscribes | the relay subscribes upstream (`producing` goes true) | 1-4 ms |
| Viewer cancels its subscription (aiomoqt, draft-18 request-stream cancel) | the relay cancels upstream (`producing` false) | 7 ms |
| moq-lite viewer reads one group and leaves (`moq fetch`) | upstream subscribed, then cancelled | 21 ms between the two |
| Two viewers; the first leaves | nothing: the relay holds one upstream subscription for both | - |
| Two viewers; the last leaves | upstream cancelled | 12 ms |
| Viewer process killed (no close) | upstream cancelled when the relay's QUIC idle timeout fires | 10.2-10.3 s (3 runs) |
| Viewer stays connected but stops reading, never cancels | upstream stays subscribed until that session ends | 2 min (until the probe closed) |

So the relay does signal it usefully: it subscribes upstream on the first downstream subscriber, holds one upstream
subscription for any number of viewers, and cancels it within milliseconds of the last clean leave, or about 10 s
after the last viewer vanishes. The publisher sees each change in aiomoqt as `PublishedTrack.producing` (and the
set of upstream subscription ids), with no polling of the relay.

Two consequences:

- A viewer must cancel the subscription when it switches a track off. Staying subscribed and ignoring the objects
  keeps the agent paying.
- aiomoqt's `AgentSession.close_reader` does not cancel on the wire: it only drops the reader locally, and the relay
  keeps forwarding. The agents call `session.unsubscribe(request_id)` first (in `moq.Relay.objects`), so a
  downstream agent that pauses really releases its upstream track.

Not measured: a browser tab closing its WebTransport session (expected to match the clean case, or the 10 s idle
timeout when the tab dies).

## How an agent idles and wakes

Each agent publishes its track under its stable name (`talk/<room>/agents/<agent>`, track `items`, or `outline` for
chapters) as soon as it serves a room, so a viewer can find it and switch it on. That costs nothing: an idle agent
produces no slices. The agent opens its inputs only while its track is wanted (`demand.Gate`, polled every 100 ms):

| Agent | Input it opens while wanted | On a pause |
|---|---|---|
| `captions` | the speaker's audio | closes the ASR session: no audio is sent, nothing more is paid |
| `translate` | the captions track (SUBSCRIBE plus a Joining FETCH) | unsubscribes from captions, so captions can pause too |
| `chapters` | the captions track | as translate |
| `describe` | the slide frames | unsubscribes from the slides |

A downstream agent is an ordinary subscriber: a viewer of the Turkish translation keeps translate running, translate
keeps captions running, and nobody else needs to. When nothing is demand any more the agent waits `TT_IDLE_GRACE_S`
(default 10 s) before it pauses, so a page reload does not reopen the ASR session or lose the translation context.
The relay's own 10 s timeout for a vanished viewer adds to that. When the grace is over the agent finishes the open
slice (at most 4 s more work, no new slice opens) so the archive holds it whole, then idles.

**The demand rule** (design §5.3, `demand.Demand`). moq-relay forwards a FETCH by subscribing upstream for exactly as
long as the FETCH takes: 8 ms for an instant answer, seconds for a back-fill, even for a FETCH it then refuses. So a
subscription alone is not demand. `moq.SlicedOut` hooks aiomoqt's SUBSCRIBE and cancel handlers and its standalone
FETCH handler, and `Demand` judges each subscription (keyed by the relay's request id):

- a SUBSCRIBE within 50 ms of a standalone FETCH of the track (either order) is fetch-induced. It becomes demand when
  it is still open 1 s after the last FETCH of the track completed, or 10 s after it opened, whichever comes first;
- any other SUBSCRIBE becomes demand once it has been open 1 s with no FETCH of the track in flight, begun or ended
  during that second;
- once demand, a subscription stays demand until the relay cancels it (a later FETCH does not take it away); one that
  vanishes from aiomoqt's subscriber set without a cancel (its relay session died) is dropped too.

A real viewer waits that second for the first new output; the track's current state reaches it at once. Joining
FETCHes are not counted: they come with a subscription that is demand anyway. The plain `TT_WAKE_DEBOUNCE_S` is gone.

**Joining mid-slice.** Translation and chapters read captions with SUBSCRIBE plus a Joining FETCH relative 0
(`moq.Relay.joined`): the current captions slice from object 0, then the live objects, each once. So a translation
switched on mid-slice translates that slice from its start. A refused join (a captions track with nothing yet) leaves
the live objects alone. Captions cannot hear the past, so the first carry-in of a run started mid-slice says where
it started (`tt.from`).

Viewers must cancel the subscription when a track is switched off (above). The demo recorder (`record`,
`generate`) and the `watch` stand-in subscribe to every agent track they are given, so they keep those agents
working, as a demo generation needs.

## Which rooms

`--room R` (or `TT_ROOM`) serves one room, as before. `--rooms '*'` (or `TT_ROOMS`) serves every room whose speaker
comes on air (`talk/<room>/teacher` announced); `--rooms a,b` only those. `TT_ROOMS_EXCLUDE` lists rooms never served:
on the VM, the demo room, whose tracks the looper replays. Each room gets its own relay connection and agent
instance. A room is served for `TT_ROOM_LINGER_S` (default 600 s) after its speaker leaves, so a reload keeps the
agent and its history; a room that fails stops the process, and Docker restarts it with every room.

The agent token must let the agents publish under every room they serve (see [tokens](tokens.md)).

## Spend caps

Every line in the spend ledger names its room (and its judge batch). Before each call the ledger refuses it when the
worst case would pass the overall ceiling (`TT_SPEND_CEILING_USD`), the room's cap, or its batch's total cap:

- any room: `TT_ROOM_CAP_USD` (default $2);
- a judge room: the cap its batch was minted with, from `$TT_CAPS_DIR/<batch>.json` (default `data/caps`, on the VM
  `/data/caps`), plus the batch's total over all its rooms ([tokens](tokens.md#judge-tokens)).

At a cap the agent stops paying: captions close the ASR session, and the others stop calling the model. While
subscribed, each slice it publishes is a carry-in marked `capped` and nothing else, so a viewer sees why the track is
silent. A FETCH that would need a back-fill past the cap is refused (below).

Try it locally with fake agents: `TT_FAKE_USD_PER_CALL=0.25` makes the fake model spend pretend money into
`TT_FAKE_LEDGER` (default `data/fake-ledger.jsonl`, never the real ledger), so a $2 room stops after eight calls.

## Slices, FETCH and back-fill (decision 0012)

A sliced track cuts its groups on room time: group k covers room time [k·4 s, (k+1)·4 s). The open slice is the
input watermark: the newest teacher media the agent has processed. While idle it is ⌊edge/4000⌋, where the edge is
the room time of the newest teacher media seen (`moq.TeacherFeed` keeps reading the teacher's audio timestamps for
that), never the agent's own wall clock. The code is `live_slices.py` (`SlicedTrack`, `SnapshotTrack`) and
`moq.SlicedOut`.

**Wire format** (design §4.2, `contracts.py`, `records.py`). Each object is a JSON array of MSF event-timeline
records `{"m": <room ms>, "data": {...}}`:

- captions and translations: WebVTT-MSF cues `{start, end, id, text}` plus `rev` (the revision) and `final`, with
  `m` equal to `start`. Interim revisions are records too; a cue's final keeps its id. A translation cue has its
  source cue's id, start and end;
- slides: `{id, at, text}`, `m` equal to `at`;
- the outline (a snapshot track): chapters at their start, then terms and the recap at the watermark.

Object 0 of a slice is the carry-in: an optional note `{"m": k·4000, "data": {"tt": {"capped"?, "from"?}}}` first,
then the last two final cues (or the slide on screen). Then one object per change, then End of Group; End of Track
only when the room service closes the room. Every object goes to the track archive (`TT_ARCHIVE_DIR`,
wiki/howto/archive.md) byte for byte as it goes live, write-once per slice.

**Cue splitting** (`cores/captions.py`). A recogniser's turn can run for a minute; a cue is at most about 7 s and
two lines of 42 characters. The splitter cuts at a sentence end first, else at the last clause end that fits, else
at the last word that fits, and times each cut from when its words were heard (partials) or by character position
within the final. Interim cues keep their id with `rev` rising; the final reuses it. Ids are decimal and rise with
time, so they carry on over a pause, a restart and a back-fill.

- **FETCH of a past slice.** The relay keeps about 30 s; for older slices it forwards the FETCH to the agent, which
  answers from its archive (disk, then `TT_ARCHIVE_BUCKET`) with the true End Location (last object + 1). The open
  slice is answered with the objects it has so far. Before each standalone FETCH the agent moves the track's Largest
  Location up to object 0 of the slice before the open one, so a FETCH of a slice it never published while idle is in
  range (D18 §10.12.3). Not the open slice itself: aiomoqt starts a Largest Object subscription after Largest, and
  the open slice's carry-in is its object 0.
- **Back-fill, translation only** (the owner's call). A FETCH of a translation slice nobody watched is produced in
  the FETCH handler, never in the live loop, when all hold: the slice is below the open one, the captions slice
  exists (fetched through the relay, so its cache or the captions agent's archive answers), back-fill budget is left
  (25 % of the room's cap, `SpendLedger.for_backfill`), and the room is not a demo room (`TT_DEMO_ROOMS`). One runs at
  a time per agent with at most 2 waiting; a fourth gets REQUEST_ERROR "busy". The slice is stored with a conditional
  create: a copy another process stored first is served instead. Captions, slide descriptions and the outline never
  back-fill.
- **Refusals.** Anything else is a REQUEST_ERROR whose reason says why: room time not known yet, the open slice or
  later, does not back-fill, spend cap, busy, no captions. Never an empty or placeholder group.
- **Restart and handover.** A restarted agent announces the same name, seeds its state from its newest archived
  slices and continues at the next slice; a group in the archive is never written live again. `docker stop` (SIGTERM)
  stops the work first, closes the open slice and the MoQ session (`stop_grace_period: 15s`), so a replacement
  started beside it takes over at once. Agents advertise a 3 s QUIC idle timeout and a 1 s keep-alive, so a killed
  agent frees its track in 1-3.5 s instead of 12.4 s (design lane, spike S8).

**State for the room service.** Each agent reports its track through `TrackArchive.report` (its `track.json`):
`status` (idle, live or capped), `producing`, `fetches_served`, `backfills` and `spend_usd`, on every change and at
least every 5 s; the room service treats an entry older than 15 s as idle. The counters come from one function
(`cli.serve_room`, `state`). `spend_usd` is this process's model spend for the track; it starts at 0 after a restart.

**Model calls** (`llm/meta.py`). Reasoning tokens count toward a call's output cap. Describe gets 2500 tokens and
chapters 6000; a call cut at its cap is paid for, logged, and retried once with 8000 or 16000. Every call reserves its
worst case in the ledger before it runs and settles to its real cost after, and logs its tokens and cost.

## Room time (design §4.5)

Every slice number, `m` and cue time is room time:

    room_ms = 1577836800000 + 1000·clock.wall/clock.timescale + pts_ms − E + shift

`clock` is the root of the teacher's hang catalog (`talk/<room>/teacher` track `catalog.json`): the wall time of PTS
zero, in `timescale` units (default µs) since the moq epoch 2020-01-01. `E` and the broadcast's `shift` (ms, a whole
number of slices, keyed by `clock.wall`) come from the room catalog on `talk/<room>/catalog`, published by the room
service. Agents stamp nothing until the room catalog gives `E` and the broadcast's shift (`roomtime.RoomTime`). Each
teacher broadcast (a reload) comes on a new audio subscription and its clock is read afresh. Slide frames carry the
browser's Unix wall ms and are mapped the same way. A broadcast without a `clock` is not stamped.

The dev `catalog` command stands in for the room service: `E` from the first teacher wall time, rounded down to a
slice, and shift 0 for every broadcast. No skew guard.

## Check it locally

`deploy/compose.local.yml` runs the agents for `TT_ROOM`; with `TT_ROOMS='*'` set on the agents, they follow every
room instead. Agents stamp nothing until a room catalog gives `E`: run the dev `catalog` stand-in (`teacher catalog
--insecure`) instead of the `archive` service, whose catalog is not yet in this format (below). `watch --watch
captions,translate-tr` subscribes to the agents named.

    docker compose -f deploy/compose.local.yml up -d relay captions translate-tr describe chapters
    docker compose -f deploy/compose.local.yml --profile dev run -d teacher
    docker compose -f deploy/compose.local.yml --profile dev run -d teacher catalog --insecure
    docker compose -f deploy/compose.local.yml --profile dev run --rm watch

Checked on 2026-10-28 against moq-relay 0.17.8, every agent `--fake`, the dev `teacher` and `catalog` on air:

| Check | Result |
|---|---|
| On air, nobody subscribed | every agent idle, no slices, `track.json` `idle` with a fresh `updated_ms` |
| `watch` of all four | woke about 1 s after it subscribed; captions' first carry-in `from` the start of the run; cues in room time, interim revisions then the final under the same id; each translation cue with its source's id, start and end |
| `watch` stopped | describe and chapters idle 10 s later, translate a few seconds after, captions once both had left |
| Woken again after an idle spell | cues carry on in room time (found here: the fake ASR made its whole two-hour script final on a pause; fixed) |
| Captions SIGKILLed mid-slice, then started | slice 21 stays `.part`; the new process continues at slice 22 with a carry-in from the archive; the viewer resubscribed about 5 s after the kill |
| Translation joined while captions were live | the Joining FETCH returned the 11 objects of the open captions slice; it was translated from the slice's start |
| FETCH of translation slices 17, 18 and 21, never produced | back-filled from the captions slices fetched through the relay: about 150 ms each; `backfills` 3 |
| The same FETCH again | 20 ms, from the relay's cache; no new work |
| FETCH of slice 12, produced live, and of captions slice 25 | from the archive in 20-30 ms |
| FETCH of slice 200 | REQUEST_ERROR "the open slice or later" |

Slice 21 of captions was cut by the kill, and its translation was back-filled from what the relay held of it. That
is as complete as captions slice 21 will ever be: it is never written again.
