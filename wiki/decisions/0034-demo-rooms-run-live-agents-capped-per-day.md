---
status: accepted
date: 2026-11-02
decision-makers: project owner, coordinator
---

# Demo rooms run live agents from Tue evening, capped at $5 per room per day

## Context and Problem Statement

Decision 0032 puts a demo live session's AI tracks behind one switch (`TT_DEMO_LIVE_AGENTS`). The demo-sessions lane
estimated about $0.75 per watched session, up to about $2.50 per room-hour, and noted that the default $2 room cap is
cumulative, so a demo room would stop after 2–3 watched sessions. Asked through the question prompt on 2026-11-02.

## Decision Outcome

* The switch goes on **Tue 2026-11-03 evening**, before the owner's recorded lecture, and stays on through judging.
* Each demo room may spend **$5 per day** (at most $20 a day for four rooms), inside the $100 ceiling.
* The recording rooms (`<id>-recording`) are served with a new read token (`TT_RECORDINGS_TOKEN`), minted by the
  coordinator and written to the VM's settings at deploy, never printed. The owner approved this.
