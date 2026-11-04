# Demo video script: one live talk about itself, four windows, one take

The 3-minute submission video, replanned on 11-05 00:30 for the owner's ask (11-05): "build a nice slide deck for
explaining the choice of moqt; the system architecture we have (the client app doesnt tell everything) so we include
those in the 3min video as well and replan the speaker notes". He still records **alone**, in **one OBS take**, four
windows at once, then cuts in DaVinci Resolve and records the voice-over on top.

**The idea: the product demonstrates itself.** The talk given on air *is* the deck
[`docs/deck/talk-tracks-moqt.pdf`](../docs/deck/talk-tracks-moqt.pdf) (8 pages: why MoQT, the tracks, the
architecture, AI on demand, Meta's models). The owner drops it into the console (Slides → drop PDF) and explains the
system live, so the Turkish and Japanese listeners read *the architecture* in their own language while it is
explained, the describe agent describes *the architecture diagram*, and the rewind replays *that* slide. Three short
full-screen inserts of the same slides (PNG, `docs/deck/png/`) let a judge read a diagram the listener tile shows
small. Read this on the second screen while recording: [Shot order](#shot-order-one-take-top-to-bottom) is the only
part you follow live; [The lecture the owner gives](#the-lecture-the-owner-gives) is what you say on air, page by
page; the beats say what each piece of the take must prove and what the voice-over says.

**Length: 2:52** (13 beats). Judges stop at 3:00; 8 s spare. Voice-over (VO) at 150 words a minute; every beat lists
its words and seconds. Older material (storyboard frames, measured waits, the edit's DaVinci settings) is still in
[howto/demo-video-shoot.md](howto/demo-video-shoot.md); where it talks about friends, phone shots, the side panel
(**S**), read-aloud or the PiP card, this page wins.

**What the rules need from the video** ([rules](workstreams/07-submission.md#the-rules-checked-2026-11-02)): under
3:00, English, the working product, the opening says what pre-existed, live Meta calls visible (the terminal), a
public or unlisted link. An AI or owner voice-over is fine. This page used to say "no slides about it": the slides
here are the content of the live talk, shown inside the product; the full-screen inserts add up to **26 s** of 172.
If the owner wants the product on screen every second, drop the inserts (beats 5, 6, 8, 12) and let the VO run over
the listener windows; nothing else changes.

## The four windows (POVs) and their DaVinci frames

| POV | What it is | Border (DaVinci) | Label (top-left, DaVinci text) |
|---|---|---|---|
| **Speaker** | native Chrome, the speaker console (green room, then on air) | **blue** (the app's Speaker colour) | `SPEAKER` |
| **Listener TR** | incognito Chrome window 1 on the audience link, **muted** | **amber** | `LISTENER · Türkçe` |
| **Listener JA** | incognito Chrome window 2 on the same link, **muted** | **green** | `LISTENER · 日本語` |
| **Terminal** | Windows Terminal, ssh to the VM, live Meta API calls | **grey** | `META API CALLS · on the VM` |
| **Deck insert** (edit only, not OBS) | one slide PNG from `docs/deck/png/`, full frame, the page the speaker is presenting at that moment | **white** | `THE TALK'S SLIDE · N of 8` |

Border: 6 px solid, rounded 12 px to echo the app's tiles; label in the app's sans, white on a 70 % black chip.
Inserts cut in and out hard (no zoom, no fade): they are the same page the listener tile shows, made readable.

**OBS, one recording of all four** (so one clip syncs everything; no clap needed): canvas and output **3840×2160,
30 fps**, NVENC H.264, CQP 20; one scene, four *Window Capture* sources (*Windows 10 (1903 and up)* method), each
fitted to a quadrant: Speaker top-left, Listener TR top-right, Listener JA bottom-left, Terminal bottom-right. In
DaVinci each quadrant crops to a clean 1920×1080 clip. If the GPU struggles, canvas 2560×1440 (quadrants 1280×720).
Mic on audio track 1 only; desktop audio **off** (the listeners are muted anyway).

**Crop the address bars in OBS** (source → *Edit Transform* → Crop top ≈ 85 px on each Chrome source): the speaker
link in the Speaker window's address bar is private and must never be recorded.

**Placement on two monitors.** Monitor 1: the Speaker console, maximised. Monitor 2: Listener TR on the left half,
Listener JA on the right half; the Terminal over the lower third of Monitor 1 (the console's dock stays visible
above it) or anywhere it stays partly visible. Chrome stops painting a window that is fully covered, so no Chrome
window may be completely hidden; if they must overlap, quit Chrome entirely and start it once with
`chrome --disable-features=CalculateNativeWinOcclusion`.

## The terminal command

Started straight from ssh so no prompt (user, host) is ever drawn. `$VM` is your own ssh alias; never type the
address on screen.

```sh
ssh -t $VM 'clear; python3 ~/talk-tracks/deploy/meta-calls.py --room <room> --width 110'
```

One line per Meta model call: captions (speech to text), `translate tr` / `translate ja` with the English → target
snippet, `describe slide`, `chapters`, each with its cost. It reads only the spend ledger and the archive, so it
holds no keys or hosts. If it prints nothing, check `--room` and that the take's room is on air.

Raw agent logs instead (only if the script fails; they can print a relay address at startup, so start them before
going on air and check the frame in the privacy pass):

```sh
ssh -t $VM 'cd ~/talk-tracks && docker compose -f deploy/compose.vm.yml logs -f --tail 0 --no-log-prefix captions translate-any describe chapters'
```

Font: Cascadia Mono 22 pt, dark scheme, tab title `Meta API calls`.

## Waits to expect (what to cut on)

| Action | Wait | In the edit |
|---|---|---|
| Pick a language in a live room → first subtitle | 7–12 s, allow 15 s | hold 2 s after the click, jump cut, small tag "9 s later" (the real number) |
| Turn a slide → its description in Chapters → Slides | 5–15 s | jump cut to the description arriving |
| First chapters revision | 1–2 min of talk | shoot beat 8 after 3:00 of talk |
| Rewind (J ×3) / Go live (G) | ≈0.5 s / ≈0.2 s | no cut |
| Recording: seek inside a part watched live | ≈0.25 s | no cut; never seek into a part nobody watched (13–21 s) |

## Beats

Times are the final cut. "Page" is the deck page on air in the take; the take's order is in
[Shot order](#shot-order-one-take-top-to-bottom). VO is the voice-over recorded after the take; the live mic (what you
said on air) sits under it at −20 dB.

---

### 1 · 0:00–0:12 · The problem, and what was built

- **POV:** title card 0:00–0:03, then **Speaker** (blue) in the green room.
- **Clicks:** none (the green room is already on screen; this is the first seconds of the recording).
- **Make visible:** the console's green room: preview with mic/camera toggles, the setup list.
- **VO (27 words, 10.8 s):** "A live talk reaches only the people who share its language. Talk Tracks, built from October 27th on
  the open-source MoQ relay and Meta's models, changes that."

### 2 · 0:12–0:26 · The speaker goes on air, with this deck

- **POV:** **Speaker** (blue), full frame.
- **Clicks (green room, top to bottom):** mic on, the meter moves → camera on → **Slides**: drop
  `talk-tracks-moqt.pdf`, eight thumbnails appear → **Go on air** (pinned bottom). Then **ⓘ** beside the room name →
  *Talk details* shows the audience link and QR → close it.
- **Make visible:** the deck's pages as thumbnails (the architecture diagram is recognisable); the header switching to
  on air; the QR for the audience (public link only; never the speaker link).
- **VO (29 words, 11.6 s):** "I'm the speaker, in the browser: microphone, camera, and slides about how this works. Go on air, and
  listeners get a link and a QR code. No app needed."

### 3 · 0:26–0:40 · Listener one picks Turkish

- **POV:** **Listener TR** (amber) large; Terminal (grey) as a band along the bottom from 0:32.
- **Page on air:** 2, the problem.
- **Clicks (Listener TR):** move the mouse onto the player → **CC** (bottom bar) → type `tur` (the list jumps to
  *Turkish · Türkçe*) → click it → mouse off the player, hands off.
- **Make visible:** the CC list (Off, Original, then 50 languages A–Z); **Turkish subtitles appear within ~15 s**; the
  terminal prints its first `translate tr` line at the same moment. Cut the wait (tag "9 s later", the real number).
- **VO (30 words, 12.0 s):** "A listener opens the subtitles and types Turkish. Nothing was translating into Turkish until this
  click. A Meta model starts now, for this room, and seconds later she follows along."

### 4 · 0:40–0:48 · Listener two picks Japanese

- **POV:** split, **Listener TR** (amber) left, **Listener JA** (green) right; terminal band below.
- **Clicks (Listener JA):** **CC** → type `jap` → *Japanese · 日本語* → hands off.
- **Make visible:** the same sentence about the problem in Turkish and Japanese side by side; `translate ja` lines
  interleave with `translate tr`. Add an English caption of that sentence above both (DaVinci text).
- **VO (10 words, 4.0 s):** "A second listener picks Japanese. One sentence, two languages, live."

### 5 · 0:48–1:08 · Why MoQT (pages 3 and 4)

- **POV:** **Speaker** (blue) 0:48–0:51 (› to page 3) → **Deck insert** `03-why-moqt.png` (white, `THE TALK'S SLIDE · 3
  of 8`) 0:51–0:59 → **Listener JA** (green) 0:59–1:08 on page 4 (the tracks diagram) with Japanese subtitles of what
  you said about it.
- **Clicks:** Speaker › to page 3, later › to page 4 (in the take, 45 s apart; cut between them).
- **Make visible:** the comparison table, readable; then the tracks diagram arriving in a listener's slide tile with
  subtitles under it: the deck explaining the thing that is carrying it.
- **VO (39 words, 15.6 s):** "Why Media over QUIC? WebRTC has no cache and no history; HLS can't carry dozens of data tracks or tell
  us who's listening. MoQ does both: one relay fans out named tracks, and every AI job publishes its own."

### 6 · 1:08–1:30 · The architecture, drawn on live (page 5)

- **POV:** **Speaker** (blue) 1:08–1:14 → **Deck insert** `05-architecture.png` (white, `THE TALK'S SLIDE · 5 of 8`)
  1:14–1:21 → **Listener TR** (amber) 1:21–1:30.
- **Clicks (Speaker):** › to page 5 → tool rail **Pen** → circle the *moq-relay* box → **Laser**, point at the *AI
  agents* box for 2 s. **(Listener TR):** hover the Slides tile → **‹** once → it reads "Slide 4 of 8 · the speaker is
  on 5" → **Follow the speaker**.
- **Make visible:** the circle and laser reach the listener's slide tile at once; stepping back shows "the speaker is
  on 5"; **Follow the speaker** snaps back to page 5 with the circle.
- **VO (42 words, 16.8 s):** "The whole system runs on one small server. My browser publishes to the relay. Four agents subscribe
  to my speech and slides, call Meta's models, and publish their tracks back. My pen and laser are tracks too: every
  listener sees them live."

### 7 · 1:30–1:41 · The diagram, described for people who can't see it

- **POV:** **Listener TR** (amber) with the **Chapters** card open on **Slides**; terminal band with the
  `describe slide` line boxed.
- **Clicks:** none live (Listener TR opened **Chapters** → **Slides** before the take; the turn to page 5 triggers it).
- **Make visible:** a new description of page 5 (the architecture diagram) arrives 5–15 s after the turn; the
  terminal shows the call that made it. Hold on the description text 2 s so it can be read.
- **VO (26 words, 10.4 s):** "Each new slide is described by a Meta vision model, for anyone who can't see it, even this
  architecture diagram, seconds after I turned to it."

### 8 · 1:41–2:00 · AI on demand, in the terminal (page 6)

- **POV:** **Deck insert** `06-lazy-ai.png` (white, `THE TALK'S SLIDE · 6 of 8`) 1:41–1:45 → **Terminal** (grey)
  bottom half, Listener TR and JA small above it, 1:45–2:00.
- **Clicks (Listener JA, while you are on page 6):** ⏸ **pause** → wait 5 s → ▶ play → the pill's **Go live** (so JA
  is back at live and no past lines get back-filled; keeps beat 9 clean).
- **Make visible:** three 1 s highlight boxes on terminal lines: a caption line, a `translate ja` line with its
  snippet, its cost (fractions of a cent). While JA is paused: **JA's subtitles stop and the `translate ja` lines
  stop**; TR keeps going. If the `translate ja` lines do not stop, cut that half-sentence of the VO.
- **VO (41 words, 16.4 s):** "This terminal is the server, printing every call to Meta's models. Subscribing is the demand signal:
  pause, and the relay drops that subscription, so that translation stops. Nobody listening, no call; and every call
  passes a spend ledger with a cap."

### 9 · 2:00–2:13 · Missed something? Rewind

- **POV:** **Listener JA** (green); terminal band.
- **Clicks (Listener JA):** click the stage once (focus, not a field) → **J J J** (back 30 s) → wait 8 s → the pill's
  **Go live** (or **G**).
- **Make visible:** the pill shows how far behind; the slide, the pen circle and the Japanese subtitles replay as they
  were; the terminal shows **no new `translate ja` call for the past** (box it, label "no new calls"); **Go live**
  returns to now.
- **VO (30 words, 12.0 s):** "Missed something? Jump back thirty seconds: slide, ink and Japanese subtitles replay as they were,
  fetched from the same tracks. No new model call. One click, and you're live again."

### 10 · 2:13–2:22 · Chapters, terms and transcript

- **POV:** **Listener TR** (amber), the right-hand card.
- **Clicks (Listener TR):** **Chapters** (bottom-right) → **Chapters** view → **Terms** → **Transcript**
  (bottom-right) → type `relay` in *Search the transcript*.
- **Make visible:** a chapter list built during the talk; glossary terms (expect MoQ, relay, FETCH); the transcript with
  the Turkish line beside each English one; search hits highlighted.
- **VO (21 words, 8.4 s):** "A running outline too: chapters and key terms, revised as I talk, and a transcript you can search,
  in your language."

### 11 · 2:22–2:34 · End talk: it stays as a recording

- **POV:** **Speaker** (blue) 2:22–2:26, then **Listener TR** (amber) on the replay.
- **Clicks (Speaker, on page 8):** red **End talk** (dock centre) → *End the talk?* → **End talk** → *How it went* →
  **Open replay**. **(Listener TR, after the take, pickup P1):** reload the audience link → it is a recording → **CC** →
  `tur` → *Turkish · Türkçe* → click the timeline about a third in (the architecture page).
- **Make visible:** the end screen's real facts; the recording plays the Turkish at once at a part watched live
  (≈0.25 s); the slides and ink are there.
- **VO (26 words, 10.4 s):** "When I end the talk, it's already a recording: every track kept, seekable, in any language. The site
  has four conference talks to try as well."

### 12 · 2:34–2:45 · Which Meta model does what (page 7)

- **POV:** **Deck insert** `07-meta-models.png` (white, `THE TALK'S SLIDE · 7 of 8`) 2:34–2:41 → the hub (pickup P3,
  blue frame) 2:41–2:45: *Live now* and *Recordings* rows.
- **Clicks:** P3: scroll the hub once, slowly.
- **VO (24 words, 9.6 s):** "Two Meta models do all of it: Muse Voice Transcribe turns speech into captions; Muse Spark translates,
  describes the slides and writes the chapters."

### 13 · 2:45–2:52 · Close

- **POV:** the end card: `08-close.png` or the brand end card, with `talk-tracks.leventaksakal.com`.
- **VO (13 words, 5.2 s):** "Talk Tracks: every AI job a track you choose. Try it live, today."

---

| Beat | Time | Seconds | VO words | VO seconds at 150 wpm | Insert |
|---|---|---|---|---|---|
| 1 Problem, what was built | 0:00–0:12 | 12 | 27 | 10.8 | title card 3 s |
| 2 On air with the deck | 0:12–0:26 | 14 | 29 | 11.6 | |
| 3 Turkish | 0:26–0:40 | 14 | 30 | 12.0 | |
| 4 Japanese | 0:40–0:48 | 8 | 10 | 4.0 | |
| 5 Why MoQT | 0:48–1:08 | 20 | 39 | 15.6 | slide 3, 8 s |
| 6 Architecture, ink | 1:08–1:30 | 22 | 42 | 16.8 | slide 5, 7 s |
| 7 Diagram described | 1:30–1:41 | 11 | 26 | 10.4 | |
| 8 AI on demand | 1:41–2:00 | 19 | 41 | 16.4 | slide 6, 4 s |
| 9 Rewind | 2:00–2:13 | 13 | 30 | 12.0 | |
| 10 Chapters, transcript | 2:13–2:22 | 9 | 21 | 8.4 | |
| 11 Recording | 2:22–2:34 | 12 | 26 | 10.4 | |
| 12 Meta models | 2:34–2:45 | 11 | 24 | 9.6 | slide 7, 7 s |
| 13 Close | 2:45–2:52 | 7 | 13 | 5.2 | end card |
| **Total** | **2:52** | **172** | **358** | **143** | 26 s of slides |

The MoQT choice and the architecture get **42 s** (beats 5 and 6) plus the lazy-AI and models beats (30 s) that show
them working. Tightest: beat 7 (10.4 s in 11 s) and beat 9 (12.0 s in 13 s); read them evenly. If the cut runs long, drop beat 10 first (its 9 s go to
beat 6), then the hub pickup in beat 12.

If the opening line must name what is not ours in full, the [submission text](submission.md) carries it: the MoQ
relay and `@moq/*` libraries, Media Chrome, hls.js, PDF.js, Meta's models, the EMF 2026 demo lectures (CC BY-SA 4.0).

## The lecture the owner gives

What you say **on air** in the take, page by page: this is what the agents caption, translate and chapter, so speak in
full, plain sentences with a short pause between them, and keep going between the listener actions. About 5½ minutes;
the chapters agent needs ≈ 3:00 of talk before beat 10. Not the VO: the VO is recorded afterwards, over the cut.

| Page | Say (on air) | Do meanwhile |
|---|---|---|
| 1 · Title | "Hello, and welcome. This is Talk Tracks. I'm giving this talk live, and you can follow it in your own language. It explains how this very talk reaches you." | Go on air, ⓘ Talk details |
| 2 · The problem | "A live talk reaches only part of its room. If you don't share my language, you get nothing. If you can't see the slides, they are lost. If you arrive late, there is no way back. AI can close each gap. But running every model for every talk, all the time, pays for output nobody reads. So every AI job is a track, and it runs only while someone subscribes to it." | TR picks Turkish, JA picks Japanese |
| 3 · Why MoQT | "Why Media over QUIC? WebRTC is fast, but it has no cache and no history. HLS caches well, but a player takes one subtitle track at a time, and the server never knows who stopped watching. With MoQ, one relay fans out named tracks, caches them, and subscribes upstream only when someone asks. The price is that MoQ is still a draft, so we pin our versions." | |
| 4 · Tracks | "Everything in this room is a track. My audio and video. The slides and my ink. The captions, each translation, the slide descriptions and the chapters. Each track is cut into four-second groups on one clock. Live, you subscribe at the edge. To rewind, you fetch an earlier group. The recording is the same tracks." | |
| 5 · Architecture | "Here is the whole system, on one small server. My browser publishes to the relay. Four agents subscribe to my speech and my slides, call Meta's models, and publish their tracks back. A room service keeps the archive, the chat and the access codes. Caddy serves the web app and the recordings." | Pen: circle the relay. Laser on the agents. TR: ‹, Follow the speaker. Wait for page 5's description. |
| 6 · AI on demand | "The models run only on demand. Nobody listening means no call. The first listener starts an agent within milliseconds. A second listener shares the same subscription. When the last one leaves, the agent stops after ten seconds. And every call passes a spend ledger, with a cap for each room." | JA: pause 5 s, play, Go live |
| 7 · Meta's models | "Two Meta models do the work. Muse Voice Transcribe turns my speech into captions. Muse Spark translates every line, describes each slide, and writes the chapters and the glossary. Rewinding costs nothing, because the past comes from the same tracks." | at clock ≥ 3:00: JA rewind J J J, Go live; TR Chapters, Terms, Transcript, search `relay` |
| 8 · Close | "Every AI job is a track you choose, paid for only while someone listens. Thank you for listening. You can try it live at talk-tracks dot leventaksakal dot com." | End talk |

## Feature checklist

| Feature live on `main` | Beat | Note |
|---|---|---|
| Start a talk modal (title, speaker, room, access code) | not shown | the access code is typed in it; done before OBS starts |
| "Your talk is ready" modal: QR, room code, links, Copy, Done | not shown | shows the private speaker link |
| Console header time · title · room ⓘ → Talk details (link, Copy, QR, Show full screen) | 2 | audience link and QR only |
| Green room: preview with mic/camera toggles, mic meter, camera, screen with sound | 1, 2 | screen share not shown (time) |
| Slides setup: drop PDF/PPTX/images → thumbnails | 2 | the deck `docs/deck/talk-tracks-moqt.pdf`, 8 pages |
| Go on air pinned bottom | 2 | |
| Tool rail: pen, highlighter, shapes, arrow, line, laser, underline, mark text, eraser, undo/redo/clear | 6 | pen and laser on the architecture page |
| Dock: pager, mic, camera, share, hide slides, pause, End talk; Slides, Audience, Questions | 5, 6, 11 | pager and End talk; Audience/Questions not shown (no audience chat in a solo take) |
| End screen "How it went" + Open replay | 11 | |
| Hub: 4 demo talks, Live now / Recordings, presenters' rooms | 11 (VO), 12 | |
| Meet-style tiles with frame colours, names bottom-left | 3–10 | the DaVinci borders echo them |
| Bottom bar: play, volume slider, CC, ⋮ More options | 3, 8 | |
| CC list: Off, Original, 50 languages A–Z, type to jump | 3, 4 | |
| Live translation into any language, lazily started | 3, 4, 8 | |
| Pause stops subtitles and fetching | 8 | |
| Seek while paused stays paused | not shown | true but invisible; no time |
| Slides tile: ‹ › "Slide N of M", the speaker is on N, Follow the speaker | 6 | |
| All slides strip; Match the playhead (recording) | not shown | one slide-nav moment is enough |
| Speaker tile cropped from the conference video / "Speaker off camera" | not shown | was pickup P2; its 5 s went to the architecture |
| Slide descriptions (describe agent) | 7 | the description of the architecture diagram |
| Rewind (J), Go live (G), no new calls for the past | 9 | |
| Chapters panel: Chapters, Terms, Slides | 7, 10 | |
| Transcript panel, search, translation beside each line | 10 | download not shown |
| Chat, Discussion panels | not shown | need a second person writing |
| More options: Adjust view, Full screen, Picture-in-picture, Settings, Keyboard shortcuts | not shown | presentation; time goes to AI tracks |
| Drag a tile label to dock/float | not shown | as above |
| Stats for nerds (I or right-click) | not shown | the terminal and the deck tell the same story better |
| Recording after End talk, seek with translation | 11 | |
| Spend ledger, AI on the VM via Meta | 8 (terminal, slide 6) | never show spend in the player itself |
| **Not visible in the app, told by the deck** | | |
| Why MoQT over WebRTC, LL-HLS, WebSockets | 5 (slide 3) | backed by `wiki/benchmark.md` |
| Tracks as containers: groups of 4 s, carry-in, SUBSCRIBE live, FETCH past | 5 (slide 4, in a listener tile) | decisions 0012, 0017 |
| The architecture: relay, auth, Caddy, four agents, room service + archive, demo sessions, `/data`, Meta API | 6 (slide 5) | `deploy/compose.vm.yml` |
| Demand signal: relay subscribes upstream on the first listener, cancels after the last, 10 s grace | 8 (slide 6) | `wiki/howto/lazy-agents.md` |
| Which Meta model makes which track | 12 (slide 7) | README, Meta models used |

## Shot order (one take, top to bottom)

**Before OBS (nothing private may be recorded):**

1. Hub → **Start a talk** → title *How Talk Tracks works*, your name, room name `video-take1`, access code (by hand) →
   **Start** → **Copy** the audience link and the speaker link → **Done**. (Off camera.)
2. Speaker: open the speaker link in native Chrome, maximise on Monitor 1; allow mic and camera. Stay in the green
   room; do **not** go on air yet; mic and camera **off**, no PDF dropped yet. Have `docs/deck/talk-tracks-moqt.pdf`
   in an Explorer window you can drag from (or know its path for the file picker).
3. Listener TR: `Ctrl+Shift+N`, paste the audience link, right-click the tab → **Mute site**. Open **Chapters** →
   **Slides** (starts the describe agent). Subtitles **Off**. Monitor 2, left half.
4. Listener JA: a second incognito window, same link, **Mute site**. Open **Chapters** → **Chapters**. Subtitles
   **Off**. Monitor 2, right half.
5. Terminal: `ssh -t $VM 'clear; python3 ~/talk-tracks/deploy/meta-calls.py --room video-take1 --width 110'`.
6. OBS: four sources in quadrants, address bars cropped; Do not disturb on; headphones on. The lecture table
   ([The lecture the owner gives](#the-lecture-the-owner-gives)) on the second screen or printed.

**Record (OBS ● Start Recording), then in this order:**

| # | Window | Do | Page | Beat |
|---|---|---|---|---|
| 1 | — | 3 s still on the green room | — | 1 |
| 2 | Speaker | mic on, say a line, meter moves → camera on → Slides: drop `talk-tracks-moqt.pdf` (8 thumbnails) → **Go on air** | 1 | 2 |
| 3 | Speaker | **ⓘ** → Talk details → close; say page 1's lines | 1 | 2 |
| 4 | Speaker | › to page 2; say its lines slowly, keep talking | 2 | — |
| 5 | Listener TR | **CC** → `tur` → *Turkish · Türkçe*; wait for the first line (≤ 15 s) | 2 | 3 |
| 6 | Listener JA | **CC** → `jap` → *Japanese · 日本語*; wait for the first line | 2 | 4 |
| 7 | Speaker | › to page 3; say its lines (≈ 45 s) | 3 | 5 |
| 8 | Speaker | › to page 4; say its lines (≈ 40 s) | 4 | 5 |
| 9 | Speaker | › to page 5 → **Pen**: circle the *moq-relay* box → **Laser** on *AI agents* 2 s; say its lines | 5 | 6 |
| 10 | Listener TR | hover Slides tile → ‹ → read "the speaker is on 5" → **Follow the speaker** | 5 | 6 |
| 11 | Listener TR | wait for page 5's description in Chapters → Slides (≤ 15 s); keep talking on page 5 | 5 | 7 |
| 12 | Speaker | › to page 6; say its lines | 6 | — |
| 13 | Listener JA | ⏸ pause, 5 s, ▶ play, **Go live** (while you talk about pausing) | 6 | 8 |
| 14 | Speaker | › to page 7; say its lines, then talk on about it until clock ≈ 3:30 | 7 | — |
| 15 | Listener JA | click the stage → **J J J** → wait 8 s → **Go live** | 7 | 9 |
| 16 | Listener TR | **Chapters** → **Chapters** → **Terms** → **Transcript** → search `relay` | 7 | 10 |
| 17 | Speaker | › to page 8; closing lines → **End talk** → **End talk** → *How it went* → **Open replay** | 8 | 11 |
| 18 | Listener TR | **P1**: reload → recording → **CC** → `tur` → Turkish → click the timeline a third in; hold 5 s | — | 11 |
| 19 | Listener JA | **P3**: the hub, scroll slowly through *Live now* and *Recordings* | — | 12 |
| 20 | — | OBS ■ Stop Recording | | |

About 7 minutes. Then the VO, one clip per beat, and the DaVinci cut with the four inserts from `docs/deck/png/`
(`03-why-moqt.png`, `05-architecture.png`, `06-lazy-ai.png`, `07-meta-models.png`; `08-close.png` can be the end
card). If step 5 shows nothing after 20 s: look at the terminal (no `translate tr` line → reload Listener TR and pick
again, keep recording; cut the miss).

## After the edit (checked before upload)

- [ ] Total ≤ 2:55; the opening line done by 0:12.
- [ ] Freeze-frame pass at 1 s steps: no access code, speaker link, token, VM address or host, e-mail or
      notification in any frame, terminal included.
- [ ] English captions for the VO; an English caption under the first Turkish and Japanese lines.
- [ ] Each deck insert is the page the speaker had on air at that point of the take (3, 5, 6, 7).
- [ ] Credit line in the description only if a demo talk is in the cut (the hub pickup shows their cards): "Demo
      lectures: Electromagnetic Field 2026, EMF Video Team and C3VOC, CC BY-SA 4.0 (media.ccc.de). Trimmed,
      re-encoded, AI tracks added."
