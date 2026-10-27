---
status: open
created: 2026-10-27
tags: [agents, failover, live]
---

# How does a killed caption agent hand over with no lines lost?

## Question
In a live room, how does a replacement caption agent take over so that no spoken line is missing?

## Context
Viewers follow the newest agent instance and mark one stale after 6 s without an object. A new subscription starts at
the newest group, so audio spoken while a replacement starts is not replayed. Meta's realtime ASR refuses audio sent
faster than real time. Speech recognition is cheap (seven test sessions cost about $0.01). Only matters if ticket 0004
keeps the kill-on-camera moment.

## Options
- **A. Hot standby.** Two caption agents always run; viewers switch to the other when the newest goes stale.
  Seamless; doubles ASR cost.
- **B. Seed and continue.** The replacement reads the last captions state for line ids and continues from live audio.
  Simple; speech during the 1–3 s restart is lost, so "no lines lost" is not true.
- **C. Seed and back-fill.** As B, plus fetch the missed audio groups from the relay cache. One ASR stream; the
  missed audio can't go through realtime ASR at speed, so it needs a second, non-realtime path.

## Recommendation
A: the only option that keeps the claim honest, at negligible cost.

## Answer

