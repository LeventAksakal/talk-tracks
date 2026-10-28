---
status: answered
created: 2026-10-28
tags: [benchmark, submission, transport]
---

# What does the benchmark against HLS, DASH and WebRTC measure, and how much time does it get?

## Question
Which alternatives do we compare Talk Tracks' Media over QUIC transport with, on which measures, and how far do we
take it before the deadline?

## Context
The architecture argument for Talk Tracks: one relay fans out many named tracks with WebRTC-like latency, every AI
step is its own publisher, and a viewer takes only the tracks they want. A benchmark makes that argument concrete for
judges, if the numbers are honest. WebRTC will likely beat us on raw latency; the case is latency close to WebRTC
with broadcast-style fan-out, caching and composable tracks.

Data we already have: 100 local MoQ viewers had p50 51 ms and p95 89 ms on agent snapshots, with the relay at
39 MiB.

| Measure | Why judges care | How to measure |
|---|---|---|
| Glass-to-glass latency (video, audio) | "live" means live | a clock burned into the video, read at the viewer; or stamped audio |
| Text-track latency (captions to screen) | captions that lag are useless | publish time vs. render time in the page |
| Join time (click to first frame) | first impression | headless Chrome, many runs |
| Server cost per viewer (CPU, memory, egress) at 10 / 100 / 500 viewers | fan-out scaling | simulated viewers against one VM |
| Selective subscription (bytes for captions only vs. everything) | the "tracks" idea | bytes on the wire per viewer |
| Behaviour under loss (2 %, 5 % packet loss with `tc netem`) | classroom Wi-Fi | stalls and latency under loss |
| Capabilities: rewind, late join, cache/CDN, many independent tracks, non-media tracks, browser support | what each protocol can do at all | desk research, cited |

Baselines: MediaMTX serves LL-HLS and WebRTC (WHEP) from one server on the same VM with the same source, which is a
fair same-box comparison. LL-DASH behaves like LL-HLS, so it gets a column in the capability table only, unless we
have time to spare.

## Options
- **A. Capability table only.** Desk research with citations, about half a day. No numbers of our own.
- **B. Table plus measured latency and join time** for MoQ, LL-HLS and WebRTC on the VM, about 1–1.5 days. Gives the
  headline chart.
- **C. B plus fan-out cost at scale and behaviour under loss,** about 2.5–3 days. The strongest story, but it competes
  with the UI build.

## Recommendation
B, with fan-out cost added for MoQ and WebRTC at 100 viewers if a day frees up. The latency chart plus the
capability table carry the story. Fan-out at 500 viewers needs a bigger load generator than one laptop.

## Answer
The comparison cannot be performance only. A capability matrix is crucial too: the features the app requires against the capabilities each protocol delivers, alongside the performance numbers. Scope (B or C) is left to the benchmark lane to propose with a time estimate.
