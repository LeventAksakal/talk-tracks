# Demo video script: one live talk, four windows, one take

The 3-minute submission video, rewritten on 11-04 night for the UI on `main` (3f570fc) and the owner's plan: he
records **alone**, in **one OBS take**, four windows at once, then cuts in DaVinci Resolve and records the
voice-over on top. Read this on the second screen while recording: [Shot order](#shot-order-one-take-top-to-bottom)
is the only part you follow live; the beats say what each piece of the take must prove.

**Length: 2:52** (11 beats). Judges stop at 3:00; 8 s spare. Voice-over (VO) at 150 words a minute; every beat lists
its words and seconds. Older material (storyboard frames, measured waits, the edit's DaVinci settings) is still in
[howto/demo-video-shoot.md](howto/demo-video-shoot.md); where it talks about friends, phone shots, the side panel
(**S**), read-aloud or the PiP card, this page wins.

**What the rules need from the video** ([rules](workstreams/07-submission.md#the-rules-checked-2026-11-02)): under
3:00, English, the working product (no slides about it), the opening says what pre-existed, live Meta calls visible
(the terminal), a public or unlisted link. An AI or owner voice-over is fine.

## The four windows (POVs) and their DaVinci frames

| POV | What it is | Border (DaVinci) | Label (top-left, DaVinci text) |
|---|---|---|---|
| **Speaker** | native Chrome, the speaker console (green room, then on air) | **blue** (the app's Speaker colour) | `SPEAKER` |
| **Listener TR** | incognito Chrome window 1 on the audience link, **muted** | **amber** | `LISTENER · Türkçe` |
| **Listener JA** | incognito Chrome window 2 on the same link, **muted** | **green** | `LISTENER · 日本語` |
| **Terminal** | Windows Terminal, ssh to the VM, live Meta API calls | **grey** | `META API CALLS · on the VM` |

Border: 6 px solid, rounded 12 px to echo the app's tiles; label in the app's sans, white on a 70 % black chip.

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

Times are the final cut. "Clock" is when it happens in the take, counted from **Go on air**.

---

### 1 · 0:00–0:12 · The problem, and what was built

- **POV:** title card 0:00–0:03, then **Speaker** (blue) in the green room.
- **Clicks:** none (the green room is already on screen; this is the first seconds of the recording).
- **Make visible:** the console's green room: preview with mic/camera toggles, the setup list.
- **VO (29 words, 11.6 s):** "A live talk reaches only the people who share its language. Talk Tracks, built from
  October 27th on the open-source MoQ relay and Meta's models, changes that."

### 2 · 0:12–0:28 · The speaker goes on air

- **POV:** **Speaker** (blue), full frame.
- **Clicks (green room, top to bottom):** mic on, the meter moves → camera on → **Slides**: drop your 4-page PDF,
  thumbnails appear → **Go on air** (pinned bottom). Then **ⓘ** beside the room name in the header → *Talk details*
  shows the audience link and QR → close it.
- **Make visible:** PDF pages as thumbnails; the header switching to on air; the QR for the audience (public link
  only; never the speaker link).
- **VO (34 words, 13.6 s):** "I'm the speaker. In the browser: a microphone, a camera, a PDF dropped in. Go on air,
  and the room has an audience link and a QR code. No app, no account for listeners."

### 3 · 0:28–0:46 · Listener one picks Turkish

- **POV:** **Listener TR** (amber) large; Terminal (grey) as a band along the bottom from 0:35.
- **Clicks (Listener TR):** move the mouse onto the player → **CC** (bottom bar) → type `tur` (the list jumps to
  *Turkish · Türkçe*) → click it → mouse off the player, hands off.
- **Make visible:** the CC list (Off, Original, then 50 languages A–Z); **Turkish subtitles appear within ~15 s**; the
  terminal prints its first `translate tr` line at the same moment.
- **VO (30 words, 12 s):** "A listener opens the subtitles and types Turkish. Nothing was translating into Turkish
  until this click. A Meta model starts now, for this room, and seconds later she follows along."

### 4 · 0:46–1:00 · Listener two picks Japanese: one sentence, two languages

- **POV:** split, **Listener TR** (amber) left, **Listener JA** (green) right; terminal band below.
- **Clicks (Listener JA):** **CC** → type `jap` → *Japanese · 日本語* → hands off.
- **Make visible:** the same sentence in Turkish and Japanese side by side; `translate ja` lines interleave with
  `translate tr` in the terminal. Add an English caption of that sentence above both (DaVinci text).
- **VO (27 words, 10.8 s):** "A second listener picks Japanese. Same sentence, two languages, at once. Any of fifty
  languages works, and each one runs only while someone is watching it."

### 5 · 1:00–1:20 · AI on demand, in the terminal

- **POV:** **Terminal** (grey) bottom half, Listener TR and JA small above it.
- **Clicks (Listener JA):** ⏸ **pause** → wait 5 s → ▶ play → the pill's **Go live** (so JA is back at live and
  no past lines get back-filled; keeps beat 8 clean).
- **Make visible:** three 1 s highlight boxes on terminal lines: a caption line, a `translate ja` line with its
  snippet, its cost (fractions of a cent). While JA is paused: **JA's subtitles stop and the `translate ja` lines stop**
  (nothing fetched while paused); TR keeps going. After **Go live** they resume within the usual wait. If the
  `translate ja` lines do not stop, cut that half-sentence of the VO.
- **VO (46 words, 18.4 s):** "This terminal is the server, printing every call to Meta's models as it happens: speech
  to captions, then one translation per language. Pause, and that listener's translations stop: nothing is fetched
  for a viewer who isn't watching. A whole lecture costs cents per language."

### 6 · 1:20–1:38 · Slides and ink, and following the speaker

- **POV:** **Speaker** (blue) 1:20–1:27, then **Listener TR** (amber).
- **Clicks (Speaker):** dock pager **›** to page 3 → tool rail **Pen** → draw a circle on the diagram → **Laser**,
  point at it for 2 s. **(Listener TR):** hover the Slides tile → **‹** once → it reads "Slide 2 of 4 · the speaker
  is on 3" → **Follow the speaker**.
- **Make visible:** the circle and laser reach the listener's Slides tile (amber frame) at once; stepping back
  shows "the speaker is on 3"; **Follow the speaker snaps back** to page 3 with the circle.
- **VO (33 words, 13.2 s):** "The slides are a track too. My pen and laser reach every listener live. Step back to
  an earlier slide on your own, and one click follows the speaker again."

### 7 · 1:38–1:53 · Slides described for people who can't see them

- **POV:** **Listener TR** (amber) with the **Chapters** card open on **Slides**; terminal band with the
  `describe slide` line boxed. 1:48–1:53: insert from a demo talk (pickup **P2**): the **Speaker** tile cropped from
  the conference video beside the slides.
- **Clicks:** none live (Listener TR opened **Chapters** → **Slides** before the take; the page turn in beat 6
  triggers it).
- **Make visible:** a new description for page 3 arrives 5–15 s after the turn; the terminal shows the call that
  made it. In the insert: the speaker tile shows only the speaker, cropped, never the whole stage.
- **VO (29 words, 11.6 s):** "Each new slide is described by a Meta model, for anyone who can't see it. In recorded
  conference talks, the speaker is cropped out of the stage video into their own tile."

### 8 · 1:53–2:10 · Missed something? Rewind

- **POV:** **Listener JA** (green); terminal band.
- **Clicks (Listener JA):** click the stage once (focus, not a field) → **J J J** (back 30 s) → wait 8 s → the
  pill's **Go live** (or **G**).
- **Make visible:** the pill shows how far behind; the slide, the pen circle and the Japanese subtitles replay as
  they were; the terminal shows **no new `translate ja` call for the past** (box it, label "no new calls"); **Go
  live** returns to now.
- **VO (36 words, 14.4 s):** "Missed something? Jump back thirty seconds: the slide, the ink and the Japanese
  subtitles replay exactly as they were. And no new model call: the past comes from the same tracks, cached. One
  click, and you're live again."

### 9 · 2:10–2:22 · Chapters, terms and transcript

- **POV:** **Listener TR** (amber), the right-hand card.
- **Clicks (Listener TR):** **Chapters** (bottom-right) → **Chapters** view → **Terms** → **Transcript**
  (bottom-right) → type a word in *Search the transcript*.
- **Make visible:** a chapter list built during the talk; glossary terms; the transcript with the Turkish line
  beside each English one; search hits highlighted.
- **VO (24 words, 9.6 s):** "A running outline too: chapters and key terms, revised as the talk goes, and a full
  transcript you can search, in your language."

### 10 · 2:22–2:40 · End talk: it stays as a recording

- **POV:** **Speaker** (blue) 2:22–2:28, then **Listener TR** (amber) on the replay.
- **Clicks (Speaker):** red **End talk** (dock centre) → *End the talk?* → **End talk** → *How it went* →
  **Open replay**. **(Listener TR, after the take, pickup P1):** reload the audience link → it is a recording →
  **CC** → `tur` → *Turkish · Türkçe* → click the timeline about a third in.
- **Make visible:** the end screen's real facts; the recording plays the Turkish at once at a part watched live
  (≈0.25 s); the slides and ink are there.
- **VO (31 words, 12.4 s):** "When I end the talk, it's already a recording: every track kept, seekable, in any
  language. The hub lists live talks and recordings, including four conference talks to try."

### 11 · 2:40–2:52 · Close

- **POV:** the hub (pickup P3, any window, blue frame) 2:40–2:46: *Live now* and *Recordings* rows; then the end card
  with `talk-tracks.leventaksakal.com`.
- **Clicks:** scroll the hub once, slowly.
- **VO (14 words, 5.6 s):** "Talk Tracks: every AI job a track you choose. Try it live, today."

---

**Totals:** 2:52; VO 29 + 34 + 30 + 27 + 46 + 33 + 29 + 36 + 24 + 31 + 14 = **333 words**, 133 s at 150 wpm inside
172 s. Tightest: beat 5 (18.4 s in 20 s) and beat 8 (14.4 s in 15 s): read them evenly.

If the opening line must name what is not ours in full, the [submission text](submission.md) carries it: the MoQ
relay and `@moq/*` libraries, Media Chrome, hls.js, PDF.js, Meta's models, the EMF 2026 demo lectures (CC BY-SA 4.0).

## Feature checklist

| Feature live on 3f570fc | Beat | Note |
|---|---|---|
| Start a talk modal (title, speaker, room, access code) | not shown | the access code is typed in it; done before OBS starts |
| "Your talk is ready" modal: QR, room code, links, Copy, Done | not shown | shows the private speaker link |
| Console header time · title · room ⓘ → Talk details (link, Copy, QR, Show full screen) | 2 | audience link and QR only |
| Green room: preview with mic/camera toggles, mic meter, camera, screen with sound | 1, 2 | screen share not shown (time) |
| Slides setup: drop PDF/PPTX/images → thumbnails | 2 | |
| Go on air pinned bottom | 2 | |
| Tool rail: pen, highlighter, shapes, arrow, line, laser, underline, mark text, eraser, undo/redo/clear | 6 | pen and laser only; the rest are a 1 s glimpse of the rail |
| Dock: pager, mic, camera, share, hide slides, pause, End talk; Slides, Audience, Questions | 6, 10 | pager and End talk; Audience/Questions not shown (no audience chat in a solo take) |
| End screen "How it went" + Open replay | 10 | |
| Hub: 4 demo talks, Live now / Recordings, presenters' rooms | 10 (VO), 11 | |
| Meet-style tiles with frame colours, names bottom-left | 3–9 | the DaVinci borders echo them |
| Bottom bar: play, volume slider, CC, ⋮ More options | 3, 5 | |
| CC list: Off, Original, 50 languages A–Z, type to jump | 3, 4 | |
| Live translation into any language, lazily started | 3, 4, 5 | |
| Pause stops subtitles and fetching | 5 | |
| Seek while paused stays paused | not shown | true but invisible; no time |
| Slides tile: ‹ › "Slide N of M", the speaker is on N, Follow the speaker | 6 | |
| All slides strip; Match the playhead (recording) | not shown | one slide-nav moment is enough |
| Speaker tile cropped from the conference video / "Speaker off camera" | 7 (insert P2) | crop exists only in the demo talks; your live talk shows your camera |
| Slide descriptions (describe agent) | 7 | Chapters → Slides |
| Rewind (J), Go live (G), no new calls for the past | 8 | |
| Chapters panel: Chapters, Terms, Slides | 7, 9 | |
| Transcript panel, search, translation beside each line | 9 | download not shown |
| Chat, Discussion panels | not shown | need a second person writing |
| More options: Adjust view (Auto/Tiled/Spotlight/Sidebar), Full screen, Picture-in-picture, Settings, Keyboard shortcuts | not shown | presentation; time goes to AI tracks |
| Drag a tile label to dock/float | not shown | as above |
| Stats for nerds (I or right-click) | not shown | the terminal tells the same story better |
| Recording after End talk, seek with translation | 10 | |
| Spend ledger, AI on the VM via Meta | 5 (terminal) | never show spend in the player itself |

## Shot order (one take, top to bottom)

**Before OBS (nothing private may be recorded):**

1. Hub → **Start a talk** → title, your name, room name `video-take1`, access code (by hand) → **Start** → **Copy**
   the audience link and the speaker link → **Done**. (Off camera.)
2. Speaker: open the speaker link in native Chrome, maximise on Monitor 1; allow mic and camera. Stay in the green
   room; do **not** go on air yet; mic and camera **off**, no PDF dropped yet.
3. Listener TR: `Ctrl+Shift+N`, paste the audience link, right-click the tab → **Mute site**. Open **Chapters** →
   **Slides** (starts the describe agent). Subtitles **Off**. Monitor 2, left half.
4. Listener JA: a second incognito window, same link, **Mute site**. Open **Chapters** → **Chapters**. Subtitles
   **Off**. Monitor 2, right half.
5. Terminal: `ssh -t $VM 'clear; python3 ~/talk-tracks/deploy/meta-calls.py --room video-take1 --width 110'`.
6. A second incognito tab (muted), on the hub's demo talk under *Live now*, for pickup P2.
7. OBS: four sources in quadrants, address bars cropped; Do not disturb on; headphones on.

**Record (OBS ● Start Recording), then in this order:**

| # | Window | Do | Beat |
|---|---|---|---|
| 1 | — | 3 s still on the green room | 1 |
| 2 | Speaker | mic on, say a line, meter moves → camera on → Slides: drop the PDF → **Go on air** | 2 |
| 3 | Speaker | **ⓘ** → Talk details → close | 2 |
| 4 | Speaker | start the talk: page 1, full plain sentences, pause between them; keep talking throughout | — |
| 5 | Listener TR | **CC** → `tur` → *Turkish · Türkçe*; wait for the first line (≤ 15 s) | 3 |
| 6 | Listener JA | **CC** → `jap` → *Japanese · 日本語*; wait for the first line | 4 |
| 7 | Speaker | › to page 2; talk 40 s | — |
| 8 | Listener JA | ⏸ pause, 5 s, ▶ play, **Go live** | 5 |
| 9 | Speaker | › to page 3 → **Pen**: circle the diagram → **Laser** 2 s | 6 |
| 10 | Listener TR | hover Slides tile → ‹ → read "the speaker is on 3" → **Follow the speaker** | 6 |
| 11 | Listener TR | wait for page 3's description in Chapters → Slides (≤ 15 s) | 7 |
| 12 | Speaker | talk on to clock ≈ 3:00 (page 3, then page 4) | — |
| 13 | Listener JA | click the stage → **J J J** → wait 8 s → **Go live** | 8 |
| 14 | Listener TR | **Chapters** → **Chapters** → **Terms** → **Transcript** → search a word you said | 9 |
| 15 | Speaker | closing line → **End talk** → **End talk** → *How it went* → **Open replay** | 10 |
| 16 | Listener TR | **P1**: reload → recording → **CC** → `tur` → Turkish → click the timeline a third in; hold 5 s | 10 |
| 17 | Listener JA | **P2**: switch to the demo-talk tab → hover the Speaker tile (cropped speaker), 5 s | 7 |
| 18 | Listener JA | **P3**: the hub, scroll slowly through *Live now* and *Recordings* | 11 |
| 19 | — | OBS ■ Stop Recording | |

About 6–7 minutes. Then the VO, one clip per beat, and the DaVinci cut. If step 5 shows nothing after 20 s: look at
the terminal (no `translate tr` line → reload Listener TR and pick again, keep recording; cut the miss).

## After the edit (check before upload)

- [ ] Total ≤ 2:55; the opening line done by 0:12.
- [ ] Freeze-frame pass at 1 s steps: no access code, speaker link, token, VM address or host, e-mail or
      notification in any frame, terminal included.
- [ ] English captions for the VO; an English caption under the first Turkish and Japanese lines.
- [ ] Credit line in the description if the demo-talk insert (P2) is in: "Demo lectures: Electromagnetic Field
      2026, EMF Video Team and C3VOC, CC BY-SA 4.0 (media.ccc.de). Trimmed, re-encoded, AI tracks added."
