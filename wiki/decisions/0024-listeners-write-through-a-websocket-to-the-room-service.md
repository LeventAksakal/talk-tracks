---
status: proposed
date: 2026-10-30
decision-makers: coordinator, project owner
refines: 0005 (listeners never publish to the relay), 0021 (the deck's annotations are shared state), 0022 (the room service publishes its own tracks)
---

# Listeners write through a WebSocket to the room service

## Context and Problem Statement

Listeners draw, mark text and comment on the deck (decision [0021](0021-deck-annotations-are-shared-state-on-event-tracks.md)),
but never hold publish rights on the relay (decision [0005](0005-publishing-needs-a-signed-token.md)). The room
service publishes their work on `talk/<room>/annotations` (`ink`, `marks`) and `talk/<room>/comments` as tracks it owns
(decision [0022](0022-the-room-service-serves-the-speakers-track-history.md)). How do their writes reach it?

The writes are small but frequent while drawing (a points batch about every 50 ms, in order after its `begin`), the
room service must know who wrote each one (to stamp `by` and to apply `may_change`), it must rate-limit them, and
there is no account. The Discussion tab and the speaker's question list need every thread of the talk, which on the
comments track would be one FETCH per 4 s slice.

## Considered Options

* **A. One WebSocket per listener, served by the room service** on `/api/rooms/<room>`, proxied by Caddy.
* **B. HTTP POST per write** to a small HTTP server in the room service.
* **C. A token per listener** that lets them publish their own track on the relay (one track per user).

## Decision Outcome

Chosen: **A**, in the room service process (`python -m talk_tracks.archive --listen 0.0.0.0:8091`), because it is
the only writer of those tracks and already holds their archive.

* **Protocol.** JSON messages: `hello` (display name, the id and key the service gave this browser before, or the
  speaker's relay token), then `write` (`track`: ink, marks or comments; `data`: the contract's record data without
  `by`), each answered by `ack` (room time `m`, a new comment's id) or `error` (`invalid`, `forbidden`, `not-live`,
  `limit`, `rate`, `name`). With `comments: true` the session gets the room's threads (`comment_threads`, so hidden
  ones are left out) and then every new comments record. Module docstring: `agents/src/talk_tracks/archive/listeners.py`.
* **Identity, no account.** The service gives a listener an id (`u…`) and a key, an HMAC of the id under its secret.
  The browser keeps both, so its strokes stay its own across reloads; a guessed key gets a fresh id. Stroke and mark
  ids must start with `<id>:`; comment ids are given by the service.
* **The speaker** proves their session with the relay token the console already has: ES256, checked against the
  room key's `public.jwk` (`TT_SPEAKER_KEY`), allowed to publish `talk/<room>/slides`, unexpired. Their writes carry
  `by.speaker`: reply, hide any comment, erase or unmark any audience annotation. Without a key the service accepts
  no speaker session (`TT_OPEN_SPEAKER=1` accepts any token, for development only).
* **Validation and stamping.** Every write becomes a contract record (`InkRecord`, `MarkRecord`, `CommentRecord`) with
  `by` from the session and `m` = the room time now (the newest teacher media time plus the time since it arrived,
  so it is on the speaker's clock). Points and end only for one's own stroke being drawn; erase, unmark, clear and
  hide only what `may_change` allows; an edit only by its author. A refused write publishes nothing.
* **Re-send.** When the speaker's mirrored `slide` track shows a slide, the service re-sends that slide's audience
  strokes, marks and threads at that moment (container-formats.md).
* **Limits.** A token bucket per session and track (ink 30/s burst 60, marks 5/s burst 10, comments one per 2 s
  burst 5; the speaker double), 20 sessions per address, 32 KiB per message, 5 000 points per stroke, 4 strokes
  drawn at once.
* **Deploy.** Caddy proxies `/api/*` to `archive:8091` (a path matcher, so it wins over the relay's WebSocket
  fallback); `TT_LISTENER_ORIGINS` is the site's origin and `TT_PROXIED=1` takes the client address from
  `X-Forwarded-For`. The listener-id secret lives beside the archive folder, never in the folder Caddy serves.
* **Comments made while watching a replay** go out now (`m` = now) with `at` = the playhead's room time, anchored on
  the slide the viewer sees (ui-design §12.7, first option). The archive stays append-only, the speaker sees them at
  once, and a later replay shows them in the Discussion tab when its playhead reaches `at`. Drawing and text marks
  need the live slide: the player offers them only at the live edge.

### Consequences

* Good, because nothing new is installed: `websockets` is already a dependency and Caddy proxies upgrades.
* Good, because one connection carries a stroke's points in order, and the session is the identity for `by`, the
  rate limit and the pushes to the Discussion tab and the console.
* Good, because the tracks stay the record: every write is an object on a live, archived, fetchable track, read by
  the player like every other track; the socket only carries writes and an index of threads.
* Bad, because listener writes pass through one Python process per VM. Fine for a class or a judged demo; a large
  audience would need the endpoint split out.
* Bad, because looped demo rooms have no room service (their looper publishes everything), so listeners cannot
  annotate there.
* Bad, because a listener sees their work after one round trip; the player draws their own stroke locally until it
  comes back on the track.

### Why not the others

* **B** needs an HTTP server library the agents do not have (`websockets` serves only GET upgrades), sends a request
  per points batch with no order between them, and still needs a push channel for the Discussion tab.
* **C** contradicts decision 0005 and ticket 0020's default (one shared track per kind): the player would discover a
  growing set of tracks, and the relay would hold one per listener.
