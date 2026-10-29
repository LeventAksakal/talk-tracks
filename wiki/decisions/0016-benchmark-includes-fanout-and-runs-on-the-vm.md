---
status: accepted
date: 2026-10-29
decision-makers: project owner
---

# The benchmark measures B+ plus 10- and 100-viewer fan-out on the resized VM

## Context and Problem Statement

[Ticket 0016](../../tickets/0016-benchmark.md) established that Talk Tracks' transport benchmark needs both a cited
capability matrix and honest measurements against LL-HLS and WebRTC. [Ticket 0017](../../tickets/0017-benchmark-scope-and-viewer-placement.md)
left two choices open: whether to include the 10- and 100-viewer server fan-out stretch alongside the B+ latency/loss/FETCH
suite, and whether measured viewers sit on the VM or add a laptop-to-VM internet run.

## Decision Outcome

* **Scope: B+ with the 10- and 100-viewer fan-out stretch.** Alongside the capability matrix, glass-to-glass latency,
  join time, WebSocket fallback (`moq-ws`), selective-subscription byte savings, 2 % / 5 % packet loss and `FETCH`
  cache-vs-origin timing, the benchmark measures server CPU, memory and egress at 10 and 100 concurrent viewers for
  MoQ, WebRTC and LL-HLS.
* **Placement: on the resized 4-vCPU production VM ([decision 0013](0013-benchmark-runs-on-the-resized-vm.md)), with
  `tc netem` for RTT and packet loss.** Source and viewers share one clock (sub-millisecond frame-barcode accuracy, no
  clock-offset estimation) and incur zero cloud egress.

### Consequences

* Good, because fan-out cost per viewer alongside WebRTC-class latency is the strongest empirical proof of the MoQ
  relay architecture, and the UI work is in a separate lane so the stretch does not block it.
* Bad, because simulating 100 WebRTC/HLS/MoQ viewers on one 4-vCPU host cannot run 100 full Chrome decoders; the
  fan-out harness must drive lightweight protocol subscribers so load-generator CPU does not swamp server CPU, and
  state that clearly in `wiki/benchmark.md`.
