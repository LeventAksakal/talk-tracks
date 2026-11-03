---
status: accepted
date: 2026-11-03
decision-makers: project owner, coordinator
amends: 0033
---

# The talks are the imagery; the chrome is quiet

## Context and Problem Statement

Decision 0033 set a streaming-platform look, and the hub and player were built in it with glass cards, a lanes glow,
gradient edges, generated key art for each lecture (a drawn virus, a QR code, charts, a lock) and a "Tracks in this
talk / LIVE EDGE" panel of animated bars. The owner, 2026-11-03, on the deployed hub: "you fabricated the cover art
AI detection is through the roof with this UI ... be elegant. and find proper imagery and content for cover art
thumbnail etc. disect the talks use the slides or other images on the web".

## Decision Outcome

0033's intent stands: a streaming platform where the content leads, no mascot. Its execution changes:

* **Every picture of a talk is a frame of its own recording**: a slide the speaker made, or the speaker on stage.
  Each demo lecture has two (one for its live session, one for its recording), cut from the 720p archive, cropped to
  16:9 and kept as WebP in `web/public/talks/`. Each carries its credit where it is shown (the hero's caption) and in
  NOTICE section 7. A talk with no still shows its title on a plain field; nothing is generated or drawn to stand in.
* **Which slides.** The owner's words supersede ticket 0001's rule against extracting slides as assets, within a
  limit: slides whose main content is a photograph or someone else's figure are not used. The recordings are
  CC BY-SA 4.0, so the stills are too.
* **The chrome is quiet.** No glass, glows, gradient borders, animated decoration or invented data. One type family
  (Atkinson Hyperlegible Next), neutral grounds in light and dark, hairlines, 6 to 8 px corners. Colour comes from
  the talks; live red is the one interface colour that signals a state. No label sits above a heading.
* Social card and video title card show the four stills instead of the drawn tracks panel.

### Consequences

* Good: the first thing anyone sees is the real lectures, and it reads as made for them, not from a template.
* Good: the images are small (8 to 48 KB each) and lazy below the fold; the hub stays fast.
* Bad: 720p sources limit the hero still to 960 px, slightly soft on a 2x display.
* Bad: the stills are chosen by hand; a new demo lecture needs its frames picked the same way.

## More Information

Per-surface intent and what each leaves out: `wiki/product/design-intent.md`. The frames are listed with their times
in NOTICE section 7.
