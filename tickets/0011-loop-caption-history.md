---
status: open
created: 2026-10-27
tags: [demo, viewer, loop]
---

# Does a looped room's caption history carry into the next loop?

## Question
When a demo room's lecture loops back to the start, does the viewer keep the earlier loops' captions, translations
and chapters, or clear them?

## Context
At each loop restart every agent track gets a new instance; line ids and media times keep rising across loops (see
`wiki/howto/demo-rooms.md`). The looper supports either behaviour; the web viewer has to pick one.

## Options
- **A. Clear the history at each loop start.** Each loop reads like a fresh talk and the list stays short. A viewer
  who stays past the end loses the earlier text unless rewind (ticket 0002) covers it.
- **B. Keep the history, keyed by line id.** Reads like one endless talk. The list grows without limit and the same
  sentences repeat once per loop.

## Recommendation
A: a demo room should feel like one lecture, and rewind option B of ticket 0002 gives the full history from the
recording without the viewer building it up.

## Answer

