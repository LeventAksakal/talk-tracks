# Demo video script: one live lecture, three points of view

The final script for the 3-minute submission video, beat by beat. The runbook for the night (setup, rehearsal,
takes, the DaVinci edit, export, upload) is [howto/demo-video-shoot.md](howto/demo-video-shoot.md); the storyboard
frames are in [howto/demo-video-shoot/](howto/demo-video-shoot/).

**Length: 2:49.** Judges stop at 3:00; the 11 s left over are the buffer. The voice-over (VO) is **351 spoken
words, 140 s of speech at 150 words a minute, inside 169 s**: every beat's words fit at that pace with time to spare,
and the spare seconds are where the speaker's own voice and the screens carry the beat. Each beat lists its word
count and the seconds those words take at 150 wpm.

**Story order:** impact first (a lecture anyone follows live in their own language, beats 2–4), then Meta's models
at work in the terminal (5–6), then what it does for a viewer (7–8), then the technical depth in one beat (9), then
the recording and the end (10–11).

**The rules this cut answers** ([workstreams/07-submission.md](workstreams/07-submission.md#the-rules-checked-2026-11-02)):
under 3:00; in English; the working product, never slides about it; only what was built from Oct 27; the opening
line says what pre-existed; the end-to-end flow with live Meta calls visible (the terminal band from beat 3 on);
submitted as a link; an AI voice-over is allowed.

## Languages and voice (decided, ticket 0026)

The owner chose the recommendations of [which languages and whose voice (ticket 0026)](../tickets/0026-demo-video-languages-and-voice.md):
the viewers pick **their own languages**, for example **Turkish** (viewer 1) and **Japanese** (viewer 2), and the
voice-over is **the owner's own voice**, recorded after the shoot. If a friend speaks something else, swap that
language's name wherever it appears; the word counts do not change. Friends type the first three letters with a
capital first, **Tur**, **Jap** (why: [the typing trap](#the-typing-trap-in-the-language-search)).

## Who and what is filmed

| Source | Who | What it records | Storyboard |
|---|---|---|---|
| **S** speaker POV | the owner | the speaker console window (OBS), his mic on its own track: the master audio | [b02-speaker-console](howto/demo-video-shoot/b02-speaker-console.jpg) (pre-flight; on air it shows the live stage) |
| **V1** viewer 1 POV | friend 1 | her Chrome, full screen, on `/watch/<room>`; picks Turkish | [b03-subtitles-picked](howto/demo-video-shoot/b03-subtitles-picked.jpg) |
| **V2** viewer 2 POV | friend 2 | his Chrome, full screen, on `/watch/<room>`; picks Japanese, rewinds | [b04-second-language](howto/demo-video-shoot/b04-second-language.jpg) |
| **T** terminal | the owner's laptop | `meta-calls.py --room <room> --width 110` over ssh, recorded as a window | [b05-terminal-band](howto/demo-video-shoot/b05-terminal-band.jpg) (mock lines) |
| **R** screen recording | the owner's browser, after the talk | the ended room as a recording, Turkish on | [b10-recording](howto/demo-video-shoot/b10-recording.jpg) |
| **P** phone camera | owner's phone on a stand (and, if they can, a friend's selfie) | people: the owner speaking at his desk; a friend reading her subtitles | described in beats 1 and 3 |

If only one friend can come, [the alternate cut](#the-alternate-cut-one-viewer-or-none) keeps every beat.

## What the viewers must switch on before the talk starts

Every AI track is lazy: it runs only while someone has it open. Three of them have to be opened **before** the
speaker reaches the moment that needs them, or that moment has nothing to show:

| Who | Opens, before the speaker starts | Without it |
|---|---|---|
| V1 | side panel (**S**) → **Chapters** → **Slides** | no slide description in beat 6 (the describe agent never starts) |
| V2 | side panel (**S**) → **Chapters** → **Chapters** | no chapters, glossary or recap in beat 8 |
| both | subtitles stay **Off** until their beat | the language pick (beats 3–4) would already be done |

Check in the rehearsal with **I** (stats for nerds): V1's row *Slide descriptions* and V2's row *Chapters, glossary
and recap* must say **on**. The live panels say "Starting from now: the chapters fills in as the talk goes" until the
first revision lands.

## Waits measured on the live site (11-03), and what the cut does with them

| Action | Measured | Beat allows | Plan |
|---|---|---|---|
| Open a room until the player runs | 1.7–2.4 s | off screen | open before the take |
| **Live:** pick a language until its first subtitle | **7–12 s** (11-03, a picked language in a live room) | 20 s, beat 3 | cut on the wait: hold the click, jump cut to the first line with a small "8 seconds later" tag |
| Recording: pick a language at a part already made | 0.97–1.0 s (this run); 3.2–3.8 s the first time | — | — |
| Recording: seek to a part already made | **0.24–0.27 s** | 10 s, beat 10 | play a part that was translated live during the talk |
| Recording: seek to a part not made yet | **13–21 s** (two runs) | — | never on camera: pick the language before seeking, and seek only into the watched part |
| Live: rewind 30 s (**J** ×3) until the picture runs | 0.46–0.53 s | 20 s, beat 7 | no cut needed |
| Live: **Go live** until the picture runs | 0.21–0.23 s | — | no cut needed |
| Recording: Chapters tab to its list | 0.1 s | — | (a recording's chapters exist) |
| Live: first chapters revision | 1–2 min of talk (runbook estimate) | — | V2 opens Chapters before the talk; beat 8 is shot after 3:00 of talk |
| Live: slide description after a page turn | 5–15 s (runbook estimate) | 17 s, beat 6 | V1's Slides view is open already; cut on the wait |
| Stats for nerds (**I**) | instant | — | — |

Measured with the storyboard script, muted headless Chromium at 1920×1080, on `dataviz` (live session) and
`dataviz-recording`; the raw numbers are in [timings.json](howto/demo-video-shoot/timings.json). The live
language-pick wait is the 11-03 measurement from the brief; this lane picked languages only in a recording room.

### The typing trap in the language search

On the 11-03 build the player's keys still fire while **Search any language** has focus: a lowercase **k** or a
**space** pauses the talk, a lowercase **j** jumps 10 s back (measured: typing `Turk` paused at the k; typing `jap`
jumped from 0:06 to 0:00). Typed with a capital first letter, three letters are safe and enough to leave one match:
**Tur**, **Jap**, **Spa**, **Ara**. If the player lane fixes it before the shoot, typing anything is fine; the
friends' message says "type Tur" either way.

## The opening line

> "Talk Tracks was built this week, from the first commit on October 27th: the AI agents, the track model, the
> speaker console and the player. Not ours: the open-source MoQ relay, the player controls, and Meta's models."

The facts behind it, checked on 2026-11-03: first commit `8321f2b`, 2026-10-27 12:13 +03; every commit since is
inside the building period (Oct 26 – Nov 4); before the event there were feasibility measurements and notes, no code
(README, *Built during the hackathon*). Pre-existing, used under their licences ([NOTICE](../NOTICE)): moq-relay and
the `@moq/*` browser libraries, aiomoqt, Media Chrome, hls.js, PDF.js, perfect-freehand, PyAV, the fonts; Meta's
models (Muse Voice Transcribe, Muse Spark); the four EMF 2026 demo lectures (CC BY-SA 4.0).

## The lecture the owner gives

A short talk he really gives, 5–6 minutes on the clock, with his own 4-page PDF (his own text and drawings, no
third-party images). Every caption and translation comes from it, so he speaks in **full, plain sentences**, pausing
a beat between them (a translation is made per finished caption line). A topic he knows well; the page that matters
is page 3, **a diagram** (beat 6). Lines that make good on-screen captions, used as cues below:

- p1, opening: "Today I want to show you how one lecture can reach people who don't share its language."
- p2: "Every AI job in this talk is its own track, and you pick the tracks you need."
- p3, the diagram: "This diagram shows the speaker, the relay, and the agents that listen." (draws a circle on it)
- p4, close: "Thank you for listening. The recording stays online with every track."

## Beats

Timecodes are the final cut. On the shoot the talk runs about six minutes and every beat is cut from it; the **talk
clock** (T+m:ss, from the clap) says when each action happens during the take, so the friends can follow their own
stopwatch. Spoken words are timed at 150 words a minute.

---

### 1 · 0:00–0:17 · The opening line

**Frame:** [b01-title.jpg](howto/demo-video-shoot/b01-title.jpg) for 0:00–0:03, then the phone camera.

- **Spoken (VO, 38 words, 15.2 s; "27th" said as "twenty-seventh"):** "Talk Tracks was built this week, from the first commit on October 27th: the AI
  agents, the track model, the speaker console and the player. Not ours: the open-source MoQ relay, the player
  controls, and Meta's models."
- **On screen:** the title card (0:00–0:03), then **P**: the owner at his desk with the laptop, mid-sentence, the
  console on the screen behind him (0:03–0:10); then a 1 s glimpse each of V1 and V2 screens with the player
  running (0:10–0:17). Lower third at 0:04: *Talk Tracks · built Oct 27 – Nov 4*.
- **Source:** title card, **P**, then V1 and V2 (any second of the take before beat 3's pick).
- **On camera:** nothing to do; the phone runs from before the clap.
- **Can go wrong → fallback:** no phone footage, or it is shaky → hold the title card to 0:06, then S full frame.

### 2 · 0:17–0:29 · A live lecture, and who it leaves out

**Frame:** [b02-speaker-console.jpg](howto/demo-video-shoot/b02-speaker-console.jpg) (pre-flight; on air the stage
shows his slide and camera, the pill says *On air*) and [b02-viewer-live.jpg](howto/demo-video-shoot/b02-viewer-live.jpg)
(a viewer of a live room).

- **Spoken (VO, 27 words, 10.8 s):** "A live lecture usually reaches only the people who speak its language. I'm giving
  one now, from my browser; two friends are watching on their own laptops."
- **Under it:** the owner's own voice at −20 dB, saying the p1 line, so the judges hear a real talk.
- **On screen:** **S** fills the top 1440×810 (the console on air, page 1); the right column 480×810 holds V1 above
  V2, small; no terminal yet.
- **Source:** S (talk clock T+0:05–0:20), V1 and V2 insets from the same seconds.
- **On camera:** the owner speaks the p1 line, looks at the camera, does not touch anything.
- **Can go wrong → fallback:** the console did not reach *On air* on the first try → use the second take; never show
  a reload. Speaker link or token visible anywhere → the console is an app window (no address bar), so this should
  not happen; if it does, blur.

### 3 · 0:29–0:49 · She picks Turkish

**Frames:** [b03-search-language.jpg](howto/demo-video-shoot/b03-search-language.jpg) (the menu, *Tur* typed, one
match) → [b03-subtitles-picked.jpg](howto/demo-video-shoot/b03-subtitles-picked.jpg) (Turkish over the stage, and
beside each line in the transcript).

- **Spoken (VO, 39 words, 15.6 s):** "My friend opens the subtitles and types Turkish. Nothing was translating into
  Turkish until this click. Now a Muse Spark agent starts a Turkish track for this room, and seconds later she
  follows the lecture in her own language."
- **On screen:** **V1** fills the top; terminal band fades in along the bottom (1920×270) at 0:35 showing
  `captions … turn` lines; right column: the speaker small. When the first `translate tr` line prints, a soft box
  on it for 1 s. Under the Turkish subtitle, an English caption of the same line (V7 text track): *"Every AI job in
  this talk is its own track."* so judges see what was translated.
- **Source:** V1 (talk clock T+0:30–1:00), T (same seconds), P optional: a 2 s shot of friend 1's face reading.
- **On camera (V1), click by click:** move the mouse over the player → click **CC** (bottom right of the dock) →
  click in **Search any language** → type **Tur** (capital T) → click **Türkçe · Turkish** → move the mouse off the
  player and wait. Do not touch anything until the Turkish line has been on screen for 5 s.
- **Wait:** 7–12 s until the first Turkish line (11-03). **Cut on the wait:** keep 2 s after the click, jump cut to
  the first Turkish line with a small *8 seconds later* tag (or the real number), and let the VO run over the cut.
- **Can go wrong → fallback:** nothing after 20 s → look at the terminal: `translate tr` lines but no subtitle →
  she reloads and picks again (re-shoot the beat at T+1:00); `refused, $0` → pick Spanish and change the VO;
  no line at all → the agent is not serving the room (runbook, *If something fails*). The player paused when she
  typed → she typed a lowercase k or a space; press play, use the next take or re-shoot the pick.

### 4 · 0:49–1:03 · He picks Japanese: one sentence, two languages

**Frame:** [b04-second-language.jpg](howto/demo-video-shoot/b04-second-language.jpg).

- **Spoken (VO, 28 words, 11.2 s):** "My second friend picks Japanese. Same sentence, two languages, at the same time.
  Any of fifty languages works, and each one is made only while someone watches it."
- **On screen:** split screen, V1 left and V2 right (each cropped to 960×810 around the stage and subtitles), the
  terminal band below with `translate tr` and `translate ja` lines interleaving; one English caption above both:
  the sentence they share.
- **Source:** V1 and V2 from the same seconds (talk clock T+1:00–1:30), T.
- **On camera (V2):** CC → **Search any language** → type **Jap** (capital J) → **日本語 · Japanese** → hands off.
- **Wait:** 7–12 s, as beat 3; cut on the wait the same way. Then find a moment where the same English line is on
  both screens (sync on the clap makes this exact).
- **Can go wrong → fallback:** Japanese weak or refused → Korean or Arabic (change one word). No V2 → [the
  alternate cut](#the-alternate-cut-one-viewer-or-none).

### 5 · 1:03–1:26 · Meta's models at work

**Frame:** [b05-terminal-band.jpg](howto/demo-video-shoot/b05-terminal-band.jpg) (the layout; its terminal lines
are a mock).

- **Spoken (VO, 53 words, 21.2 s):** "This terminal prints every Meta model call as it happens. Muse Voice Transcribe
  turns my voice into captions. Each caption line goes to Muse Spark once per language, with the lines before it
  as context. A line costs a fraction of a cent; a whole twenty-minute lecture, about fourteen cents per language."
- **On screen:** **T** grows: the terminal takes the bottom half (1920×540, about 12 lines), V1 and V2 side by side
  above it (960×540 each). Three highlights, 1 s each, in order with the VO: a `captions … turn` line, a
  `translate tr` line with its `"English" → "Turkish"` snippet, its `$0.0004` cost.
- **Source:** T (talk clock T+1:00–1:40), V1, V2.
- **On camera:** no action; the owner keeps lecturing (p2 line).
- **Can go wrong → fallback:** the terminal shows nothing → it was started without the right `--room`, or the ssh
  dropped; restart it before the next take (the runbook's pre-take check). Lines too small to read → zoom the
  terminal clip to 150 % on the highlighted line (Resolve *Transform → Zoom*) instead of the full band.

### 6 · 1:26–1:43 · A slide described for someone who cannot see it

**Frames:** [b06-terminal-describe.jpg](howto/demo-video-shoot/b06-terminal-describe.jpg) (layout, mock lines) and
[b06-slide-descriptions.jpg](howto/demo-video-shoot/b06-slide-descriptions.jpg) (the Slides view with a real
description).

- **Spoken (VO, 30 words, 12 s):** "When I turn to a new slide, Muse Spark looks at it and writes a description: a
  text alternative for anyone who can't see the slide, read aloud on request."
- **On screen:** 1:26–1:30 **S** full: the owner turns to page 3 and draws a circle with the pen. 1:30–1:43 **V1**:
  the side panel's *Slides* view, the new description at the top; terminal band below with the `describe slide`
  line highlighted.
- **Source:** S (talk clock about T+2:00), V1 and T 5–15 s later.
- **On camera:** owner: **Next** to page 3, pick **Pen**, draw one circle round the diagram's centre, say the p3
  line. V1: nothing (the Slides view is already open, from before the talk).
- **Wait:** 5–15 s from the page turn to the description. **Cut on the wait:** from the pen stroke straight to the
  description arriving.
- **Can go wrong → fallback:** no description after 30 s → V1's Slides view was not open (stats: *Slide
  descriptions off*); open it and turn the page again in the next take. As a last resort, use
  [b06-slide-descriptions.jpg](howto/demo-video-shoot/b06-slide-descriptions.jpg)'s source, `dataviz-recording`'s
  Slides view, and change the VO's "When I turn" to "When a speaker turns".

### 7 · 1:43–2:03 · Missed something? Rewind, and the terminal stays quiet

**Frame:** [b07-rewound.jpg](howto/demo-video-shoot/b07-rewound.jpg) (thirty seconds back: the pill says
*−0:31 · Go live*).

- **Spoken (VO, 42 words, 16.8 s):** "Missed something? My friend jumps back thirty seconds: the slide, my pen strokes
  and the Japanese subtitles replay exactly as they were. Watch the terminal: rewinding made no new model call.
  The past comes from the same tracks, cached by the relay."
- **On screen:** **V2** fills the top, the terminal band below. As V2 rewinds, a soft box around the terminal band
  with a small label *no new calls* while it stays still (the captions keep printing for the live talk; that is
  fine, there is no `translate ja` line for the past). Then **G** and the pill turns red again.
- **Source:** V2 (talk clock about T+3:00), T.
- **On camera (V2), click by click:** click once on the stage (focus the player, not a field) → **J J J** → wait 8 s
  while the circle and the Japanese subtitles replay → **G** (back to live).
- **Wait:** 0.5 s to rewind, 0.2 s to go live (measured); no cut needed.
- **Can go wrong → fallback:** J did nothing → the focus was in a field; click the stage first. A `translate ja`
  line appears during the rewind → it is the live talk's next line, not the past; cut before it or trim the band.

### 8 · 2:03–2:13 · Chapters, a glossary and a recap

**Frame:** [b08-chapters.jpg](howto/demo-video-shoot/b08-chapters.jpg) (a recording's Chapters view; the live one
fills in as the talk goes).

- **Spoken (VO, 22 words, 8.8 s):** "Muse Spark also keeps a running outline: chapters, a glossary and a recap of what
  you missed, revised as the talk goes."
- **On screen:** **V2** with the side panel on **Chapters**: the list, then **Terms** for 2 s; terminal band with a
  `chapters … N chapters, M glossary terms · latest: "…"` line highlighted.
- **Source:** V2 (talk clock T+3:30 or later), T.
- **On camera (V2):** the Chapters tab is already open → click **Terms** → after 2 s click **Chapters** again.
- **Can go wrong → fallback:** no chapters yet → V2 did not open Chapters before the talk; use the later take or
  cut this beat (its 10 s go to beat 9's pause).

### 9 · 2:13–2:35 · Under the hood

**Frame:** [b09-stats.jpg](howto/demo-video-shoot/b09-stats.jpg) (stats for nerds: WebTransport, the tracks on and
off).

- **Spoken (VO, 50 words, 20 s; "Media-over-QUIC" counted as three):** "Under the hood, every AI job is its own Media-over-QUIC track. Agents are lazy:
  they work and pay only while someone subscribes. Hardest bug this week: fifty lazy languages made the relay's
  announcements use up each agent's QUIC stream credit, so requests stalled silently; we raised the credit."
- **On screen:** **V1** presses **I**: stats for nerds over the stage (connection *webtransport*, each track *on* or
  *off*, the lazy ones listed as off). Zoom 140 % onto the stats box (2:15–2:25), then pull back; the terminal
  band keeps scrolling below.
- **Source:** V1 (talk clock about T+4:00), T.
- **On camera (V1):** click the stage → **I** → hold 12 s → close it (×).
- **Can go wrong → fallback:** the stats box covers the subtitles in a way that reads badly → use
  [b09-stats.jpg](howto/demo-video-shoot/b09-stats.jpg)'s source room (`dataviz`) as a 4 s insert. The bug sentence
  is the one technical claim: it comes from [howto/deploy.md](howto/deploy.md) (the relay held one agent stream per
  advertised namespace, about 470 against aiopquic's default credit of 512; the VM now sets 16384).

### 10 · 2:35–2:45 · The talk ends; it stays as a recording

**Frame:** [b10-recording.jpg](howto/demo-video-shoot/b10-recording.jpg) (a recording with a translation on; on the
night it is the owner's own room).

- **Spoken (VO, 17 words, 6.8 s):** "When I end the talk, it stays online as a recording, with every track, in any
  language."
- **On screen:** 2:35–2:38 **S**: the owner says the p4 line and presses **End talk** → confirms. 2:38–2:45 **R**: the
  same room's link in the owner's browser, now a recording; Turkish on; the timeline is clicked into the middle of
  the part that was watched live, and the subtitle is there at once.
- **Source:** S (end of the take), R (recorded right after the take).
- **On camera (R, the owner after the take):** open `/watch/<room>` (muted tab) → CC → Tur → **Türkçe** → click the
  timeline at about a third (inside the minutes V1 watched in Turkish) → hold 5 s.
- **Wait:** a made part plays its translation in 0.24–0.27 s; an unmade part takes 13–21 s, so only seek inside the
  part watched live.
- **Can go wrong → fallback:** the ended room does not open as a recording → record `/watch/dataviz-recording`
  instead (Turkish was made for its first minute on 11-03) and change "When I end the talk, it stays" to "Every talk
  stays" (14 words).

### 11 · 2:45–2:49 · End card

**Frame:** [b11-end.jpg](howto/demo-video-shoot/b11-end.jpg).

- **Spoken (VO, 5 words, 2 s):** "Talk Tracks. Try it live."
- **On screen:** the end card; lower third `talk-tracks.leventaksakal.com`.
- **Source:** end card. **Fallback:** none needed.

---

**Totals:** 11 beats, 2:49; VO 38 + 27 + 39 + 28 + 53 + 30 + 42 + 22 + 50 + 17 + 5 = **351 spoken words**, 140 s
of speech at 150 wpm inside 169 s. The tightest beats are 1 (15.2 s in 17 s) and 5 (21.2 s in 23 s): read them at an
even pace, without pauses between sentences.

## The alternate cut: one viewer, or none

- **One friend, two windows.** V1 in Chrome and V2 in Edge (or a second Chrome profile), side by side at 960×1080
  each, her screen recording holds both. She plays both parts: beat 3 in the left window, beat 4's pick and beats
  7–8 in the right. Mute one window's tab. The edit crops each half to full size for its beat. VO: "my friend" in
  beat 3, "In a second window, Japanese" in beat 4 (same count).
- **No friend at all.** The owner's second machine runs both windows; he operates it in the pauses of his talk, and
  the VO says "a viewer" instead of "my friend" (same word count).
- **No live talk at all** (the console cannot go on air): the friends open the demo live session `/watch/dataviz`;
  the terminal runs with `--room dataviz`; beats 2, 6 and 10 change to "a live session of a recorded lecture" and
  the speaker shots are dropped. Timing is unchanged.

## After the edit (checked before upload)

- [ ] Total at most 2:50; the opening line ends by 0:17.
- [ ] Freeze-frame check: no access code, speaker link or token, VM address, hostname of the VM, e-mail, or a
      friend's notification readable in any frame, the terminal band included.
- [ ] English captions for the voice-over (YouTube caption file from the VO text, or burned in).
- [ ] An English caption under any non-English speech or the first Turkish and Japanese subtitle lines.
- [ ] Credit line in the description: "Demo lectures: Electromagnetic Field 2026, EMF Video Team and C3VOC,
      CC BY-SA 4.0 (media.ccc.de). Trimmed, re-encoded, AI tracks added." (only if a demo room is in the cut)
- [ ] The friends agreed to appear (voice, name, screen) in a public video.
