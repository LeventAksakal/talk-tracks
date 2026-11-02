---
status: accepted
date: 2026-11-02
decision-makers: project owner, coordinator
---

# Chat is one room track published by the room service

## Context and Problem Statement

Asked in [ticket 0021](../../tickets/0021-how-chat-is-published.md), which lists the options and their trade-offs.

## Decision Outcome

Chosen: the ticket's recommended option (owner, 2026-11-02, through the question prompt). Listeners send chat messages over the listener WebSocket (decision 0024); the room service stamps each on the room clock and appends it to `talk/<room>/chat`. Opening the chat drawer subscribes; replay is a FETCH of that one track.

### Consequences

Good: no publish tokens for listeners, one ordering, one place for rate limits, replay is one FETCH. Bad: the room service is in the write path, and MoQ fan-in (a track per listener) is not shown off.
