---
status: accepted
date: 2026-10-30
decision-makers: project owner
---

# The speaker sends voice, camera, a slide deck with ink and laser; notes stay private

## Context and Problem Statement

Today the console publishes the microphone and slide images. A lecture replay with every interaction needs the
speaker's slides, drawing and pointing as tracks ([decision 0017](0017-viewer-is-a-media-player-and-every-interaction-is-a-track.md)).

## Decision Outcome

* **Sources in this build:** microphone, camera (H.264), and a slide deck loaded as a PDF and rendered to slide
  images in the console.
* **Slide tracks:** the deck's images, the slide shown, ink (pen, highlighter, eraser, clear) and the laser pointer,
  all as event tracks with positions in fractions of the slide.
* **Presenter view:** current slide, next slide and the speaker's notes. Notes and the presenter view never leave the
  console.
* **Screen share is out of this build** (most work of the sources; first to cut).

### Consequences

* Good, because ink and laser are small data that replay exactly.
* Bad, because camera adds 1–2 Mbit/s per viewer and a transcoding risk on the VM; it is the first thing to cut
  after comments if the Nov 2 checks are at risk.
