---
status: accepted
date: 2026-10-31
decision-makers: project owner, coordinator
refines: 0005 (publishing needs a signed token), 0008 (judges get capped room tokens)
---

# Presenters create a room with an access code

## Context and Problem Statement

A speaker needs a signed publishing token (decision [0005](0005-publishing-needs-a-signed-token.md)). Today the
token is minted on the VM by script, so there is no "create a talk" journey (J5 in
[product/journeys.md](../product/journeys.md)). How does a presenter get a room and a speaker link from the site?

## Considered Options

* **A. Create room with an access code.** A lobby form asks for room name, talk title, speaker name and a code; the
  room service checks the code and mints a capped speaker token for `talk/<room>/**`.
* **B. Open self-serve** with a small per-room cap and a per-IP rate limit.
* **C. Keep minted links**; the lobby offers "Paste your speaker link".

## Decision Outcome

Chosen: **A** (owner, 2026-10-31 question prompt). It gives a real J5 without opening spend to anyone with the URL.
Judges get a code in the submission text; each code carries a room cap under the $100 ceiling, as in decision
[0008](0008-judges-get-capped-room-tokens.md). The "Paste your speaker link" box stays as the fallback (cut order 5).

### Consequences

* Good: the presenter journey works from the site; the spend cap stays enforced server-side.
* Bad: the room service gains an HTTP endpoint and signing key access; codes are secrets kept on the VM only, never
  in the repo.
