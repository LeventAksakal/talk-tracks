# UI design: Talk Tracks, top down (brainstorm, 2026-10-30)

**Status:** the foundation is decided (decisions [0017](../decisions/0017-viewer-is-a-media-player-and-every-interaction-is-a-track.md),
[0018](../decisions/0018-speaker-sends-slides-ink-laser-and-camera.md),
[0019](../decisions/0019-subtitles-in-any-language-the-model-supports.md)); everything not covered by them is still a
brainstorm with options and trade-offs. The brief ([design-brief.md](design-brief.md)) stays the source for track data, rules and
constraints; its §6 "multitrack timeline" direction is dropped (owner, 2026-10-30).

**Frame:** a traditional media player. The AI outputs are ordinary player features and settings: captions and
translations are subtitles, chapters sit on the progress bar, slides are a second picture, the transcript is a side
panel. Nothing is pitched; everything should feel like a player people already know.

Precedents are from the Juxtopposed case catalog, listed in [§12](#12-precedents-used) with why each reason holds.

## 1. Purpose

Anyone can follow a live or recorded talk in the form they can take in (hearing, sight, language), catch up
without losing the present, and take something away. The speaker shares voice, camera, slides and screen with no
extra work.

## 2. Needs

### Listener

| # | Need | In plain words |
|---|---|---|
| L1 | Arrive | Get to the right talk from a link, QR or name; know at once whether it is on. |
| L2 | Perceive | Take in what is said and shown through the senses and language I have. |
| L3 | Choose | Turn features on and off, pick a language, change it any time. |
| L4 | Trust | Know whether what I see is live, behind, missing or broken. |
| L5 | Recover | Catch up after looking away, joining late or losing the connection. |
| L6 | Understand | Where we are in the talk, what a term means, the gist so far. |
| L7 | Keep | My bookmarks, notes and the words. |
| L8 | Stay with the talk | The player never competes with the speaker. |
| L9 | Fit it to me | Subtitle size, colour, position; theme; remembered. |

### Speaker

| # | Need | In plain words |
|---|---|---|
| S1 | Prepare | Know I will be heard and seen before going live. |
| S2 | Invite | Get the audience in (projected QR, link). |
| S3 | Deliver | Talk, show slides, draw on them, point, share my screen, with little attention on the tool. |
| S4 | Know it works | Who is watching, which features they use, cost against the cap, failures. |
| S5 | Finish | End cleanly, never by accident. |

### Evaluator (judge)

| # | Need | In plain words |
|---|---|---|
| E1 | Grasp | Understand the product in seconds. |
| E2 | Verify | See the MoQ system do the work (lazy agents, relay cache, FETCH, caps). |

## 3. The player

### 3.1 Anatomy

```
┌──────────────────────────────────────────────────────────────────────────┬──────────────────────┐
│ You Are Part Virus · Christopher Binny · EMF 2026 (CC BY-SA)              │  Side panel          │
├──────────────────────────────────────────────────────────────────────────┤  Transcript │ Chapters│
│                                                                          │  Glossary │ Notes     │
│                         CANVAS                                           │                      │
│        sources in the chosen layout (camera / slides / screen)           │  12:04 So a virus …  │
│        overlays: subtitles (draggable), ink, laser pointer               │  12:11 …             │
│                                                                          │                      │
│                  ┌────────────────────────────────────┐                  │                      │
│                  │ So a virus is, at its core, a set  │  ← drag anywhere │                      │
│                  │ of instructions                    │                  │                      │
│                  └────────────────────────────────────┘                  │                      │
├──────────────────────────────────────────────────────────────────────────┤                      │
│ [thumb] Intro │ [thumb] What a virus is │ [thumb] Hacking the cell │ …    │  ← chapter strip     │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━│  ← progress bar      │
│ ▶  🔊━━  12:04 / ● LIVE   · What a virus is ›        CC  ⧉  ☰  ⚙  ⛶     │  ← control bar       │
└──────────────────────────────────────────────────────────────────────────┴──────────────────────┘
```

**Control bar**, by convention (left: playback; right: features and view):

| Position | Control | Need |
|---|---|---|
| left | Play/pause (audio unlock on first click) | L2 |
| left | Volume, mute | L2 |
| left | Time / offset: `12:04` with `● LIVE` (red at the edge, grey `−04:30` behind; click to go live) | L4, L5 |
| left | Current chapter name, click opens Chapters in the side panel | L6 |
| right | **CC**: subtitles on/off; long-press or arrow opens the language and style menu | L2, L3, L9 |
| right | **Layout** (⧉): single, split, picture-in-picture, swap | L2 |
| right | **Side panel** (☰): transcript, chapters, glossary, notes | L5, L6, L7 |
| right | **Settings** (⚙): subtitle style, audio description, quality, theme, stats | L9, E2 |
| right | Fullscreen; picture-in-picture of the whole player | L8 |

Controls auto-hide during playback and return on pointer move, focus or tap; in fullscreen the title bar returns with
them.

### 3.2 Sources and layout

The speaker may send several pictures at once; the viewer picks how they are arranged. Options to brainstorm:

| Layout | What | Good for | Cost |
|---|---|---|---|
| **Single** | one source fills the canvas; a switcher picks camera, slides or screen | phones, focus | the other sources are hidden |
| **Split** | two sources side by side, draggable divider (e.g. 30/70) | lectures: speaker + slides | each picture smaller; awkward in portrait |
| **Picture-in-picture** | main source full, the other in a draggable corner window | slides main, face small | the small window covers part of the slide |
| **Swap** | one tap swaps main and secondary in split or PiP | — | — |
| **Auto** | follows the speaker: slides main while slides change, camera main when they stop | hands-off watching | can switch when you don't want it to |

Every layout keeps the subtitle overlay and ink on the right source. Remembered per device.

### 3.3 How the canvas renders (to verify before code)

Live video today is decoded by `@moq/watch` (WebCodecs into a `<canvas>`); rewind plays the archive through HLS
into a media element. So the player has two renderers, and overlays (subtitles, ink, laser) must be **one overlay
layer above both**, on the room clock, not drawn into either. Whether that layer is DOM/CSS, a second canvas, or an
OffscreenCanvas in a worker is decided after the platform research in [§11](#11-before-code-platform-research).

### 3.4 The foundation: every interaction is a track

**Goal (owner, 2026-10-30): a lecture replays exactly as it happened live, with every interaction in it.** So
everything the speaker or a listener does is an event on a track, on the one room clock, and the player has one job:
show the room's state at time `t` from all its tracks. Live is `t` = the edge (SUBSCRIBE); replay is any earlier `t`
(FETCH of the same tracks). Nothing is special-cased for replay.

Every event track uses the model the AI tracks already use ([moq-track-system §4.1–4.2](../design/moq-track-system.md)):
MSF event-timeline records `{"m": <room ms>, "data": …}`, 4 s groups on the room clock, and **object 0 of each group
is the carry-in**: the state needed to draw that moment without reading earlier slices. Seeking to `t` reads group
`⌊t/4 s⌋` and needs nothing else.

| Track | Publisher | Events | Carry-in (object 0) |
|---|---|---|---|
| audio | speaker | Opus media | — |
| camera | speaker | H.264 media | — |
| screen | speaker | H.264 (+ audio) media | — |
| deck | speaker | the slide images, published once (or per slide when first shown) | — |
| slide | speaker | slide shown (deck id, index) | the slide on screen |
| ink | speaker | stroke begin/points/end (tool: pen, highlighter), erase, clear; coordinates as fractions of the slide | strokes still visible on the current slide |
| pointer | speaker | laser positions, sampled about 20 per second while held; laser off | last position or off |
| captions, translation per language, descriptions, outline | agents | as today | as today |
| comments | listeners, via the room service | comment, reply, edit, hide; anchored to slide index and region | open threads on the current slide |
| room | room service | on air, paused, ended | the current state |

Rules that follow:

- **Private stays local.** Speaker notes and the presenter's next-slide view never become tracks.
- **Positions are fractions** of the slide or canvas, never pixels, so they draw the same at any size and in any
  layout.
- **One clock for drawing.** Overlays read the room time of the frame on screen, from whichever renderer is
  playing (live canvas or archive video), so ink lands on the slide it was drawn on, live and in replay.
- **Listeners never hold publish rights to the relay** (decision 0005): comments go to a small room service that
  checks and rate-limits them, then publishes them on the room's comments track.
- **The archive keeps every track**, so a replay is the same tracks read by FETCH, and comments made during a replay
  can be added to the same timeline at the replay's time (a choice to make, §12).

## 4. Features as player features

Each feature: what it is, the need, where it can live (options), its settings, its states.

### 4.1 Subtitles (captions)

The speaker's words, live, in the talk's language.

**Where on screen** (options):

| Option | What | Good | Bad |
|---|---|---|---|
| **A. Overlay, draggable** | on the canvas; press-and-hold (or drag handle) to move anywhere; snaps to safe areas (bottom, top, left/right of a split) | familiar from every player; the listener puts them where they cover nothing important | can cover slide text |
| **B. Strip above the control bar** | a fixed band outside the picture, between canvas and progress bar | never covers slides; steady reading position | takes height; less cinematic |
| **C. A in fullscreen, B in windowed** | — | best of each | two behaviours to learn |
| **D. Beside a split** | in the slide's margin or under the camera tile | uses dead space in split layout | only in split |

**Style** (in CC → Style, previewed live on the canvas as you change it): font family, size (slider plus exact
value), text colour, background colour and opacity, outline or shadow, lines shown (1–3), position reset. Presets:
Default, Large, High contrast (yellow on black), Light box. Remembered per browser. The interim (still-forming) words
show lighter than final ones; an option hides interim words for listeners who find them distracting.

**States:** off; starting (about 1 s); live; behind (`4 s`); nothing said yet ("Subtitles start when the speaker
speaks"); stale (no output for 30 s); capped ("Subtitles paused: the room's budget is reached").

### 4.2 Subtitle language (translation)

Translation is a subtitle language, nothing more.

- **CC menu:** `Original (English)` · `Translate to…` with a searchable list of every language the Muse model
  supports, names shown in their own language (العربية, Türkçe, Español) via `Intl.DisplayNames`.
- **Options:** translation only, or **dual subtitles** (original small above the translation, for learners).
- **Right-to-left** languages render in their own block with `dir="rtl"` and their `lang`; the player UI stays as it is.
- **In the demo:** Arabic, or any language the judge picks.
- **States** as subtitles, plus: "Translating earlier part…" when you rewind past where you turned it on (the agent
  back-fills, [moq-track-system §5.7](../design/moq-track-system.md)); "Earlier translation not available: room
  budget reached".

Architecture consequence: see [§10](#10-what-this-changes-outside-the-ui) (any target language means a translation
track per requested language, created on demand).

### 4.3 Chapters

The YouTube pattern (owner, 2026-10-30: an always-visible chapter strip is not wanted).

- **On the progress bar:** the bar is split into one segment per chapter, with small gaps. Nothing else is shown at
  rest.
- **On hover or scrub:** the preview above the pointer shows the slide thumbnail, the time and that chapter's name;
  the hovered segment grows taller.
- **In the control bar:** `· Breaking into the cell ›` names the current chapter. Clicking it opens the **Chapters**
  list (side panel tab on desktop, a sheet on phones): each chapter with thumbnail, time and summary, the current one
  marked, **So far** (the recap) at the top. Click seeks.
- Chapters grow live: the last segment runs open to the live edge and is renamed as the outline agent revises it.

### 4.4 Slides and drawing on them

- The speaker runs their own deck: they move through it however they like, and only the slide they show is
  published. **Speaker notes stay on the console** (presenter view) and are never published.
- Slides are a **source** in the layout (§3.2), sharp images, not video frames.
- **Ink** from the speaker (pen, highlighter, eraser, clear) and the **laser pointer** draw on the slide as an
  overlay, on the room clock, so they rewind with everything else.
- **Slide descriptions** (for listeners who can't see the slide) are an **audio description** feature: Settings →
  Audio description → Read aloud (browser voice, ducks the speaker's audio) and/or Text (under the slide or in the
  side panel). Screen readers get each new description once, politely.
- Slide changes are marks on the progress bar; hovering one shows the slide thumbnail.

### 4.5 Seek, rewind, live

- DVR like a live stream player: drag the progress bar anywhere in the room's history; thumbnails while seeking;
  `● LIVE` greys and shows `−04:30`; click it (or press `G`) to go live.
- Holes where nobody broadcast are drawn as gaps.
- Media unavailable for a stretch: text features still rewind alone and the canvas says so.
- **What you missed:** after going live, returning to the tab after more than 2 min, reconnecting, or joining late,
  a small notice above the progress bar: "You missed 4:30 · 2 chapters" with **Show** (opens Chapters at that
  stretch) and **Transcript** (opens it there). Options to discuss: notice / nothing / a brief recap line from the
  outline.

### 4.6 Side panel

Tabs: **Transcript · Chapters · Glossary · Notes**. Collapsible; on desktop beside the player, on phones below it.

- **Transcript:** follows live; scrolling up stops following and shows **Jump to latest**; times seek; dual columns
  when a translation is on; search (`/`) with matches marked on the progress bar; glossary terms underlined with a
  definition popover and "first mentioned at 03:12".
- **Chapters:** list with summaries; So far on top.
- **Glossary:** terms A–Z with definitions and first mention.
- **Notes:** bookmarks (`B`, a mark on the progress bar) and typed notes stamped with time and slide; kept in the
  browser; Markdown export.

### 4.7 Settings menu (⚙)

Subtitle style · Audio description · Quality (when video) · Layout defaults · Theme (system, light, dark) ·
Keyboard shortcuts · **Stats for nerds**.

### 4.8 Stats for nerds (the judge's view)

A translucent panel over the canvas, the way video players show playback stats, opened from Settings or a
right-click on the player. Per track: producing or idle, subscribers, delay, FETCHes served by the agent vs by the
relay cache, back-fills, spend against the cap; plus the connection (WebTransport or WebSocket fallback, round-trip
time). In demo rooms it can carry the four moments as a short checklist ([demo-moments.md](../howto/demo-moments.md)).

### 4.9 Comments on slides (polish layer, after the foundation)

The education version of live-chat replay: listeners mark a spot on a slide and comment on it, the way comments
sit on a shared document, and a replay shows each comment at the moment it was made.

- **Make one:** select text on the slide or drag a box over a region (or press `M` for the whole slide); a small
  composer opens beside it, with the time and slide filled in. A display name is asked once per browser; no account.
- **On the slide:** a highlight on the anchored region with a count badge. Nothing else, so the slide stays
  readable. Hover or focus shows the first line; click opens the thread.
- **Discussion** tab in the side panel: threads in time order, each with its anchor thumbnail and time; replies open
  and close; the speaker's reply shows first under a question. Filters: this slide, questions, newest; search over
  all comments, not only the loaded ones.
- **Replay:** comments appear at their room time, as live chat does in a stream replay. Threads that continued after
  that moment show "3 later replies" rather than the future replies themselves.
- **Speaker side:** questions collect on the console per slide, as a count on the slide thumbnails and a list the
  speaker can open when they pause for questions. Never pop-ups during the talk.
- **Off switch:** Settings → Comments: show on slides / Discussion tab only / off.
- **Moderation:** the speaker can hide a comment; hidden comments stay out of replays.

Options to brainstorm: comments anchored to a slide region only, or also to a moment in the talk without a slide
(a "timed comment" on the progress bar); whether listeners can react (+1) to a question so the speaker sees the top
ones; whether a comment made while rewound anchors to the playhead time or to now.

### 4.10 Keyboard

Space or K play/pause · ←/→ 5 s · J/L 10 s · G go live · C subtitles · `[` `]` subtitle size · S side panel ·
F fullscreen · B bookmark · N note · `/` search · `?` shortcuts. Visible focus, a skip link to the player, every
control reachable without a pointer.

## 5. Player states

| Room | Time display | Canvas |
|---|---|---|
| Connecting | — | title card |
| Not started | `Not started` | "Starts when <speaker> goes on air." Features can be set now. |
| Live | `● LIVE` red | sources |
| Behind | `−04:30` grey | sources at the playhead |
| Paused by speaker | `Paused` | last frame dimmed, announced |
| Ended | duration | full recording, seekable |
| Looped demo | `● LIVE · Session 3` | sources; credit in the title |
| Reconnecting | `Reconnecting…` | last frame; nothing cleared |
| Failed | `Offline` | "Lost the connection. Try again" |
| Slower path (WebSocket) | `● LIVE · ~3 s` | — |

## 6. Phone

- Portrait: player on top (16:9, sticky), control bar inside it; subtitles overlay by default (drag still works with
  a long press); chapter strip collapses to marks on the progress bar; side panel tabs below the player.
- Layout on a phone: Single or PiP; split only in landscape.
- Landscape: fullscreen player, controls on tap.
- Touch targets at least 44 px; CC and layout within thumb reach (bottom right).
- On iPhone (WebSocket path) the time display reads `● LIVE · ~3 s` with the measured delay.

## 7. Speaker console

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│ Speaking in physics-101                                   ● ON AIR 23:41   [End talk]     │
├───────────────────────────────┬───────────────────────────────────────────────────────────┤
│ Sources                       │  What viewers see (preview)                               │
│ 🎤 Mic  ▁▃▅▇▅▃  MacBook ▾ [on]│  ┌─────────────────────────────────────────────────────┐  │
│ 📷 Camera  FaceTime ▾     [on]│  │   slide 7                          ┌──────┐         │  │
│ 🖥 Screen  (not sharing) [Share]│ │                                    │ cam  │         │  │
│ 🗂 Slides  deck.pdf   [Change]│  │                                    └──────┘         │  │
│                               │  └─────────────────────────────────────────────────────┘  │
│ Invite                        │  ✎ Pen  ▭ Highlight  ⌫ Eraser  ● Laser  ✕ Clear           │
│ physics-101   ▣ QR            │  ◂ prev   7 / 24   next ▸      next: [thumb]               │
│ [Copy link] [Show full screen]│                                                           │
├───────────────────────────────┴───────────────────────────────────────────────────────────┤
│ Audience 42 · Subtitles 31 · Arabic 6 · Turkish 2 · Audio description 2 · Chapters 12      │
│ Spend $0.42 of $5.00 ▓▓░░░░░░░░                                       alerts only when due │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

**Sources to brainstorm:**

| Source | What it sends | Notes |
|---|---|---|
| Microphone | audio | required; the captions' input |
| Camera | video | +1–2 Mbit/s per viewer; transcoding risk on the VM; console shows a self-view |
| Slides | slide images + slide-change events | upload PDF or images; sharp images, not video |
| Ink and pointer | pen, highlighter, eraser, clear, laser positions, as events on the slide | small data; replays and rewinds exactly; a new track type |
| Screen share | another video + optional audio | a demo or a code editor; `getDisplayMedia`; another video track |

- **Before going on air (S1):** check state: mic level ("say something"), camera self-view, slides loaded, preview
  of what viewers see; one primary button, **Go on air**. Missing mic or refused permission is explained with what
  to do. Expired or missing token: says so and how to get a new link.
- **On air (S3):** unmissable on-air bar and timer; slide keys (arrows, Page Up/Down, presenter clickers); ink tools
  on the preview; laser follows the pointer while held.
- **Presenter view:** current slide, next slide and the speaker's own notes, which never leave the console. The
  speaker can jump anywhere in the deck; listeners see only the slide shown.
- **Invite (S2):** room name large, QR, copy link, **Show full screen** to project.
- **Audience (S4):** counts per feature, spend against the cap, alerts only when something needs action (a feature
  stopped, 80 % of cap, connection dropped).
- **End (S5):** Go off air pauses; End talk asks once, then shows what is kept and the room link.

## 8. Lobby

One way in (room name or pasted link; a QR opens the room directly); the demo lectures as cards with their live
state and credit; "Continue <last room>" for returning listeners; "Paste your speaker link" for speakers; a short
"How it works".

## 9. Visual language

Calm graphite neutrals, light and dark from the system with a toggle; red only for LIVE and on-air; amber for
degraded; every state also has a word. Astryx for standard controls; the canvas, overlays, chapter strip and
progress bar are our own. Motion only for cause (controls fading, playhead gliding to live), off under reduced
motion. WCAG 2.2 AA in both themes, 200 % text, 44 px touch targets.

## 10. What this changes outside the UI

For the coordinator to route to the lanes; none is decided.

| Change | Why | Lanes |
|---|---|---|
| Translation to **any** Muse-supported language | the subtitle language list is open, not tr/es/ar | agents (a lazy translate track per requested language, named by BCP 47 tag), contracts, caps; decision 0014 revisited |
| Demo rooms with arbitrary languages | judges may pick any language | demo rooms are pre-generated and never back-fill (moq-track-system §5.7); a new language there means live translation with spend |
| **Camera** video from the browser | the speaker's face in split/PiP | speaker console, relay bandwidth, archive (audio+video rooms already handled) |
| **Ink and laser** events | drawing on slides that rewinds | a new track and payload in `contracts/`, archive |
| **Screen share** | demos, code | another video (and audio) track, catalog, archive |
| Several pictures per room | layouts | room catalog lists sources; viewer subscribes per visible source |
| deck, slide, pointer tracks | slides the speaker drives, laser replay | `contracts/`, speaker console, archive |
| Comments track and room service | listener comments without listener publish rights | new small service on the VM, `contracts/`, rate limits, moderation |

## 11. Before code: platform research

The owner's rule: before any canvas or overlay code, read the official docs (MDN, and the specs they link) and build
against them. Reading list for the build lane, each with the question it answers:

| API | Question |
|---|---|
| `OffscreenCanvas`, `HTMLCanvasElement.transferControlToOffscreen()` | can overlays (ink, laser, subtitles) render in a worker without blocking the main thread? |
| Web Workers, `postMessage` transfer, `SharedArrayBuffer` (COOP/COEP is already on) | how overlay events and frames reach a worker cheaply |
| WebCodecs (`VideoDecoder`, `VideoFrame`) | how `@moq/watch` draws live video, and whether a frame clock is exposed for sync |
| `HTMLVideoElement.requestVideoFrameCallback()` | per-frame timing for the HLS archive path, to keep overlays on the same clock |
| `TextTrack`, `VTTCue`, `::cue` | can native subtitle rendering work over a canvas (it can't over a canvas; confirm) or do we render our own? |
| Pointer Events, `setPointerCapture()` | drag-to-position subtitles and the PiP window; ink capture in the console |
| Fullscreen API, Picture-in-Picture, Document Picture-in-Picture | fullscreen with overlays and side panel; PiP of a canvas player |
| Media Session API | play/pause and title from the OS and lock screen |
| `getUserMedia`, `getDisplayMedia` | camera and screen share in the console |
| Web Speech `SpeechSynthesis` | Read aloud for audio description; voices per language |
| `Intl.DisplayNames`, `dir`, `lang` | language names in their own script; RTL subtitle blocks |
| `ResizeObserver`, container queries | overlay positions as fractions of the canvas, kept through resize and layout changes |

## 12. Open questions (brainstorm)

1. ~~Subtitle placement~~: settled, overlay the listener can drag (decision 0017).
2. ~~Chapter strip~~: settled, the YouTube pattern (§4.3).
3. Default layout when slides and camera are both on: split, PiP, or auto (§3.2).
4. ~~Speaker sources~~: settled, microphone, camera, slides with ink and laser; no screen share (decision 0018).
5. What you missed: notice, nothing, or recap line (§4.5).
6. ~~Translation languages~~: settled, any language the model supports (decision 0019).
7. Comments made while watching a replay: added to the talk's timeline at the replay time, kept per replay, or not
   allowed (§3.4, §4.9).
8. Deck input: PDF only (rendered to images in the console) or also images; PowerPoint and Keynote export to PDF.

## 13. Precedents used

From the Juxtopposed case catalog (one designer's video redesigns, mostly proposals; credit the videos when
showing case material). Kept only where the stated reason holds here.

| Decision here | Case | Their reason | Why it transfers |
|---|---|---|---|
| CC and settings at the bottom right of the bar | VLC subtitle button bottom right (vlc-12); fullscreen and settings right (vlc-05) | most people look for it there; most players do | our listeners know other players; same expectation |
| Subtitle style changed while watching, previewed on the canvas | VLC subtitle styling in the playback sidebar (vlc-21); video filters need a preview (vlc-26) | viewers thought exact sizes were missing because they were hidden; you need to see what you're doing | captions are tuned by eye on the picture they sit on |
| Size as a slider plus exact value | VLC subtitle timing sliders (vlc-20) | a slider is easier than typing | the same tuning by eye; exact value kept for those who want it |
| Keep a reset, and preview, so the canvas can't become unusable | Minecraft GUI scale applied live can make the UI unreadable (mc-39) | live changes that break the screen harm accessibility | maximum subtitle size can cover the slide |
| Chosen subtitle language remembered | VLC default subtitle track saved in the preset (vlc-23) | the setting was hard to find and reselected every time | a non-native listener picks the same language every talk |
| Dual subtitles, original kept | Wikipedia AI translation beside the official page (wiki-21); Spotify translated lyrics (spotify-37) | not stated; potential | weak (no stated reason); kept because learners need the original's terms |
| Seek thumbnails | VLC (vlc-09) | not stated; can't see where you seek | slide thumbnails tell a listener where a topic was |
| Title returns with the controls in fullscreen | VLC (vlc-10) | people look at the top for the title | which talk and speaker, without leaving fullscreen |
| Side panel beside the player, never over it | VLC settings as a right sidebar (vlc-19); YouTube chat panel in fullscreen (youtube-29) | the video stays visible; no leaving fullscreen | a live talk can't pause for reading |
| Stats for nerds as an opt-in overlay | Minecraft optional HUD info instead of the debug screen (mc-27) | the dense screen is too much for the everyday need | students never need it; judges get it one step away |
| Each automatic feature has its own on/off | Spotify DJ gets its own controls and off (spotify-46) | it needs its own controls | AI outputs are automatic and cost money while on |
| Phone has every feature; layout its own | parity moves (discord-13, youtube-41); separate layouts, unified style (mc-49) | the other platform has it / not stated | iPhone is a main path (WebSocket), not an edge case |
| QR to open the room on a phone | Realtime Colors QR tab (rcv2-14) | see it on other devices quickly | the audience joins from a projected screen |
| Comments as threads that open and close; the speaker's reply shown first | YouTube threads (youtube-23); creator's first reply under the comment (youtube-24) | follow who replies to whom; the reply is easier to find than a marker | a question and the speaker's answer are what a student scans for |
| Search over all comments, not only loaded ones | YouTube comment search (youtube-25) | browser search misses unloaded replies | a replay loads comments slice by slice; same gap |
| Comments as a highlight and count on the slide, thread in the panel; an off switch | YouTube timed comments that spoil the video, left open (youtube-34) | timed comments shown with the section closed can spoil; an icon may hide key comments | in a lecture the cost is distraction, not spoilers; a badge keeps the slide readable without hiding questions |
| Discussion as a side-panel tab beside Transcript | YouTube live chat with tabs for transcripts (youtube-26) | the chat is hard to follow in little space | a lecture discussion needs room but must not cover the slide |
| Bookmarks in one key, listed in the panel with chapters | VLC quick bookmarks and a bookmark timeline (vlc-38) | easier to create and see them all | a student marks a moment without looking away |

**No precedent in the catalog** (designed from the brief): screen-reader announcements, connection and loading
states, RTL subtitle blocks, ink and laser on slides, multi-source layouts, console audience counts, and comments
anchored on shared content (the catalog lists multi-user collaboration as not covered).

## 14. Build plan (agreed 2026-10-30)

Foundation first, polish on top. Each row is one lane agent in its own worktree ([team.md](../team.md)); the
coordinator briefs, merges and deploys. Contracts land first because every other lane reads them.

| Lane | Goal | Owns | Depends on | Done when |
|---|---|---|---|---|
| **Event track contracts** (first, about half a day) | The new tracks of §3.4 have models and schemas. | `contracts/`, the Python models, `web/src/contracts/` types | — | deck, slide, ink, pointer, comments and room records exist as MSF event-timeline records with carry-ins; the room catalog lists sources (camera, screen, slides); schemas generated; validators tested. |
| **Player** | The viewer is the media player of §3–§4.8. | `web/src/player/` (new), viewer pages | contracts (can start on stubs); its first step is the platform research of §11, written up as a decision on how overlays render | control bar, progress bar with YouTube-style chapters, CC menu with language search and style, drag-to-position subtitles, layouts, side panel, one overlay layer on the room clock that draws slides, ink and pointer live and in rewind; desktop and phone; web checks pass. |
| **Speaker console** | The console of §7. | `web/src/speaker/`, the talk page | contracts | mic and camera (no screen share, decision 0018); a PDF deck rendered to slide images; presenter view with private notes; pen, highlighter, eraser, clear and laser published as tracks; pre-flight check; invite with QR. |
| **Event track archive and replay** | Speaker event tracks are archived and served by FETCH like the AI tracks. | archive service, `deploy/` | contracts | a recorded talk replays slides, ink and pointer in sync with the media; looped demo rooms carry slide tracks. |
| **Any-language translation** | Subtitles in any language Muse supports. | `agents/` translate, catalog | — | a lazy translation track per requested BCP 47 tag, created on first subscribe, capped by the room's spend. |
| **Comments** (polish, after the foundation) | §4.9. | a room service, `web/src/player/` discussion tab | contracts, player, archive | listeners comment on slide regions through the room service; threads, replay at their time, speaker hide. |

Checks per lane, once on its final change set: web lanes run typecheck, lint, test and build for `web/`; agent
lanes run pytest, ruff and pyright for `agents/`. Only the coordinator runs the full gate before merging.

**Risk:** five lanes in about three days before the end-to-end checks on Nov 2. If time runs short, cut in this
order: comments, any-language translation (keep tr/es/ar), camera. Lane briefs:
[lane-briefs §Foundation lanes](../design/lane-briefs.md#foundation-lanes-2026-10-30).
