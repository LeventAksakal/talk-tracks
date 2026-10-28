---
status: closed
created: 2026-10-27
tags: [demo, rewind, relay]
---

# How do rewind and the loop work over the relay?

## Question
How does a viewer rewind a looping room, and how does the loop restart?

## Context
Measured before the build on moq-relay 0.17.8: a subscriber starts at the newest group; FETCH works one group at a
time and only while the publisher is live; the relay keeps non-latest groups for about 30 s. Republishing a recording
as a new broadcast from a seek point worked. Agent tracks are self-contained snapshots, so any one object is enough to
show a track's full state at that moment. The lecture video is the heavy part.

## Options
- **A. The browser keeps what it has seen; rewind replays locally.** The viewer buffers video and snapshots since it
  joined and seeks within them. No server work; a late joiner can't rewind before they joined.
- **B. Rewind to any point from a static recording.** The looping publisher also writes the recording (video segments
  plus the snapshot timeline) as static files served by Caddy; the viewer seeks in those files and returns to the live
  relay feed with "Go live". Full rewind for everyone; viewer code handles two sources.
- **C. A replay broadcast per seek.** A small service republishes the recording from the seek point as a new
  broadcast for that viewer. Everything stays MoQ; one publisher per rewinding viewer.

## Recommendation
B: it gives full rewind at no API cost and keeps the relay doing what it does well (live fan-out).

## Answer
B. Recorded in [decision 0007](../wiki/decisions/0007-rewind-from-a-static-track-archive.md).
