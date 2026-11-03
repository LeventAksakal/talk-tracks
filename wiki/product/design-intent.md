# Design intent

What each surface is for, the decision behind its look, and what it leaves out on purpose. The look as a whole is
decision [0036](../decisions/0036-the-talks-are-the-imagery.md) (which amends [0033](../decisions/0033-the-look-is-a-streaming-platform.md)):
a streaming platform where the talks lead, in quiet chrome.

## Shared language

* **Imagery is the talks.** Pictures of a talk are frames of its own recording (`web/public/talks/`), credited where
  they are shown. Nothing is drawn or generated to stand in for a talk; a talk without a still shows its title.
* **Type:** Atkinson Hyperlegible Next only (400, 600, 700), chosen for legibility because this product is about
  reading captions. Hierarchy comes from size and weight, never from colour or capitals. No label above a heading.
* **Colour:** neutral grounds (hub: `#f7f7f5` light, `#0e0e10` dark; the player is always dark). Live red is the one
  colour that means a state. The logomark keeps its three lane colours; nothing else borrows them.
* **Surfaces:** hairlines (1 px, 10 to 12 % of the text colour) and 6 to 8 px corners. Shadows only where something
  floats over content (a menu, a dialog), soft and offset. No glass, glow, gradient edges or animated decoration.
* **Motion:** short fades for content that changes (the hero's talk, a card's extended view). A pulsing dot means
  live. Everything is still under reduced motion.

## Hub (`/`): browse, artifact first

**Intent.** Someone arriving should see real lectures within a second, pick one and start it. It is a browse
surface: the stills and titles lead, the chrome recedes.

**Decision.** The hero puts what is on air beside its still: the title set large over its subtitle (split at the
colon), the speaker, subject and length, one sentence on what it is about, one line on what it carries (language,
subtitles in 50 languages, chapters, slide descriptions, glossary), and two ways in (Watch live, From the start). The
still's credit sits under it, with the markers that pick another talk. Rows below hold the live sessions and the
recordings, each talk by a different frame in each row so the page does not repeat itself. A card is the still, the
title and the byline; hovered or focused, it opens its extended view beside the still (description, facts, actions,
credit). Four cards fill the row's width on a desktop; the row scrolls sideways past them.

**Left out.** Generated cover art; the "Tracks in this talk / Live edge" bar panel (it drew data that does not
exist); the subject label above titles (the subject is in the byline); glass, glow and gradient borders; decorative
chips (the spoken language is plain text); a coloured hero backdrop (the still carries the colour); scroll snapping
(it re-snapped when a card widened).

## Start a talk (dialog on the hub)

**Intent.** A speaker gets a private console link and an audience link in one step.

**Decision.** A plain dialog on the page's surface colour with a hairline and one soft shadow; the form is unchanged.

**Left out.** The lanes gradient strip on top of the panel; the blurred backdrop.

## Social card and video cards (`web/public/og.png`, `web/public/brand/video/`)

**Intent.** A link preview and the film's title card say what the product is and show it.

**Decision.** The mark, the name and one sentence on a plain dark ground, beside the four talks' stills.

**Left out.** The drawn tracks panel and the lanes glow.
