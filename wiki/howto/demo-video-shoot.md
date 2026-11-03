# Shoot night, Nov 4: the runbook from 22:00 to submission

The runbook for [the video script](../submission-video.md): the owner gives a short live lecture, one or two friends
watch on their own machines, every screen is recorded, and the edit puts a terminal of live Meta model calls beside
the player. The storyboard frames are in [demo-video-shoot/](demo-video-shoot/); each beat of the script links its
own.

**The deadline is Nov 4, 9 PM EST = Nov 5 05:00 +03.** This runbook submits by **03:30 +03** at the latest, leaving
90 minutes for anything that goes wrong with the upload or the form.

Never write the access code, a speaker link, the VM's address or a key into this repository, a chat with the
friends that gets recorded, or a frame of the video.

## Before the night (the coordinator and the owner, Nov 3–4)

- [ ] The final build is on the VM by Nov 4 evening; the coordinator re-runs the storyboard capture on it
      (`node wiki/howto/demo-video-shoot/capture.mjs`, about 3 minutes, about $0.01: only the JPGs and
      `timings.json` change) and checks the [typing trap](../submission-video.md#the-typing-trap-in-the-language-search)
      is fixed or still there.
- [ ] `deploy/meta-calls.py` is on the VM (`git pull` in `~/talk-tracks`; it is read-only, nothing restarts).
- [ ] The friends have the [message below](#the-message-to-the-friends) and are booked for **22:45–23:55 +03**.
- [ ] The owner's 4-page PDF exists (his own text and drawings; page 3 is a diagram) and he has read the four cue
      lines in [the script](../submission-video.md#the-lecture-the-owner-gives).
- [ ] Languages and voice are decided ([ticket 0026](../../tickets/0026-demo-video-languages-and-voice.md)): each friend
      picks their own language (for example Turkish and Japanese), and the owner voices the narration.

## The clock (Nov 4–5, +03)

| Time | What | Done when |
|---|---|---|
| **22:00–22:30** | **Check the build and give feedback (≤ 30 min).** Pull this runbook up on the phone or a second screen. Open the site: a demo room plays, a recording plays with a language picked; the coordinator's re-captured storyboard frames match. Spend so far: `--since 1440 --no-follow` (below). Feedback goes to the coordinator; nothing is fixed tonight unless it blocks the shoot. | feedback sent; the site plays |
| **22:30–22:45** | **Setup** (below): rooms, console app window, PDF, mic, camera, OBS, terminal window, phone on its stand, Do not disturb. | every recorder shows a picture |
| **22:45–22:50** | Friends on a **phone call** (never on a recorded screen). They check: Chrome full screen, display at 100 %, OBS 1920×1080 30 fps, headphones, Do not disturb. Send them the **rehearsal** room's audience link. | both see the rehearsal room's waiting screen |
| **22:50–23:05** | **Rehearsal, 15 min** (below), in `lecture-rehearsal`. | the checklist is ticked |
| **23:05–23:10** | Fix what failed. Create the take rooms. Send the friends the **take 1** audience link. | |
| **23:10–23:18** | **Take 1** (6 min on the talk clock). | End talk pressed |
| **23:18–23:25** | Review: each friend says what they saw (subtitles, description, chapters, anything popping up). The owner scrubs the terminal recording. | keep or redo decided |
| **23:25–23:33** | **Take 2** (new room). | |
| **23:33–23:38** | Review; take 3 only if neither take has beats 3, 6 and 7 clean. | |
| **23:38–23:48** | **Take 3** or **pickups**: beat 10's recording (R), the phone shots for beat 1, a friend's 3 s selfie reading subtitles. | |
| **23:48–23:55** | Friends stop recording and upload their files ([how](#the-message-to-the-friends)). Thank them, release them. | files arriving |
| **23:55–00:20** | **Voice-over**, while files download: the owner reads each beat's VO into its own clip, same mic, quiet room. | 11 clips, each within its beat's length |
| **00:20–00:40** | **Resolve**: project, ingest, sync every POV on the clap. | all sources on one timeline |
| **00:40–01:45** | **Edit**, beat by beat, picture cut to the VO ([edit plan](#the-davinci-edit-plan)). **01:45 = picture lock.** | 2:49 ± 3 s, every beat in |
| **01:45–02:10** | Text, highlights, zooms, English captions; audio mix. | |
| **02:10–02:25** | Watch it twice end to end. Freeze-frame privacy check. Length ≤ 2:50. | checklist in the script ticked |
| **02:25–02:40** | **Export** ([settings](#export)). | the MP4 plays in a player |
| **02:40–03:05** | **Upload** to YouTube, wait for HD, add the caption file and the description. | 1080p shows in the quality menu |
| **03:05–03:15** | **Logged-out check** in a private window. | plays to the end, under 3:00 |
| **03:15–03:30** | **Submit** the form with the link; paste it into [submission.md](../submission.md#demo-video-owner). **03:30 at the latest.** | the form's confirmation page |

**Decision points.** 23:50 with no usable take → shoot [the alternate cut](../submission-video.md#the-alternate-cut-one-viewer-or-none)
alone on the demo live session until 00:20, then continue. 01:45 not locked → drop beat 8 (chapters) and
give its 10 s to beat 9. 02:45 not exported → export what is locked, as it is. **03:30 is the last moment to submit
whatever exists**; nothing after it is worth the deadline.

## Setup (22:30–22:45)

### The rooms

The room is created the way any presenter creates one, with an access code (decision 0025;
[tokens.md, Access codes](tokens.md#access-codes-presenters-create-their-own-room)):

1. https://talk-tracks.leventaksakal.com in desktop Chrome → **Start a talk**.
2. Title, your name, a **room name** and the **access code** (from `$TT_DATA/room-codes.json` on the VM; never typed
   where a recorder can see it, so do this before OBS starts). One room per take: `lecture-rehearsal`,
   `lecture-take1`, `lecture-take2`, `lecture-take3`. Each starts a clean timeline, rewind and spend.
3. **Start** gives the **speaker link** (private: it is the right to broadcast) and the **audience link**
   (`/watch/<room>`). The same code asking for the same room again gives a fresh speaker link if one is lost.
4. Open the speaker link as an app window, so no address bar (and no token) is ever on screen:
   `start chrome --app="<speaker link>"`. **Open console**.
5. In the console: microphone and camera on, drop in the PDF, check the meter. **Go on air** only once every
   recorder is running.
6. Send the friends only the audience link, on the phone, not on a recorded screen.

### The terminal of Meta calls

A terminal window used only for this, started straight from ssh so no shell prompt (with the VM's user and host) is
ever drawn:

```bash
ssh -t <vm-alias> 'clear; python3 ~/talk-tracks/deploy/meta-calls.py --room lecture-take1 --width 110'
```

One per take: Ctrl-C and restart it with the take's room before each take. `--no-captions` drops the caption lines
if the band gets too busy. If it says permission denied on the archive, prefix `sudo`.

What it prints, one line per call: `captions … turn "…"` for each final caption line (Muse Voice Transcribe, paid
by the minute: the `1 min $0.0030` line); `translate tr`, `describe slide`, `chapters` for each Muse Spark call
with its latency and cost, and below it the input → output; `⟲` marks a back-fill (a past slice someone fetched).

**Window:** Windows Terminal, *Cascadia Mono* 22 pt, a dark scheme, no scrollbar, padding 16, tab title
`Meta model calls` with *Suppress title changes* on. Size it to about 1920×600 (110 columns × 12 rows). Beat 5 shows
12 lines; the other beats show the last 6.

### Recording settings

> **Every screen recorder (owner and friends)**
>
> | Setting | Value |
> |---|---|
> | Display | **1920×1080**, Windows *Display → Scale* **100 %** (on a laptop that defaults to 125 %, set 100 % for the shoot, or keep 125 % and set Chrome's zoom to 80 %: the page must see a 1920×1080 window either way) |
> | Browser | Chrome, a guest window or a fresh profile (no bookmarks bar, no extensions, no other tabs), zoom 100 %, **full screen (F11)**: the player looks as in the storyboard at a 1920×1080 window, stage on the left, side panel on the right |
> | OBS *Video* | Base and Output **1920×1080**, **30 fps** (60 only if every POV records 60; the edit is 30) |
> | OBS *Output* | Recording format **Hybrid MP4** (or MKV, then *File → Remux*); encoder NVENC / Apple VT H.264, else x264 *veryfast*; CQP/CRF 18–20 |
> | OBS *Audio* | tracks 1 and 2 ticked; *Advanced Audio Properties*: mic on **track 1 only**, desktop on **track 2 only** |
> | OBS source | *Display Capture* of the 1920×1080 screen (or *Window Capture* of Chrome) |
> | Notifications | Windows: **Do not disturb on** (*Settings → System → Notifications*) and Focus session on; quit chat, mail, updaters. macOS: *Control Centre → Focus → Do Not Disturb* |
> | No OBS | Windows 11 *Snipping Tool → Record* (full screen, sound on); macOS *Cmd+Shift+5 → Record entire screen*. Resolve conforms the frame rate |

The owner records three things at once: **OBS on the console** (his mic on track 1 is the master audio of the
whole video), **the terminal** with a second recorder (*Snipping Tool → Record* on the terminal's region, or Xbox
Game Bar *Win+G* on the focused window), and **the phone** on a stand, landscape, 1080p 30 fps, framing him at the
laptop with the console visible over his shoulder. A second monitor makes this easy: console on one, terminal on the
other.

## Rehearsal (22:50–23:05, 15 minutes)

In `lecture-rehearsal`, every recorder running, a 4-minute version of the lecture (pages 1–3), both friends. Run the
take sheet below in order without stopping, then each friend plays back 30 s of their recording.

- [ ] Each recording plays: 1080p, 30 fps, mic on track 1, desktop on track 2; the clap is in every recording.
- [ ] Before the talk: V1's panel on *Chapters → Slides*, V2's on *Chapters → Chapters*; **I** shows those rows **on**.
- [ ] V1 types **Tur** and the talk does not pause; Turkish arrives (7–12 s); the terminal prints `translate tr`.
- [ ] V2 types **Jap**; Japanese arrives; `translate ja` lines interleave with `translate tr`.
- [ ] The page turn to the diagram prints `describe slide` within 15 s and the text appears in V1's Slides view.
- [ ] A `chapters` line by 3:00 of talk; V2's Chapters list has entries.
- [ ] V2's **J J J** rewinds; no `translate ja` line for the past; **G** returns to live.
- [ ] No access code, speaker link, token, hostname, e-mail or notification in any frame.
- [ ] The terminal is readable when shrunk to a 1920×270 band.

## The take sheet (one take, about 6 minutes)

Everyone starts a **stopwatch at the clap**; the times below are that talk clock. The friends keep this sheet next
to their keyboard.

| Talk clock | Speaker (S) | Viewer 1 (V1) | Viewer 2 (V2) | Beat |
|---|---|---|---|---|
| before | recorders on; terminal on the take's room; **Go on air** | open the audience link, full screen, panel **S → Chapters → Slides**, subtitles **Off**, start OBS | same link, panel **S → Chapters → Chapters**, subtitles Off, start OBS | |
| 0:00 | "three, two, one", **clap** on camera | start stopwatch | start stopwatch | sync |
| 0:05 | page 1, the p1 line, to camera | hands off | hands off | 1, 2 |
| 0:30 | keeps talking (full sentences) | **CC → Search any language → Tur → Türkçe · Turkish**, hands off | hands off | 3 |
| 1:00 | page 2, the p2 line | hands off | **CC → Jap → 日本語 · Japanese**, hands off | 4, 5 |
| 2:00 | **Next** to page 3, **Pen**, a circle round the diagram, the p3 line; keeps talking about it for a minute | watch the Slides view for the description | hands off | 6 |
| 3:00 | keeps talking | hands off | click the stage, **J J J**, watch 8 s, **G** | 7 |
| 3:30 | keeps talking | hands off | **Terms**, 2 s, **Chapters** | 8 |
| 4:00 | keeps talking | click the stage, **I**, hold 12 s, close it | hands off | 9 |
| 5:00 | page 4, the p4 line, **End talk** → confirm | stop OBS | stop OBS | 10 |
| after | **R**: open the room's link in a muted tab, **CC → Tur → Türkçe**, click the timeline at a third, hold 5 s | | | 10 |

## The DaVinci edit plan

**Project:** 1920×1080, 30 fps, timeline from 00:00:00:00. Media: every recording plus the title and end cards
(`web/public/brand/video/title.png`, `end.png`).

**Sync (00:20–00:40):** put S, V1, V2, P on the timeline, select them, *Auto Align Clips → Based on Waveform*, with
the S mic as the reference: the clap lines them up (each viewer's desktop track heard the clap through the player,
latency included, which is the honest view). The terminal has no audio: line it up by its clock (`HH:MM:SS`): the
clap produces a caption line ("three, two, one") a few seconds later; put that line's appearance a caption-delay
after the clap. Then lay the VO clips on A2 at each beat's start and cut picture to them.

**Tracks**

| Track | Holds |
|---|---|
| V1 | S, the speaker console |
| V2 | V1, viewer 1 POV |
| V3 | V2, viewer 2 POV |
| V4 | P phone camera, and R (the recording after the talk) |
| V5 | T, the terminal (band or half) |
| V6 | highlight boxes (a rounded rectangle, 2 px, 1 s fade) and zoom adjustment clips |
| V7 | text: lower thirds, English captions under non-English text or speech, "8 seconds later" tags |
| V8 | the title and end cards |
| A1 | **the speaker's mic (S, OBS track 1): the master** |
| A2 | the voice-over |
| A3–A5 | V1, V2 and P audio: **muted**, kept for sync only. Never the friends' laptop speakers or mics in the mix |

**The base layout:** the POV that is acting fills the top **1440×810**; the right column **480×810** holds the other
POV (or two stacked, 480×405 each); the terminal is a **1920×270 band** along the bottom (crop the terminal clip to
its last six lines, scale to fit). Beat 5 and beat 4 change it, as below.

| Beat | Time | Layout | Cut points | Text, zooms, highlights | Audio |
|---|---|---|---|---|---|
| 1 | 0:00–0:17 | title card full; P full from 0:03; V1, V2 full for 1 s each from 0:10 | 0:03 card → P; 0:10 → V1; 0:13.5 → V2 | lower third at 0:04 *Talk Tracks · built Oct 27 – Nov 4* | VO only; P's sound muted |
| 2 | 0:17–0:29 | S top-left 1440×810; V1 above V2 in the right column; no band | on the VO's first word | none | VO; A1 speaker at −20 dB under it, up to −6 dB in the 1 s gap at the end |
| 3 | 0:29–0:49 | V1 top; S small right; band fades in at 0:35 | keep 2 s after the click, **jump cut on the wait** to the first Turkish line | tag *8 seconds later* (the real number) 1.5 s; an English caption of the translated line under the stage; box on the first `translate tr` line, 1 s | VO; A1 −20 dB |
| 4 | 0:49–1:03 | **split**: V1 left, V2 right, each 960×810 cropped round the stage; band below | jump cut on V2's wait the same way; settle on a moment both show the same line | one English caption across the top: the shared sentence | VO; A1 −20 dB |
| 5 | 1:03–1:26 | **terminal half**: T 1920×540 below, V1 and V2 960×540 above | on the VO's "This terminal" | three 1 s boxes in VO order: a `captions … turn` line, a `translate tr` line with its snippet, its `$0.0004`; if text is small, 150 % zoom on each line instead | VO; A1 −24 dB |
| 6 | 1:26–1:43 | 1:26–1:30 S full frame (page turn, pen circle); then V1 top with its Slides view, S right, band | **cut on the wait**: pen stroke → description arriving | 130 % zoom on the Slides panel (1:33–1:40); box on `describe slide` | VO; A1 up to −10 dB for the p3 line at 1:26–1:29 |
| 7 | 1:43–2:03 | V2 top; V1 right; band | none in the rewind (it is 0.5 s); cut after **G** shows red | label *no new calls* beside the band while V2 is in the past | VO; A1 −20 dB |
| 8 | 2:03–2:13 | V2 top, panel on Chapters, then Terms | on the Terms click | 130 % zoom on the panel; box on the `chapters` line | VO; A1 −20 dB |
| 9 | 2:13–2:35 | V1 top with stats; band | none | 140 % zoom on the stats box 2:15–2:25, then out | VO; A1 −24 dB |
| 10 | 2:35–2:45 | 2:35–2:38 S full (End talk); 2:38–2:45 R full | on the End talk confirm | lower third *the same room, now a recording* | VO; A1 up for the p4 line at 2:35–2:37 |
| 11 | 2:45–2:49 | end card | — | lower third `talk-tracks.leventaksakal.com` | VO |

**Audio mix:** VO at about −16 LUFS short-term; the overall mix at **−14 LUFS integrated**, peaks under −1 dBTP
(Fairlight's loudness meter). No music unless it is royalty-free and credited; silence under the VO is fine. Burned-in
captions are not needed if the VO caption file is uploaded (below).

**Privacy before export:** step through every cut at 1 s intervals: no access code, speaker link or token, VM address
or host, e-mail, or a friend's notification, the terminal band included. Blur (*Effects → Blur*) anything that is.

## Export

*Deliver* page → **Custom export**:

| Setting | Value |
|---|---|
| Format / codec | **MP4, H.264**, encoding profile High |
| Resolution / frame rate | **1920×1080, 30 fps** (the timeline's) |
| Quality | *Restrict to* **8 000 Kb/s** (YouTube's recommended bitrate for 1080p at 24–30 fps; **12 000 Kb/s** if the timeline is 60 fps) |
| Audio | AAC, **48 kHz**, stereo, 320 kb/s (Resolve's maximum; YouTube recommends 384) |
| File name | `talk-tracks-demo.mp4` |

A 2:49 file at 8 Mb/s is about 175 MB. Play it once in a normal player before uploading: length, sound in both ears.

## Upload and submit

1. YouTube → *Create → Upload video* → `talk-tracks-demo.mp4`. Title: *Talk Tracks: a live lecture in any language
   (Meta Global AI Developer Hackathon)*. Description: two sentences on what it is, the site link, the repository
   link, and the EMF credit line if a demo room is in the cut (the script's checklist has it).
2. **Visibility: Public** if the form allows any link, else **Unlisted** (both play for anyone with the link; never
   Private). *Not made for kids.*
3. *Subtitles → Add → Upload file*: an `.srt` of the VO (the script's spoken lines with the beats' timecodes), or
   *Auto-sync* by pasting the VO text.
4. Wait until the HD version is processed (the quality menu offers 1080p); about 10–20 min for a 3-minute video.
5. **Logged-out check:** a private (incognito) window, not signed in, open the link: it plays, the length says
   under 3:00, 1080p is offered, the captions turn on.
6. Paste the link into the form and submit by **03:30 +03**. Put the link in
   [submission.md](../submission.md#demo-video-owner).

## The message to the friends

Send this as early as possible (Nov 3 or the morning of Nov 4), then the room link on the phone at 22:45. Replace
the parts in angle brackets.

```text
Hi! Thank you for helping with my hackathon video. Nov 4 (Istanbul time), 22:45 to about 23:55, on a phone call.
You'll be a viewer of a short live lecture I give, and we film your screen. Your voice is not used; your screen
(and maybe your name) appears in a public video, so tell me if that's not OK.

Before the night (10 minutes):
1. Desktop Chrome, up to date. Make a fresh Chrome profile or use a Guest window: no bookmarks bar, no extensions.
2. Install OBS Studio (obsproject.com). Settings -> Video: 1920x1080 base and output, 30 fps. Output -> Recording
   format: Hybrid MP4. Add a source: Display Capture. (No OBS? Windows: Snipping Tool -> Record; Mac: Cmd+Shift+5.)
3. Display at 1920x1080 and scale 100% if you can (Windows: Settings -> System -> Display).
4. Headphones, so your mic doesn't pick up my talk.

On the night:
1. Turn on Do Not Disturb, quit chat and mail apps.
2. Open the link I send you on the phone: <https://talk-tracks.leventaksakal.com/watch/ROOM>, press F11 (full screen).
3. Before I start: press S (side panel) -> Chapters -> <V1: Slides | V2: Chapters>. Keep subtitles Off.
4. Start OBS recording. When I clap, start a stopwatch on your phone.
5. At <V1: 0:30 | V2: 1:00> on your stopwatch: click CC (bottom right) -> click "Search any language" ->
   type <V1: Tur | V2: Jap> with a CAPITAL first letter (a small k, j or a space controls the player) ->
   click <Türkçe · Turkish | 日本語 · Japanese>. Then hands off: it takes about 10 seconds.
6. <V1: at 4:00 click the video once, press I, wait 12 seconds, close the box.>
   <V2: at 3:00 click the video once, press J three times, watch 8 seconds, press G. At 3:30 click Terms, then Chapters.>
7. When I say "End talk", stop OBS.

Send the file: upload the recording (in Videos, or OBS -> File -> Show Recordings) to <the shared folder link>,
named <v1|v2>-take<N>.mp4. Thank you!!
```

## If something fails

| Problem | What to do |
|---|---|
| The console cannot go on air, or the relay drops | A short drop reconnects by itself. Otherwise reload the console and go on air again. Still failing → **a demo live session**: the friends open `/watch/dataviz`, the owner narrates, the terminal runs `--room dataviz`; the script's alternate cut says what changes. |
| No live session works at all | A recording room, `/watch/dataviz-recording`: beats 3–9 work on it (back-fill lines, `⟲`, in the terminal with `--room dataviz-recording`), without the speaker. |
| The talk paused or jumped back when a friend typed a language | A lowercase k, j or a space reached the player. Press play (or **G** in a live room), and type the capitalised three letters next time. |
| A translation is slow to start | Normal: 7–12 s, it starts with the next caption line. Keep talking; the edit cuts the wait. Nothing after 20 s: `translate xx` lines but no subtitles → the friend reloads; `refused, $0` → pick another language; no line → after the take, `docker compose -f deploy/compose.vm.yml --profile live logs --since 10m translate-any` on the VM. |
| No slide description | V1's Slides view was not open before the page turn (stats: *Slide descriptions off*). Open it and turn the page again. |
| No chapters | V2's Chapters tab was not open from the start. Open it; the outline fills in a minute or two later. |
| The room says *capped* | Its cap is spent: create a new room with the code and do the take again. |
| Captions stop | They reopen on their own; keep talking. Not back within 30 s → end the take, new room. |
| A friend drops out | [The alternate cut](../submission-video.md#the-alternate-cut-one-viewer-or-none). |
| The upload is slow or YouTube is stuck processing | Keep going: an unlisted link works before HD finishes; submit at 03:30 with it and let HD finish afterwards. |

## Budget

Every model call is paid through the VM's spend ledger, under the $100 ceiling and each room's cap. Per take of six
minutes with two languages: captions about $0.02, each language about $0.05 (a fully watched lecture is about $0.14
per language), slide descriptions about $0.03, chapters about $0.07: **about $0.22 a take**, about **$1 for the
night** with the rehearsal and three takes. Check before and after:

```bash
ssh -t <vm-alias> 'python3 ~/talk-tracks/deploy/meta-calls.py --since 1440 --no-follow | tail -1'
```

## Audio safety

- The owner records his own device's audio; that is expected. Agents never play sound on his machine.
- Never open the audience view unmuted on the owner's machine while on air: it feeds the lecture back into the mic.
  For beat 10's recording, mute the tab first.
- The friends wear headphones; their audio is muted in the mix.
- The voice-over is recorded after the shoot, on the same mic, in a quiet room (the owner's own voice, decided in ticket 0026).
