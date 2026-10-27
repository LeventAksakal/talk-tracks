---
status: open
created: 2026-10-27
tags: [spend]
---

# Is the Meta spend ceiling still $100?

## Question
The shared spend ledger refuses any Meta API call whose worst case would pass the ceiling. Keep it at $100 of the
$150 credit?

## Context
Spent so far: under $0.05. Looped demo rooms make the public demo a one-time cost (decision 0006); live judge rooms
spend per use (ticket 0003). The agent CLI (not written yet) will read the key from the environment as `META_API_KEY` or `MODEL_API_KEY`.

## Options
- **A. $100** ($50 buffer).
- **B. $75.**
- **C. $50.**

## Recommendation
A: ample at measured costs, and the ledger stops hard either way.

## Answer

