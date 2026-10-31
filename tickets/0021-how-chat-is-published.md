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

### Owner's notes, 2026-10-31 (for the coordinator to discuss; not an answer)

- "Relays are not our business logic servers. by the Spec they should interop and say we should be able to use
  cisco's cloudflare's akamai's relays on global scale". Authentication and other business logic go over a regular
  server.
- "we can build the chat in websockets sure; but built in MOQT as tracks gives you replayability a native smooth
  transport; less handrolled logic."
- "by design every user should have their own chat track and everyone should subscribe to everyone else.
  Contectually a chat is a shared state with many writers. MOQT tracks doesnt natively support that. so maybe not
  overdeliver on the pitch? Or a n elegant workaround".

Ideas from the design session, unverified against our relay:

- **One track per writer, found by namespace.** Each listener publishes `talk/R/chat/<id>`; viewers subscribe to the
  `talk/R/chat/` namespace (SUBSCRIBE_NAMESPACE, called SUBSCRIBE_ANNOUNCES in older drafts) so new writers appear
  without a server in the path, and the client merges messages by timestamp. Replay fetches every writer's track, so
  its cost grows with the number of writers. Needs a publish token per listener and a relay that supports namespace
  subscriptions.
- **Removing a message without rewriting the past:** a moderator publishes a small "hidden" track listing message ids;
  clients apply it. Moderation stays out of scope for the demo.
- **Pitch:** say "chat is many writers, each on their own track", not "one shared chat track", so the claim matches
  what MoQT does natively.

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
