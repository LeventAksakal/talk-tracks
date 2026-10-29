---
status: closed
created: 2026-10-28
tags: [benchmark, vm, cost]
---

# Which machine runs the benchmark's 2.5 hours of measurements?

## Question
The VM is too small for the benchmark runs. Where do we run them on Sun Nov 1?

## Context
The benchmark harness is merged and validated on the laptop:

| Measurement | Result |
|---|---|
| MoQ over WebTransport | p50 570 ms (the viewer's 500 ms buffer plus about 70 ms) |
| MoQ over WebSocket (the Safari and iOS path) | 577 ms |
| WebRTC | 336 ms |
| LL-HLS | 907 ms |
| MoQ, captions only | 3 ms for text, 16 kbit/s against about 1.4 Mbit/s for a full viewer |

The VM runs take about 2.5 hours. They need about 3 CPU cores (the source 1.6, Chrome 1.2) and 1.5 GB of RAM while
running. There are no API calls and no egress.

The production VM has **2 vCPUs on a shared-core type**, and it also runs the relay, the demo rooms and the agents.
Measuring on it would distort the numbers and slow the demo rooms for anyone watching.

## Options
- **A. A temporary VM of the same family with 4 vCPUs, deleted after the runs.**
  - The numbers are clean and production is untouched.
  - Costs cents (about 3 hours of a 4-vCPU machine) and about 20 minutes of the coordinator's setup.
  - Weakness: the numbers come from a twin, not the production box.
- **B. Resize the production VM to 4 vCPUs for the rest of the hackathon.**
  - The numbers come from the production box. The demo gets headroom for judges, the archive and load tests.
  - About a minute of downtime to resize. Roughly $2–3 a day more in cloud credit (not the Meta budget), about
    $15–20 to Nov 4.
- **C. Run on the production VM as it is, with the demo looper stopped for 2.5 hours.**
  - Free, but the demo is down meanwhile, and 2 shared cores still distort the numbers.

## Recommendation
B. The extra headroom also covers judge rooms, the archive and the VM load test planned for Sun Nov 1, so it pays for
more than the benchmark. If the cost matters, A.

## Answer

Resize the VM to 4 vCPUs (option B). Answered 2026-10-29.

Decision: [0013](../wiki/decisions/0013-benchmark-runs-on-the-resized-vm.md).
