---
status: open
created: 2026-10-27
tags: [docs, decisions]
---

# Do the ADRs restate the decisions made before the build?

## Question
Some decisions were made before the hackathon's build period, in your private notes: moq-relay as the relay, rewriting
everything from scratch for this repo, the track scope, the spend ceiling. Should the repo's ADRs record them?

## Context
The repo's ADRs start at 0001 (2026-10-27). Without the earlier ones a reader can't see why moq-relay or why the
rewrite. Restated records would carry no private detail (no addresses, accounts, spend history).

## Options
- **A. Restate them as short ADRs** dated today, each saying it was decided before the build.
- **B. Forward only.** Less writing; the reasons stay in the private notes.

## Recommendation
A, kept to a few lines each.

## Answer

