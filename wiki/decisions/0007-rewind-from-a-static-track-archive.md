---
status: accepted
date: 2026-10-28
decision-makers: project owner
---

# Viewers rewind from a static archive of the room's tracks; the relay stays live-only

## Context and Problem Statement

A looped or live room must let any viewer rewind, including to before they joined (decision 0006). moq-relay 0.17.8
starts a subscriber at the newest group, serves FETCH only while the publisher is live and keeps non-latest groups
for about 30 s ([ticket 0002](../../tickets/0002-rewind-and-loop.md)).

## Considered Options

* The browser keeps what it has seen and rewinds locally
* Rewind to any point from a static recording of the room, served over HTTP
* A replay broadcast per seeking viewer

## Decision Outcome

Chosen: a static recording. The room's media and agent snapshots are written as static files (media segments plus
the snapshot timeline). The viewer seeks in those files and returns to the relay's live feed with "Go live".

### Consequences

* Good, because every viewer gets full rewind at no API cost, and the relay only does live fan-out.
* Good, because the same archive can restore agent state and survive the VM (decision 0009, ticket 0015).
* Bad, because the viewer code handles two sources, a live one and an archived one, and must line them up on one
  clock.
