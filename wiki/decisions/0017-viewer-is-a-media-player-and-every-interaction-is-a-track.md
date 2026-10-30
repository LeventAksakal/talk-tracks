---
status: accepted
date: 2026-10-30
decision-makers: project owner
---

# The viewer is a media player, and every interaction in a talk is an event track

## Context and Problem Statement

The viewer was a smoke-test shell, and the design brief's "multitrack timeline" direction was never agreed. The
owner's goal is a lecture that **replays exactly as it happened live, with every interaction built into tracks**, in a
player people already know how to use ([ui-design.md](../product/ui-design.md)).

## Decision Outcome

* **A traditional media player.** Canvas with the speaker's sources, a control bar (playback left; CC, layout, side
  panel, settings, fullscreen right), a progress bar, a side panel (Transcript, Chapters, Discussion, Glossary,
  Notes). AI outputs are player features: translation is a subtitle language, captions are subtitles.
* **Every interaction is an event track** on the room clock: slide shown, ink, laser pointer, comments, room state,
  next to the media and the AI tracks. Each uses the AI tracks' model (MSF event-timeline records, 4 s groups, object
  0 = carry-in; [moq-track-system §4](../design/moq-track-system.md)). The player draws the room's state at time `t`
  from all tracks; live is SUBSCRIBE at the edge, replay is FETCH of the same tracks.
* **Overlays** (subtitles, ink, pointer, comment highlights) are one layer above both renderers (live WebCodecs
  canvas, archive media element), positioned in fractions of the slide or canvas, on the room time of the frame on
  screen. How it renders is decided by the player lane after reading the platform docs (ui-design §11).
* **Chapters follow YouTube:** segments on the progress bar, the name in the hover preview, the current chapter in
  the control bar opening the list. No always-visible chapter strip.
* **Subtitles default to an overlay the listener can drag anywhere**, with style settings previewed live.
* **Comments anchored on slides** (ui-design §4.9) are built after the foundation, if time allows, through a room
  service; listeners never get relay publish rights (decision 0005).

### Consequences

* Good, because replay needs no special case: the same tracks, read by FETCH.
* Good, because familiar player conventions need no explanation.
* Bad, because new contracts (deck, slide, ink, pointer, comments, room) touch every lane, so they land first.
