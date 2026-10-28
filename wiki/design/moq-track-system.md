---
status: proposed
date: 2026-10-28
---

# System design: everything is a MoQ track

The owner's direction (2026-10-28): exploit the nature of MoQT instead of hand-rolling features beside it, so the
build shows what MoQT does and how well it combines with AI APIs. This page proposes that design. Once agreed, it
becomes a decision record and supersedes the HTTP rewind of decision 0007.

## Principles

1. **Everything is a track:** speaker media, slides, every AI output, the room's catalog, and history.
2. **Demand is a subscription.** Nothing is produced unless someone subscribes. The relay aggregates demand, so a
   thousand viewers of the Turkish track are one upstream subscription, and one paid translation.
3. **The relay is the cache, and the track store is its durable tier.** Recording never creates demand. It keeps
   what demand produced.
4. **History is more tracks.** Rewind, catch-up, agent restore and back-fill all read history through ordinary
   subscriptions, cached by the relay and shared by everyone reading the same stretch.

## Topology

```
 speaker browser ──publish──▶ talk/R/teacher, talk/R/slides ─────────────────────┐
                                                                                  ▼
 agents ──publish──▶ origin/R/agents/<agent>   (private)               ┌──────────────────┐
   ▲  subscribe on demand                                              │  moq-relay       │◀── viewers
   │                                                                   │  fan-out, cache, │    subscribe only
 ┌─┴──────────────────────────────────────┐   announces talk/R/agents/** │  auth            │    what they opted
 │ track store (aiomoqt, on the VM)        │──announces talk/R/history/**▶│                  │    into
 │ - write-through pass-through of agents  │──publishes talk/R/catalog ──▶│                  │
 │ - records teacher media (free)          │                             └──────────────────┘
 │ - serves history tracks from disk       │
 │ - copies segments to the bucket (0011)  │
 └─────────────────────────────────────────┘
```

All connections are MoQ sessions to the one relay. The store is a client that both subscribes and publishes, so no
second relay and no server role in aiomoqt are needed.

## Namespaces

| Name | Publisher | Who may subscribe | Holds |
|---|---|---|---|
| `talk/R/teacher`, `talk/R/slides` | speaker | anyone | live audio and video, slide frames |
| `origin/R/agents/<agent>` | each agent | the store only (token scope) | the agent's raw output |
| `talk/R/agents/<agent>` | store (pass-through) | anyone | the same objects, recorded as they pass |
| `talk/R/history/<track>/<bucket>` | store | anyone | one time bucket of a track (for example 6 s of media, or one minute of snapshots) as a single group |
| `talk/R/catalog` | store | anyone | the room's tracks: kind, language, live or idle, history range, cost class |

Viewers keep anonymous read on `talk/**`. `origin/**` is outside it, so viewers cannot wake an agent except through
the store.

## Flows

**Watching.** The viewer subscribes to `talk/R/catalog` and builds the tracks panel from it, then subscribes to the
teacher's media and only the tracks the viewer switched on (decision 0010). A late joiner gets the newest group of
each track from the relay's cache. Snapshots are self-contained, so nothing else is needed.

**Waking an agent.** A viewer switches on Turkish:

1. The relay has no upstream for `talk/R/agents/translate-tr`, so it subscribes to the store.
2. The store subscribes to `origin/R/agents/translate-tr`.
3. The translation agent wakes, and subscribes to captions through the store the same way, which wakes captions.
4. Objects flow back down the chain, and the store writes each one to disk on the way.

The chain of demand is MoQ's own subscription chain. No side channel is involved.

**Going idle.** The last viewer of Turkish leaves. The relay unsubscribes upstream, the store unsubscribes from
`origin`, and the agent idles. If captions has no other subscriber, it idles too. How fast the relay drops an upstream
subscription is being measured by the Lazy agents lane.

**Rewind.** The viewer seeks to 12:30:

- It subscribes to `talk/R/history/teacher/s000125` (and the next buckets), plus the history bucket of each track it
  has on.
- The store serves them from disk. The relay caches them, so ten students rewinding to the same moment cost one read.
- Media and every track share the speaker's media clock, so the slide, captions and translation line up at the
  rewound point.
- "Go live" unsubscribes from history and resubscribes to the live tracks.

This works with plain SUBSCRIBE, so it does not depend on FETCH, which moq-relay 0.17.8 serves only while the publisher
is live, one group at a time.

**What you missed.** When the viewer returns to live, the chapters agent's history buckets for the skipped stretch
give the recap. No new API call is needed if the chapters track was running; otherwise it is a back-fill.

**Back-fill.** A track switched on mid-talk wakes at that moment. Its agent can read its inputs' history from the
store (captions history is free if captions ran) and fill earlier buckets at a lower MoQ priority than live output.
Back-fill is paid, so it is capped per room by the spend cap and runs only for buckets someone subscribes to.

**Agent restore.** A restarted agent subscribes to the newest history bucket of its own track, seeds from that
snapshot and continues ids (decision 0009). The restore needs no state file and goes through the same path as rewind.

**Durability.** The store writes history to the VM's disk and copies finished buckets to the bucket (decision 0011).
After losing the VM, the store reads history back from the bucket.

**Priorities under congestion.** Publisher priorities, highest first:

1. audio;
2. captions;
3. translation;
4. video;
5. slides and descriptions;
6. chapters;
7. history.

On classroom Wi-Fi, a student keeps the voice and the words first.

## What it shows judges

| MoQT property | Where Talk Tracks uses it |
|---|---|
| Named tracks under namespaces | every AI step is a track a viewer picks |
| Subscription aggregation at the relay | one paid agent, any number of viewers |
| Demand-driven publishing | agents wake on the first subscriber and idle on the last; spend follows real use |
| Relay caching | late join, and shared rewind reads |
| Groups as random-access units | history buckets are seekable by name |
| Priorities | voice and captions survive congestion |
| Relay-mediated composition | agents subscribe to each other (translation reads captions) like viewers do |

## Changes to decisions and lanes

- **Decisions:**
  - 0007, rewind from static HTTP files: superseded. History is served as MoQ tracks, and the files stay as the
    store's storage.
  - 0009, 0010 and 0011: hold.
- **Track archive lane:** it becomes the track store. Keep the disk format and the bucket copy. Add the pass-through,
  the history tracks and the catalog. Drop the always-on agent subscription.
- **Lazy agents lane:** agents publish under `origin/`, wake and idle on subscriptions, restore from history, and
  back-fill at low priority within the cap. Tokens: agents publish `origin/R/agents/**`; the store subscribes
  `origin/**` and publishes `talk/**/agents/**`, `talk/**/history/**` and `talk/**/catalog`.
- **Rewind lane:** the viewer plays history tracks instead of HTTP and MSE files.
- **Benchmark lane:** add the store hop's latency, shared rewind reads (one store read for N viewers) and bytes for
  selective subscription.
- **Demo rooms:** the store serves their history from the recording folder under the same names, so the viewer has
  one code path.

## Verify first (spike, about half a day)

1. **On-the-fly track names.** moq-relay 0.17.8 forwards subscriptions for track names the store decides on the fly
   (`talk/R/history/...`) to the store, and the store, an aiomoqt client, can answer them.
2. **Prompt unsubscribe.** The relay drops the upstream subscription promptly when the last viewer leaves, and the
   store sees it. The Lazy agents lane is already measuring this.
3. **Browser playback.** The browser's moq-lite client can subscribe to history tracks and play the recorded media
   objects.
4. **Hop latency.** The extra hop through the store adds only a few milliseconds.

If (1) or (3) fails, rewind keeps the HTTP files of decision 0007 from the same storage, and everything else holds.

## Risks

- **The store is on the live path for agent tracks.** If it dies, agent tracks stop until Docker restarts it
  (seconds), while speaker media is unaffected. It is a small, restartable process, kept apart from the agents.
- **One more hop for agent tracks.** It is loopback on one VM; the benchmark measures it.
- **Back-fill can spend credit for old buckets.** It is bounded by the per-room cap and runs only on subscription.
