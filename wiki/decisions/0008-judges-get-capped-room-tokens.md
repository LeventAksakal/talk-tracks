---
status: accepted
date: 2026-10-28
decision-makers: project owner
---

# Judges go live with pre-minted room tokens that carry their own spend cap

## Context and Problem Statement

A live room runs real agents, which spend the Meta credit. Judges are anonymous until they open the demo, and the
credit must never pass the ceiling ([ticket 0003](../../tickets/0003-live-mode-for-judges.md)).

## Considered Options

* Tokens listed in the submission notes, one room each, with an expiry and a spend cap
* A "start a live room" button behind one shared passphrase
* No live rooms for judges

## Decision Outcome

Chosen: pre-minted tokens. Each token is signed for one room, expires after the judging window and has its own spend
cap, $2 per room by default. All judge rooms together have a total cap that is set when the tokens are minted and is
well under the ceiling.

### Consequences

* Good, because nothing new is exposed to the public: no minting endpoint, and no shared secret that could leak.
* Good, because the worst case is known in advance: the number of tokens times the per-room cap.
* Bad, because the per-room and total caps need building. Today only the shared $100 ledger limits spend.
* Bad, because live agents must be started for each judge room, or follow rooms as speakers appear.
