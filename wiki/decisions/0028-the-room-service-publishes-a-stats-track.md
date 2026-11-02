---
status: accepted
date: 2026-11-02
decision-makers: project owner, coordinator
---

# The room service publishes a stats track

## Context and Problem Statement

Asked in [ticket 0022](../../tickets/0022-who-publishes-subscriber-counts.md), which lists the options and their trade-offs.

## Decision Outcome

Chosen: the ticket's recommended option (owner, 2026-11-02, through the question prompt). The room service publishes `talk/<room>/stats` every 5 s: every track in the room's namespace, its subscriber count, and whether it is running or on demand, fed by the relay's stats feed and its own WebSocket sessions. Stats for nerds reads it; the warm-subscribe rule uses its running list.

### Consequences

Good: everything stays a track, the relay stays replaceable. Bad: one more publisher, and another relay needs its own stats adapter.
