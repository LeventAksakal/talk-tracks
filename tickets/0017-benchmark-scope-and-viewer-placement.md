---
status: open
created: 2026-10-28
tags: [benchmark, submission]
---

# Benchmark: is "B+" the right scope, and where do the measured viewers sit?

## Question
The Benchmark lane proposes a scope for ticket 0016 with hours per piece. Do you accept it, with or without the
fan-out stretch? And do the VM runs measure viewers on the VM only, or add one run from a laptop over the internet?

## Context
The lane's proposal (2026-10-28) fits the plan: harness Sat Oct 31, runs Sun Nov 1, write-up Mon Nov 2.

- **B core, about 23 h:**
  - the capability matrix with citations (4 h);
  - one ffmpeg encode with a burnt-in millisecond clock, sent at once to the MoQ relay and to MediaMTX (LL-HLS and
    WebRTC/WHEP), so all three protocols get the same bytes;
  - one measurement page that reads the clock in every frame;
  - Playwright runs many joins per protocol for glass-to-glass latency and join time;
  - MoQ caption latency from a publisher built like the agents;
  - analysis and a chart.
- **Extras, about 3 h:**
  - bytes per viewer for captions only against every track (MoQ's selective subscription);
  - 2 % and 5 % packet loss.
- **Stretch, about 5 h:** server CPU, memory and egress at 10 and 100 viewers, for MoQ, WebRTC and LL-HLS.
- **Not proposed:**
  - 500 viewers;
  - measured LL-DASH (MediaMTX has no DASH, so it gets a matrix column only).

## Options
Scope:
- **B+ (about 26 h).** Latency, join time, selective subscription and loss, plus the matrix. Leaves room for the UI
  build.
- **B+ with the fan-out stretch (about 31 h).** Adds the server cost per viewer, the strongest argument for MoQ's
  fan-out. It competes with the UI build on Sun Nov 1.

Where the viewers sit:
- **A. Everything on the VM (the lane proceeds with this).** The source and viewers share one clock and there is no
  egress cost; internet delay is emulated. Weakness: no real internet path.
- **B. A plus one laptop-to-VM run over the internet.** Real internet numbers, but the clock offset between machines
  must be estimated (about ±5 ms) and egress adds about 1 GB (cents).

## Recommendation
B+ now, and decide the stretch on Sun Nov 1 morning by how the UI build stands. Viewers: A, adding B only if time is
left after the runs.

## Answer

