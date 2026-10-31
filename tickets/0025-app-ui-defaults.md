---
status: open
created: 2026-10-31
tags: [ui, defaults, design]
---

# Four App UI defaults the lane picked for now

## Question

The App UI lane (workstream 03) shipped with a default for each of these. Keep them or change them?

1. **Title font size.** The Cabin Sketch subset is 92 KB (target 60 KB), even cut to printable ASCII.
2. **Other listeners' marks.** They show only while the Discussion tab or your own drawing tools are open.
3. **Side panel on arrival.** It opens on Transcript, which subscribes captions as soon as you join.
4. **Keys 1–8.** The design gives them to chalk colours, but digits already pick tools in the console.

## Context

- Decision 0026 and `wiki/product/brand.md` §6: a panel is a subscription; no switches; slide comments are off by
  default.
- The font licence (OFL Reserved Font Name) means the subset is renamed "Talk Tracks Title".

## Options

1. **Title font:** (a) accept 92 KB: one file, loaded only on the hub and title cards; (b) letters only, 79 KB: no
   digits or punctuation in the display face; (c) only the glyphs of "Talk Tracks" plus headings in use: smallest,
   but any new heading needs a re-subset.
2. **Marks:** (a) keep: the slide stays clean, matches "comments are supplementary"; (b) always shown: more social,
   more clutter and one more subscription per listener.
3. **Panel:** (a) Transcript open: captions are visible at once; (b) panel closed: no subscription until the listener
   opens one, the cleanest "a panel is a subscription".
4. **Keys:** (a) digits stay on tools, colours in the popover only; (b) digits pick colours, tools get letters
   (P pen, H highlighter, L laser, E eraser, already partly in use).

## Recommendation

1a, 2a, 3a, 4a: each is what ships today, so no rework; revisit after QA.

## Answer

