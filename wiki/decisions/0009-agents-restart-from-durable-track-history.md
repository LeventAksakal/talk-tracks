---
status: accepted
date: 2026-10-28
decision-makers: project owner
---

# A restarted agent picks up its state from the room's track history, which outlives the VM

## Context and Problem Statement

A caption agent can be killed or its server can go down mid-talk. Viewers follow the newest agent instance. A new
subscription starts at the newest group, so audio spoken during a restart is not replayed
([ticket 0005](../../tickets/0005-captions-failover.md)).

## Considered Options

* Hot standby: two caption agents run all the time
* Seed and continue: the replacement takes the last state and carries on from live audio
* Seed and back-fill: as above, plus re-transcribing the missed audio on a second path

## Decision Outcome

Chosen: seed and continue, with the state coming from durable track history.

* Losing the 1–3 s of output while an agent restarts is within tolerance; there is no hot standby.
* The agent's state is the tracks it published. A new instance seeds itself from the last snapshot of its own track,
  and continues ids and content.
* That history must outlive the agent and the VM. It is cached so that late joiners and rewinds are served without
  any API use, and it is backed up off the VM.

How the history is stored and served is open: [ticket 0015](../../tickets/0015-track-history-store.md).

### Consequences

* Good, because one agent per track keeps the API cost flat.
* Good, because "no state lost" holds even when the VM goes down, once the history store exists.
* Bad, because "no lines lost" does not hold: speech during a restart is missing from the captions.
* Bad, because a history store is a new component. Captions today restore from a file on the VM's own disk, which is
  lost with the VM.
