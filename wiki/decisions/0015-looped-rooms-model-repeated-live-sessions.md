---
status: accepted
date: 2026-10-29
decision-makers: project owner
---

# Looped demo rooms keep rising room time on the wire and present each loop as a broadcast session

## Context and Problem Statement

When a looped demo room reaches the end of its lecture and starts again, a naive clear wipes the transcript right as
the talk finishes, while an unbounded flat list repeats the same lecture indefinitely and distorts the timeline
([ticket 0011](../../tickets/0011-loop-caption-history.md)). We also need clear placement for the four architecture
demo moments across looped rooms, live rooms and the submission video
([ticket 0004](../../tickets/0004-demo-moments-in-looped-rooms.md)).

## Decision Outcome

* **Wire and archive:** room time, 4 s slice numbers and item ids continue to rise monotonically across loops, with a
  short silent tail (`duration_ms .. period_ms`) between loops and `talk_tracks: {loop, loop_start_ms, duration_ms,
  period_ms}` published in the teacher's hang catalog. Seeking and `FETCH` work across any boundary without id or group
  collisions.
* **Viewer presentation:** each `loop` is framed like a real livestream session ending and the next session starting.
  The active scrubbar and live transcript scope to the current `loop` (`0 .. duration_ms`); during the silent tail the
  viewer indicates the session has ended and the next broadcast is starting, then begins the new loop cleanly (while
  rewind can still inspect past room time).
* **Demo moments ([ticket 0004](../../tickets/0004-demo-moments-in-looped-rooms.md)):** all four moments stay. Looped
  rooms show track discovery, opt-in multi-language selection and rewind; live rooms (and the submission video) show
  mid-talk agent join, caption kill-and-restart handover, and the live Inspector (`producing`, `fetches_served`,
  `backfills`, `spend_usd` from `catalog.tt.status`).

### Consequences

* Good, because the transport stays monotonic (no clock jumps in `@moq/watch` or `FETCH`), while the UI feels like a
  real talk closing and reopening rather than an endless duplicate scroll.
* Good, because the looper already publishes `talk_tracks` loop metadata, requiring no wire contract change.
