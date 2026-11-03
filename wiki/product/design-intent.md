# Design intent

What each surface is for, the decision behind its look, and what it leaves out on purpose. The look as a whole is
decision [0036](../decisions/0036-the-talks-are-the-imagery.md) (which amends [0033](../decisions/0033-the-look-is-a-streaming-platform.md)):
a streaming platform where the talks lead, in quiet chrome. Revised on 2026-11-03 after the judges' round 1.

## Shared language

* **Imagery is the talks.** Pictures of a talk are slides the speaker made, cut from the talk's own recording
  (`web/public/talks/`) and credited where they are shown. One rule for every picture: a slide, never a face or a
  stage shot, so no row mixes the two. Nothing is drawn or generated to stand in for a talk; a talk without a still
  shows its title.
* **Type:** Atkinson Hyperlegible Next only (400, 600, 700), chosen for legibility because this product is about
  reading captions. Hierarchy comes from size and weight, never from colour or capitals. No label above a heading.
  Its zero is slashed by design (the font has no unslashed zero to switch to); it is part of what tells 0 from O.
* **Colour:** neutral grounds (hub: `#f7f7f5` light, `#0e0e10` dark). Live red is the one colour that means a state.
  The logomark is one colour, the text colour of where it sits. One primary button colour everywhere
  (`--tt-color-play`: near-black on light, white on dark); everything else is a hairline button or a plain link.
* **Surfaces:** opaque. Hairlines (1 px, 10 to 12 % of the text colour) and 6 to 10 px corners. Shadows only where
  something floats over content (a menu, a dialog, the dock). No glass, blur, glow, gradient edges or animated
  decoration.
* **Motion:** short fades for content that changes (a card's extended view, the controls when idle). A pulsing dot
  means on air. Everything is still under reduced motion.
* **Durations:** "N-minute talk" in a sentence (the hero), "N min" on a recording's still. A live session shows no
  length: it is running.

## Hub (`/`): browse, artifact first

**Intent.** Someone arriving should see real lectures within a second, pick one and start it. It is a browse
surface: the stills and titles lead, the chrome recedes.

**Decision.** Each talk appears twice at most: once live, once as a recording.

* *Featured talk* (the hero) is the first demo lecture's live session beside its still: the title set large over its
  subtitle (split at the colon), then one line saying what it is ("Live replay", with a pulsing dot when on air),
  the speaker and subject, one sentence on the talk, one line on its length and what it carries, and two ways in
  (Watch live, From the start).
* *Live now* holds the other live sessions, without LIVE badges: the row's note says they are recorded talks replayed
  live, so a badge on every card would say nothing.
* *Recordings* holds every lecture from the start, each with its length on the still and a different slide from its
  live picture.

Round 1 had the hero rotate through all four talks over the Live now row of the same four, then Recordings: every
talk three times. A rotating hero also changed under the reader. One fixed feature, and a Live now row of the rest,
removes the repetition and keeps the hero still.

The shell renders from static data: the nav links, the hero's wording, the rows and their buttons are there on the
first paint, and the relay's answer only adds the on-air dot. Nothing reflows when the relay or the archive answers.

A card is the still, the title and the byline. Hovered (after a short delay) or focused, its extended view
(description, facts, actions) opens over the still itself, inside the card's own box: the row never moves, the title
stays in view and the card keeps its height.

**Left out.** Generated cover art; the "Tracks in this talk / Live edge" bar panel (it drew data that does not
exist); the subject label above titles (the subject is in the byline); glass, glow and gradient borders; decorative
chips (the spoken language is plain text); a coloured hero backdrop (the still carries the colour); scroll snapping;
a hero carousel and its markers; LIVE badges on cards in a row that is all live; skeleton cards.

## Start a talk and Join (on the hub)

**Intent.** A speaker gets a private console link and an audience link in one step; a listener with a code joins.

**Decision.** Start a talk is a hairline button in the nav, Join's Go a hairline button of the same weight, so the
two entrances read as equals. The dialog is a plain panel on the page's surface colour with a hairline and one soft
shadow; the form is unchanged.

**Left out.** The lanes gradient strip on top of the panel; the blurred backdrop.

## Player (`/watch/<room>`): the talk fills the stage

**Intent.** The talk is the content; the controls are there when wanted and gone when not.

**Decision.**

* The player is always dark, whatever the page theme. A video player is a dark room: the slides and the camera are
  the light in it, and a pale frame around a pale slide would leave the slide no edge. The hub and dialogs follow the
  viewer's theme; the player and the speaker console's stage do not. This is on purpose, not a gap.
* A solid title bar along the stage's top edge: "All talks" on the left (the way back), the title and byline beside
  it. The slides start below the bar, so a pale slide never sits under the byline. The bar fades with the controls.
* One opaque dock along the bottom: transport, timeline, the live marker and the menus. It shows on first load and
  stays until the viewer first moves, touches or types; after that it fades when idle. On an end card it stays.
* The live marker says what the viewer is watching in two words: "LIVE" for a speaker on air, "Live replay" for a
  recorded talk replayed live. How the connection runs (the WebSocket fallback) is in Stats for nerds.
* No slide at this moment: the camera has the stage to itself, unlabelled. An empty "no slide" panel is not a
  picture worth the stage. A recording that opens off its layout (the stage camera) shows the whole frame, also
  unlabelled; "Camera" labels the corner picture only when it sits beside the slides.
* Menus are opaque panels with one soft shadow. The subtitles menu keeps one line per language; that a language not
  yet running starts when picked is said once, under the search field.
* The end of a recording keeps its last frame on the stage under a plain scrim, with "Replay from the start" (the
  primary button) and "All talks", and the dock below with its timeline.
* Watch and recording pages share one stage geometry: the pictures start under the title bar and the corner camera
  sits in a band beside the slides, never over them.

**Left out.** Glass menus and dock; the radial glow and icon on the end card; the scrim over the title; transport
words in the marker; the "Slides" label above the slide card.

## Speaker console (`/speak/<room>`)

**Intent.** A speaker running a talk sees what is on air and whether each part works, at a glance.

**Decision.** The same language as the hub: a bar on the ground with a hairline, panels on the surface colour with a
hairline and 8 px corners, the on-air stage ringed in live red. Each check is a dot and a word in sentence case.

**Left out.** Radial washes, glass panels, capitals in the check states, the three-colour mark.

## Social card and video cards (`web/public/og.png`, `web/public/brand/video/`)

**Intent.** A link preview and the film's title card say what the product is and show it.

**Decision.** The one-colour mark, the name and one sentence on a plain dark ground, beside the four talks' slides.

**Left out.** The drawn tracks panel and the lanes glow.
