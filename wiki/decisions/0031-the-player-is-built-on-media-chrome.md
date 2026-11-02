---
status: accepted
date: 2026-11-02
decision-makers: project owner, coordinator
---

# The player is built on Media Chrome

## Context and Problem Statement

The owner, 2026-11-02, after the counted QA run: "the player is reaaly shit basic features like click to pause play;
double click to full screen etc. ... right toolbar buttons have no aria also they are arbitrariyl places there is a
setting icon an don setting ot configure the quality rate or speed. Instead of rolloing out a shitty player wasnt there
already finished open source players for web?" Asked through the question prompt: Media Chrome, Vidstack, or keep our
player and add the basics.

## Decision Outcome

Chosen: **Media Chrome** (Mux, MIT, web components).

* The live MoQ stream is a custom media element (the HTMLMediaElement shape Media Chrome drives: play, pause,
  currentTime, duration, seekable, playbackRate, textTracks, volume, muted, and their events) around our existing
  playback pipeline. A recording plays through Media Chrome's HLS element over the archive playlists
  ([archive.md](../howto/archive.md#hls-playlists)).
* The controls come from Media Chrome, not from us: click to play/pause, double-click for fullscreen, keyboard keys,
  speed, quality (renditions), the captions and translations menu, picture-in-picture where the element allows it,
  and labelled buttons. A settings button exists only when it opens real settings (speed, quality, subtitle style).
* We skin it (decision 0033); we do not fork it.

### Consequences

* Good: the basics are correct and accessible from the first build; less code of our own to test.
* Bad: about a day of wiring; the custom element must keep our room-time model (live edge, "You missed", Go live).
* Fallback: if the Media Chrome player is not working by Tue 2026-11-03 14:00 +03, the release keeps our player with
  the basics added by hand.
