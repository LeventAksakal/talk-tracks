---
status: open
created: 2026-10-30
tags: [contracts, annotations, decision-0021]
---

# Shape of audience annotation tracks (ticket 0020)

## Question

Contracts pass 2 (decision 0021) made the deck plus its annotations shared state that every user can change. Three
choices in it are defaults the lanes are building on now; change any you disagree with.

1. Listener annotations: one shared room-service track per kind, or one track per user?
2. Should the speaker's Clear also wipe the audience's ink and marks on that slide?
3. Text styles: underline and highlight only, or also strike?

## Context

- You said laser, pencil and text underline are separate tools, and every mutation is a live, cached, fetchable track
  "created by every user". Listeners can't publish to the relay (decision 0005), so their changes go through the room
  service, which publishes them.
- Tracks now: speaker `talk/R/slides/{ink,marks,pointer}`; audience `talk/R/annotations/{ink,marks}` (room service).
- Every change carries `by: {id, name, speaker?}`. Erase, unmark and clear apply to your own work, or to anyone's when
  you are the speaker. Container rules per track: `wiki/design/container-formats.md`.

## Options

1. Audience tracks
   - **One shared track per kind (current).** The player subscribes to a fixed, known set; the room service already
     orders and rate-limits writes. Trade-off: one person's marks can't be fetched alone without filtering.
   - **One track per user.** Matches "every user" literally and makes per-person filtering free. Trade-off: the player
     must discover and subscribe to a growing, unknown set of tracks; more relay state per room.
2. Speaker's Clear
   - **Clears only the speaker's own work (current).** Audience notes survive; the speaker removes audience strokes
     one at a time. Trade-off: no one-click "clean slide" for the speaker.
   - **Clears everyone's on that slide.** One click cleans the slide. Trade-off: listeners lose their own notes on it.
3. Text styles
   - **Underline + highlight (current).** Trade-off: none much; highlight is the common reading mark.
   - **Add strike.** Trade-off: one more tool button, rarely used in lectures.

## Recommendation

Keep all three defaults: one shared track per kind; Clear is per author; underline + highlight.

## Answer

