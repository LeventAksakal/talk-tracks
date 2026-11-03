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
* **Colour:** neutral grounds (hub: `#f7f7f5` light, `#0e0e10` dark). Live red is the one colour that means a state
  of the talk (on air). The accent blue is for what can be followed: links, focus rings, a transcript's timestamps,
  a checked choice in a menu; it never fills a button.
  The logomark is one colour, the text colour of where it sits. One primary button colour everywhere
  (`--tt-color-play`: near-black on light, white on dark); everything else is a hairline button or a plain link.
* **Surfaces:** opaque. Hairlines (1 px, 10 to 12 % of the text colour) and 6 to 10 px corners. Shadows only where
  something floats over content (a menu, a dialog, the dock). No glass, blur, glow, gradient edges or animated
  decoration.
* **Motion:** short fades for content that changes (a card's extended view, the controls when idle). A pulsing dot
  means on air. Everything is still under reduced motion.
* **Durations:** "N-minute talk" in a sentence (the hero), "N min" on a recording's still. A live session shows no
  length: it is running.
* **Counts:** in a sentence a count is a word ("subtitles in any of fifty languages"): the font's slashed zero reads
  like code in prose. Compact meta (a card's facts, a menu's note, a time) keeps numerals.

## Hub (`/`): browse, artifact first

**Intent.** Someone arriving should see real lectures within a second, pick one and start it. It is a browse
surface: the stills and titles lead, the chrome recedes.

**Decision.** Each talk appears twice at most: once live, once as a recording.

* *Featured talk* (the hero) is the first demo lecture's live session beside its still: the title set large over its
  subtitle (split at the colon), then one line saying what it is ("Live replay", with a pulsing dot when on air),
  the speaker and subject, one sentence on the talk, one sentence on its length and what it carries, and two ways in
  (Watch live, From the start). Between two runs of the session nothing on the hub changes: the button still says
  Watch live and the dot is grey; when the next run starts is the player's to say.
* A row of three cards (Live now, the lectures other than the featured one) spans the same width as a row of four,
  so the rows line up and no fourth place stands empty.
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
* No slide at this moment (the speaker hid the slides, or a stretch with none): the rule is "a slide, never a face",
  so the stage keeps a slide whenever it has one.
  * A slide was seen earlier in this session, at or before the playhead: that slide stays on the stage, without its
    marks and ink (they were on it then), and the camera keeps its corner. A seek back before the first slide seen
    falls to the next case.
  * No slide seen yet (a talk's first minutes): the camera is the one picture, centred and at most 64 % of the
    stage's width, under the title bar, with a hairline and rounded corners: a speaker in a room before the slides
    start, not a video call filling the screen. Unlabelled: nothing beside it to tell it from.
  * Off its layout (a recorded frame of the stage camera, a title card, a zoom on a slide; the `off_layout` spans) the
    whole recorded frame fills the stage on purpose, unlabelled.
  * An empty "no slide" panel is never shown when there is a picture; "Camera" labels the corner picture only when it
    sits beside the slides.
* Menus are opaque panels with one soft shadow. The subtitles menu keeps one line per language; that a language not
  yet running starts when picked is said once, under the search field.
* The end of a recording keeps its last frame on the stage under a plain scrim, with "Replay from the start" (the
  primary button) and "All talks", and the dock below with its timeline. The recording really ends there: paused,
  the dock's play button a Replay icon, no spinner, the camera tile quiet. A recording has no live side, so playback
  never goes live by itself at its end; play at the end replays from 0:00.
* A card on the stage (an end, a pause, a reconnect) says what the stage is doing: no loading spinner over it.
* The subtitles menu lists every language A to Z by its name in the viewer's language (the autonym beside it), says
  how many there are, and shows six and a half rows so the half row says the list goes on.
* The transcript's timestamp sits on its line's first row; a finished line of under four words joins the one before,
  so a caption cut mid-sentence never stands alone.
* Watch and recording pages share one stage geometry: the pictures start under the title bar and the corner camera
  sits in a band beside the slides, never over them.

**Left out.** Glass menus and dock; the radial glow and icon on the end card; the scrim over the title; transport
words in the marker; the "Slides" label above the slide card.

## Speaker console (`/speak/<room>`)

**Intent.** A speaker running a talk sees what is on air and whether each part works, at a glance.

**Decision.** The same language as the hub: a bar on the ground with a hairline, panels on the surface colour with a
hairline and 8 px corners, the on-air stage ringed in live red. Each check is a dot and a word in sentence case.

Before a deck is loaded the stage asks for one (the one "Load slides"); the drawing tools and the slide controls come
with the deck, so the console never shows rows of disabled controls. The tools are one hairline bar; the slide
controls and the drawing's undo, redo and clear share the row below, in one secondary button style.

**Left out.** Radial washes, glass panels, capitals in the check states, the three-colour mark.

## Social card and video cards (`web/public/og.png`, `web/public/brand/video/`)

**Intent.** A link preview and the film's title card say what the product is and show it.

**Decision.** The one-colour mark, the name and one sentence on a plain dark ground, beside the four talks' slides.

**Left out.** The drawn tracks panel and the lanes glow.
