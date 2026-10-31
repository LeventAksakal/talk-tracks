---
status: open
created: 2026-10-31
tags: [stats, tracks, relay, architecture]
---

# Who publishes subscriber counts for Stats for nerds?

## Question

The owner wants Stats for nerds to list "every track under the namespace and subscriber counts" and asked whether
MoQT provides them or "a dedicated stats aggregator server publishes those stats as a seperate stats track (i.e
everything as a tracks xD)". Where do the counts come from?

## Context

- MoQT has no subscriber counts. TRACK_STATUS returns what SUBSCRIBE_OK would (largest object, expiry, track
  properties), draft-22 §9.13. Our relay, moq-relay 0.17.8, refuses TRACK_STATUS anyway. With aggregation a publisher
  sees one subscription per relay, so it cannot count viewers either.
- moq-relay 0.17.8 can publish its own stats as a MoQ broadcast at `.stats/node/<node>` (source,
  `rs/moq-relay/src/stats.rs`). It is off unless `MOQ_STATS_ENABLED` is set and counts subscriptions per broadcast,
  not per track. Agents count as subscribers. Nobody has run it here.
- The same counts would let the player warm only languages that already have a worker running, so opening the
  subtitles menu never wakes a translator (`wiki/product/brand.md` §6, "No switches").
- The relay must stay interchangeable with Cloudflare's, Akamai's or Cisco's (owner, 10-31), so business logic stays
  off the relay.
- Design: the "Stats for nerds" overlay on the Reference Canvas (board "Panels, transcript and stats for nerds").
  The brief behind this is in the design session's shared notes, `moqt-brief-2026-10-31.md`.

## Options

1. **The room service publishes `talk/<room>/stats`**, fed by the relay's stats broadcast and its own WebSocket
   sessions, one object every 5 s: track names, subscriber counts, running or on demand. Survives a relay swap
   (another relay needs its own feed adapter). Cost: one more publisher in the room service, enabling relay stats.
2. **Players read `.stats/node/<node>` directly.** No new service code. Ties the player to moq-relay's format, counts
   only per broadcast, and breaks on any other relay.
3. **No counts; the overlay shows only the viewer's own tracks.** Nothing to build. Drops what the owner called
   "a must have".

## Recommendation

Option 1: it matches "everything as a track", keeps the relay replaceable, and also feeds the warm-subscribe rule.

## Answer

