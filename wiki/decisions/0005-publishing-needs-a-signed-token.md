---
status: accepted
date: 2026-10-27
decision-makers: project owner
---

# Publishing into a room needs a signed token; watching is open

## Context and Problem Statement

The relay was fully anonymous before the build. Agents call the Meta API on whatever a room's speaker sends, so open
publishing would let anyone spend the API credit. Judges should still be able to run a live talk of their own.

## Considered Options

* Anyone may publish (as before)
* A signed token per room, checked by the relay; viewers anonymous
* A separate auth service consulted by the relay (`--auth-url`)

## Decision Outcome

Chosen option: "a signed token per room", because it closes the API spend to strangers with no extra service, while a
judge given a token can still run a live room. Watching, joining late and choosing tracks stay open to anyone.

### Consequences

* Good, because publishing is never open to the public.
* Bad, because a refused browser publish is silent (measured before the build), so the speaker console must confirm
  that its publish reached the relay.
* Open: how judges get a token and what each token may spend (ticket "Live mode for judges").
