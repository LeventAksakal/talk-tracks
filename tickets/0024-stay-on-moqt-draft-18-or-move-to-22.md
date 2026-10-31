---
status: open
created: 2026-10-31
tags: [moqt, agents, relay, architecture]
---

# Stay on MoQT draft-18 for the hackathon, or move the agents to draft-22?

## Question

Our Python agents (aiomoqt) speak IETF draft-18. The latest draft is draft-ietf-moq-transport-22 (1 October 2026).
Do we move before the 4 November deadline?

## Context

- What changes for us (design session's MoQT brief, `moqt-brief-2026-10-31.md` in its shared notes):
  - Joining FETCH is gone; a SUBSCRIBE with FILL_PARAMETERS delivers the back-fill (draft-22 A.3, §3.4).
  - FETCH_OK End Location is now inclusive (draft-22 §9.12); our archive answers in the draft-18 "last object + 1"
    form, so it must change.
  - FETCH ranges move into a LOCATION_FILTER (draft-22 §9.20.9).
- moq-relay 0.17.8 offers draft-14 to draft-22 (read in source, not tested). aiomoqt 0.14.0rc1, released 10-31,
  claims draft-20 and draft-22 (only its PyPI description read).
- moq-relay 0.17.10 is out; we run 0.17.8.
- Doc inconsistency found on the way: `wiki/benchmark.md` cites moq-lite-05, the design doc says the browser speaks
  moq-lite-06 (latest moq-lite draft: -06, 24 September 2026).

## Options

1. **Stay on draft-18 until after the hackathon.** Measured and working; no risk this week. The pitch says
   "draft-18", not the latest.
2. **Move now.** Pitch on the current draft. Cost: the archive's FETCH answers, Joining FETCH callers, a release
   candidate library, and re-running the benchmark, four days before the deadline.
3. **Spike in a branch, decide by 11-02.** One lane tries aiomoqt 0.14.0rc1 against the relay; switch only if the
   benchmark passes unchanged.

## Recommendation

Option 1. Write the draft-22 changes into the backlog, and fix the moq-lite version mismatch in the docs now.

## Answer

