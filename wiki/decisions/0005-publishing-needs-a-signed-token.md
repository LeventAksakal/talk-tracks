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

## Addendum, 2026-10-27: the relay needs an auth server to check tokens

Found while building: moq-relay 0.17.8 has no token check of its own. It either applies `--auth-public` rules to every
session or asks a server at `--auth-url`, never both. Signed tokens therefore need the third option above, a small
auth server. It is the moq project's own reference server, `moq auth serve` (moq-cli 0.14.8, the release paired with
the relay), not code of ours:

* It verifies ES256 tokens against a public key; the private key that signs them stays off the repo.
* `--public-subscribe 'talk/**'` keeps watching open to anyone without a token.
* It runs beside the relay in the relay's network namespace (the relay speaks plain HTTP only to a loopback auth URL).

Token scopes: a speaker token may publish `talk/<room>/teacher` and `talk/<room>/slides`; an agent token may publish
`talk/<room>/agents/**`; both may subscribe to `talk/<room>/**`. How to sign them: `wiki/howto/tokens.md`.

The decision itself stands (signed token to publish, open to watch); only "no extra service" no longer holds.
