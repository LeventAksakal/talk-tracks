---
status: closed
created: 2026-10-27
tags: [scope, demo]
---

# Which demo moments stay now that rooms loop?

## Question
The earlier scope had four demo moments that show the architecture: an agent started mid-talk appears in every
viewer's track list; the caption agent is killed on camera and a replacement takes over with no lost lines; a late
joiner gets scrollback from the relay cache; a load panel shows 100 scripted viewers and AI cost per track. Which of
these stay, and where are they shown?

## Context
In looped rooms (decision 0006) no agent runs live, so the mid-talk start and the kill-on-camera moments only happen
in a live room or in the submission video. Rewind (ticket 0002) replaces much of "late-join scrollback".

## Options
- **A. Keep all four, shown in the video from a live room;** looped rooms show discovery, track choice and rewind.
- **B. Keep mid-talk agent and load panel; drop kill-on-camera.** Saves the failover work (ticket 0005).
- **C. Keep only the load panel and track discovery.** Smallest; the "agents come and go" story weakens.

## Recommendation
A: the agent moments are the architecture argument, and a live room for the video is cheap.

## Answer
A: keep all four (2026-10-29). Looped rooms show track discovery, multi-language opt-in and rewind; live rooms and the
submission video show mid-talk agent join, caption kill-and-restart handover (1-3.5 s QUIC recovery seeded from the
slice archive, [decision 0009](../wiki/decisions/0009-agents-restart-from-durable-track-history.md) and
[0012](../wiki/decisions/0012-ai-track-history-by-fetch-from-the-agent.md)), and the live Inspector (`producing`,
`fetches_served`, `backfills`, `spend_usd` from `catalog.tt.status`). Recorded in
[decision 0015](../wiki/decisions/0015-looped-rooms-model-repeated-live-sessions.md).

