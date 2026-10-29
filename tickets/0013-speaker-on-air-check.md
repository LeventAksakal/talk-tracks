---
status: closed
created: 2026-10-27
tags: [web, speaker, relay]
---

# How does the speaker console prove it is on air, and what does an occupied room do?

## Question
How should the speaker console confirm that its broadcast reaches viewers, and what happens when another speaker is
already publishing in the room?

## Context
A refused browser publish is silent (`@moq/publish` reports nothing). Today the console says **On air** only when a
second, anonymous connection receives this page's own audio frames back, matched by their timestamps (within 5 s).
If another page already publishes `talk/<room>/teacher`, the console reports it and, after 10 s, says another speaker
is on air. Two pages opened within 5 s of each other could be confused. Signed tokens (decision 0005) limit who can
publish at all.

## Options
- **A. Keep the own-audio check.** Works with today's relay and agents, no contract change; a small chance of a
  mix-up when two speakers start together.
- **B. A path per speaker session** (`talk/<room>/teacher/<id>`). Unambiguous; agents and viewers follow the newest
  speaker as they already do for agent instances, which changes the contract and every lane.
- **C. Refuse to go on air while the room is occupied.** Simplest for users; a crashed tab blocks the room until its
  broadcast expires.

## Recommendation
A for the hackathon: no contract change before the deadline. B is the clean long-term answer.

## Answer
A: keep the own-audio loopback check with no wire-contract change (2026-10-29). Signed room tokens
([decision 0008](../wiki/decisions/0008-judges-get-capped-room-tokens.md)) give each judge/speaker a dedicated room,
and the teacher hang catalog's `clock.wall` disambiguates broadcast sessions.

