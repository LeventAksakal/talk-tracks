---
status: closed
created: 2026-10-27
tags: [access, judges, spend]
---

# How does a judge get a live room, and what may it spend?

## Question
How does a judge obtain a signed publishing token (decision 0005), and how much Meta credit may one live room use?

## Context
A live room starts real agents, which spend the credit (ceiling enforced by the shared ledger). Judges are anonymous to
us until they open the demo.

## Options
- **A. Codes in the submission notes.** We mint a few room tokens ahead of time and list them for judges; each token
  works for one room, expires after the judging window and has its own spend cap (for example $2).
- **B. A "start a live room" button behind one shared passphrase.** The server mints a token per room on request;
  per-room and total caps apply.
- **C. No live rooms for judges.** They see the looped rooms and the video of a live run.

## Recommendation
A, with a $2 cap per room and a total cap for all judge rooms well under the ceiling.

## Answer
A: capped tokens. Recorded in [decision 0008](../wiki/decisions/0008-judges-get-capped-room-tokens.md).
