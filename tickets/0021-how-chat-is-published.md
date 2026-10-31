---
status: open
created: 2026-10-31
tags: [chat, tracks, architecture, design]
---

# How is chat published: one room track, or a track per listener?

## Question

The owner wants a global chat, and it should be a track like everything else: open the chat drawer and you subscribe,
close it and you unsubscribe, and a replay plays chat back in sync. How do messages get onto tracks?

## Context

- Owner, 2026-10-31: "chat is aggregate tracks of individuals or one global track; i.e clients send to chat
  microservice and that publishes chat messages? its an architecture and design decision".
- Listeners already write through a WebSocket to the room service (decision 0024), which publishes the annotation
  tracks (decision 0021, ticket 0020).
- No accounts in the demo; a listener has a random or chosen display name. Moderation (removing messages) is out of
  scope.

## Options

1. **One room chat track, published by the room service.** Clients send each message over the existing WebSocket; the
   service stamps it on the room clock and appends it to `talk/R/chat`. Trade-off: one subscription per viewer and
   one ordering, the same path as annotations, and a natural place for rate limits later. The service is in the
   write path.
2. **A track per listener, aggregated by the client.** Each listener publishes `talk/R/chat/<id>`; viewers subscribe
   to many tracks. Trade-off: shows off MoQ fan-in, but every viewer needs a publish token, discovery of new tracks,
   and merging and ordering in the browser; replay must fetch every track.
3. **Per-listener tracks, merged by a service into one room track.** Trade-off: both stories, twice the work.

## Recommendation

Option 1: it reuses decision 0024's write path, keeps listeners free of publish tokens, and makes chat replay a
plain FETCH of one track.

## Answer

<!-- owner -->
