# Owner run sheet, Nov 4 evening to submission

One page for the owner's second screen: only the steps that need a human, in time order. Every block says what to
do, why, what good looks like, and what to do if it goes wrong. The detail lives in the
[shoot runbook](demo-video-shoot.md), the [video script](../submission-video.md) and the
[submission text](../submission.md); this sheet links to their sections by heading. "(check)" marks a line this
sheet inferred rather than read in those docs.

**Times are +03.** The coordinator's target is **Submit at 00:00**. The hard deadline is **Nov 4, 9 PM EST = Nov 5
05:00 +03** ([rules](../workstreams/07-submission.md#the-rules-checked-2026-11-02)); the runbook's own last moment
to submit is 03:30. The 00:00 plan is tighter than the runbook (see *Known gaps* at the end).

**Never paste the access code, a speaker link, a token or the VM's address into chat, the repo, a message to the
friends, or any recorded screen.** Type the code yourself, by hand, only into the site's *Start a talk* form and,
at the end, the submission form.

**Who to tell:** anything that blocks you goes to the coordinator session, in plain words ("the console will not go
on air", "no Turkish after 20 s"). Lanes never ask you; the coordinator does.

---

## 1 · 20:00–21:15 · Rehearsal on the live site (speaker → End talk → recording)

**Why.** The speaker going on air with a real mic and camera, and End talk turning the room into a recording, have
never been run by a human on the live site: they need your access code, which agents never hold
([owner feedback, 11-03 evening](../owner-feedback.md)). If they fail, the coordinator still has time to fix and
redeploy before the 21:15 freeze.

**The open owner items this block closes** (named in the coordinator's hand-off; the definitions below are this
sheet's reading of the docs, (check)):

- **Speaker console works with a real mic and camera (WEB-SPEAKER-CHECK):** the console reaches *On air*, a viewer
  hears you, sees your camera and your PDF pages ([web.md, Speaking](web.md#speaking)).
- **Ink and marks keep up with the playhead (P-DRIFT):** your pen strokes reach the viewer at the moment you draw
  them, not trailing behind; target: within one 4 s slice of the playhead
  ([05-platform-gaps log, 10-31 14:40](../workstreams/05-platform-gaps.md#log)).
- **A human runs a real lecture end to end (HUMAN-QA):** you give a few minutes of real talk and watch it as a
  viewer would, then as a recording ([plan.md](../plan.md)).

**Steps**

1. Desktop Chrome → https://talk-tracks.leventaksakal.com → **Start a talk**.
2. Fill in a title, your name, a throwaway **room name** (3–40 of `a-z0-9-`, e.g. `owner-check-1` (check)) and type
   the **access code** by hand. **Start**. You get a **speaker link** (private) and an **audience link**
   (`/watch/<room>`) ([runbook, The rooms](demo-video-shoot.md#the-rooms)).
3. Open the speaker link as an app window (no address bar): `start chrome --app="<speaker link>"`, typed or pasted
   in your own terminal, never in a chat. **Open console**.
4. In the console: microphone and camera on, drop in your 4-page PDF, watch the level meter move as you speak.
5. **Go on air.** The badge says *On air* once the relay carries your audio back (up to ~10 s).
6. **Viewer window, muted.** Open the audience link in a second browser (a second Chrome profile or Edge), and mute
   it first (right-click the tab → *Mute site*) (check: the docs say "muted tab", not how). An unmuted viewer
   feeds the lecture back into your mic ([runbook, Audio safety](demo-video-shoot.md#audio-safety)).
7. In the viewer: **S** → *Chapters* → *Slides*. Press **I** (stats): *Slide descriptions* says **on**.
8. Talk in full, plain sentences for 3–4 minutes (pages 1–3, the
   [cue lines](../submission-video.md#the-lecture-the-owner-gives)). At about 0:30 in the viewer: **CC** →
   *Search any language* → type **Tur** (capital T) → **Türkçe · Turkish**. Then open a second viewer tab (muted)
   and pick **Jap** → **日本語 · Japanese** (check: two languages at once, as in beat 4).
9. Turn to page 3, pick **Pen**, draw a circle. Watch the viewer: the circle appears at once; the Slides view shows
   a description within 15 s.
10. In the viewer, click the stage, **J J J** (back 30 s): slide, circle and subtitles replay. **G** returns to live.
11. Page 4, **End talk** → confirm.
12. Open the same `/watch/<room>` again (muted): it is now a **recording**. **CC** → **Tur** → **Türkçe**, then click
    the timeline inside the part you watched live. The subtitle is there at once.
13. Tell the coordinator what you saw, one line per problem. It goes into the feedback ledger.

**Good looks like**

- *On air* within ~10 s; the viewer hears you and sees camera and page 1; the meter moves.
- First Turkish subtitle **7–12 s** after the pick; Japanese the same
  ([measured waits](../submission-video.md#waits-measured-on-the-live-site-11-03-and-what-the-cut-does-with-them)).
- The talk did not pause or jump while you typed **Tur** / **Jap**
  ([the typing trap](../submission-video.md#the-typing-trap-in-the-language-search)).
- Pen circle on the viewer with no visible lag; a slide description within 5–15 s.
- Rewind in about 0.5 s; *Go live* in about 0.2 s.
- After End talk the room opens as a recording; a seek inside the watched part shows Turkish in about 0.25 s.

**If it goes wrong** ([runbook, If something fails](demo-video-shoot.md#if-something-fails))

| Problem | Do |
|---|---|
| Not *On air* | Reload the console, Go on air again. Still failing → tell the coordinator now; the shoot falls back to the demo live session `/watch/dataviz` ([alternate cut](../submission-video.md#the-alternate-cut-one-viewer-or-none)). |
| Talk paused while typing | A lowercase k, j or space reached the player: press play, type with a capital first letter. |
| No subtitle after 20 s | Reload the viewer and pick again; tell the coordinator (it checks the translate agent's logs on the VM). |
| No slide description | The Slides view was not open before the page turn: open it, turn the page again. |
| Ink trails the playhead | Note how many seconds; tell the coordinator (P-DRIFT). |
| Ended room does not open as a recording | Tell the coordinator; beat 10 then uses `/watch/dataviz-recording`. |
| *Capped* | Create a new room with the code. |

---

## 2 · 21:15–21:45 · Rig setup (coordinator freezes and deploys meanwhile)

**Why.** Every screen must record at the same size and with clean audio tracks, or the edit cannot line them up; and
nothing private may ever appear in a frame. Setting up before the frozen build is out costs nothing.

**Steps** ([runbook, Recording settings](demo-video-shoot.md#recording-settings))

1. **Display** 1920×1080, Windows *Scale* **100 %** (or keep 125 % and set Chrome zoom to 80 %).
2. **Browser:** a fresh Chrome profile or a Guest window, no bookmarks bar, no extensions, no other tabs, zoom 100 %.
3. **Console window:** the speaker link as an app window (`start chrome --app=...`), so no address bar or token is
   on screen. Create each take's room **before OBS starts** (one room per take: `lecture-rehearsal`,
   `lecture-take1`, `lecture-take2`, `lecture-take3`).
4. **OBS:** Video base and output 1920×1080, **30 fps**; Output *Hybrid MP4*, NVENC H.264 (else x264 veryfast),
   CQP 18–20; Audio tracks 1 and 2, *Advanced Audio Properties*: **mic on track 1 only, desktop on track 2 only**;
   source *Display Capture*. Your mic on track 1 is the master audio of the whole video.
5. **Terminal of Meta calls** ([runbook, The terminal of Meta calls](demo-video-shoot.md#the-terminal-of-meta-calls)):
   Windows Terminal, Cascadia Mono 22 pt, dark scheme, no scrollbar, padding 16, tab title `Meta model calls` with
   *Suppress title changes*, about 1920×600. Start it straight from ssh so no prompt is drawn:
   `ssh -t <vm-alias> 'clear; python3 ~/talk-tracks/deploy/meta-calls.py --room lecture-take1 --width 110'`.
   Restart it with each take's room. Record it with a second recorder (Snipping Tool → Record on its region, or
   Win+G).
6. **Phone** on a stand, landscape, 1080p 30 fps, framing you at the laptop with the console over your shoulder.
7. **Do not disturb** on, Focus session on; quit chat, mail, updaters.
8. **Audio safety:** no viewer tab unmuted on this machine while on air. No agent or QA stream plays on this device;
   if anything starts making sound that is not you, close that tab and tell the coordinator.
9. Read the [script's beats](../submission-video.md#beats) aloud once, VO lines only, against a stopwatch.
10. Phone the friends (on the phone, never on a recorded screen); they set up from
    [the message to the friends](demo-video-shoot.md#the-message-to-the-friends). The runbook booked them for
    22:45–23:55; the 21:45 start needs them earlier (check that they moved).

**Good looks like:** every recorder shows a picture; a 10 s test clip in OBS plays back with your voice on track 1
only; the terminal prints lines for the room; the coordinator says the tag `submission-2026-11-04` is deployed and
the smoke check passed.

**If it goes wrong:** no OBS → Snipping Tool → Record (full screen, sound on); Resolve conforms the frame rate. The
terminal shows nothing → wrong `--room` or ssh dropped; restart it (permission denied on the archive → prefix
`sudo`). Smoke check not green by 21:45 → ask the coordinator whether to shoot on the current build or wait.

---

## 3 · 21:45–23:00 · The shoot (frozen build)

**Why.** The video is one real live lecture filmed from three points of view, with the terminal of live Meta calls;
it scores under Demo (25 %), and judges stop at 3:00
([rules](../workstreams/07-submission.md#the-rules-checked-2026-11-02)).

**Take strategy (from the runbook).** Not beat by beat: each take is **one continuous ~6-minute lecture** in its own
room, everyone following the [take sheet](demo-video-shoot.md#the-take-sheet-one-take-about-6-minutes) on a
stopwatch started at your clap; every beat is cut from it in the edit. Up to three takes; take 3 only if neither
take has beats 3, 6 and 7 clean; then pickups (beat 10's recording R, the phone shots for beat 1, a friend's 3 s
selfie). The voice-over is recorded **after** the shoot, one clip per beat, same mic, quiet room.

**Compressed clock** (the runbook's 22:45–23:55 blocks, fitted to 21:45–23:00 (check)):

| Time | What | Done when |
|---|---|---|
| 21:45–21:50 | Friends on the phone; they check full screen, 100 %, OBS 1080p30, headphones, DND. Send them the rehearsal room's audience link by phone. | both see the waiting screen |
| 21:50–22:00 | Short rehearsal in `lecture-rehearsal` ([checklist](demo-video-shoot.md#rehearsal-22502305-15-minutes)); shorter than the runbook's 15 min because block 1 already tested your side (check). | V1 on Slides, V2 on Chapters, **I** shows both **on** |
| 22:00–22:08 | **Take 1** (`lecture-take1`, terminal restarted on it). | End talk pressed |
| 22:08–22:13 | Review: each friend says what they saw; you scrub the terminal recording. | keep or redo |
| 22:13–22:21 | **Take 2** (new room). | |
| 22:21–22:35 | Take 3 only if beats 3, 6, 7 are not clean in either take; else **pickups**: R, phone shots, selfie. | |
| 22:35–22:42 | Friends stop recording and upload `v1-takeN.mp4` / `v2-takeN.mp4`. Thank them. | files arriving |
| 22:42–23:00 | **Voice-over**, 11 clips, one per beat, while files download. | each clip within its beat's length |

**The beats** (final cut, 2:49; full lines in [the script's Beats](../submission-video.md#beats)). "Talk clock" is
when it happens in the take; "Length" is the beat in the final cut.

| # | Purpose | Screen / source | Action on camera (talk clock) | VO gist | Length |
|---|---|---|---|---|---|
| 1 | What was built this week vs what pre-existed | title card, phone **P**, 1 s of V1 and V2 | nothing; phone runs from before the clap | "Built this week from Oct 27th … Not ours: the MoQ relay, player controls, Meta's models" (38 words) | 0:00–0:17 |
| 2 | A live lecture leaves people out | console **S** big, V1/V2 small | you say the p1 line to camera (0:05) | "A live lecture reaches only those who speak its language; two friends watch" | 0:17–0:29 |
| 3 | Viewer 1 picks Turkish | V1, terminal band from 0:35 | V1: CC → **Tur** → Türkçe, hands off (0:30) | "Nothing translated into Turkish until this click; a Muse Spark agent starts" | 0:29–0:49 |
| 4 | One sentence, two languages | V1 \| V2 split, band | V2: CC → **Jap** → 日本語 (1:00); you say the p2 line | "Same sentence, two languages; fifty work, each made only while watched" | 0:49–1:03 |
| 5 | Meta's models at work | terminal half screen, V1 and V2 above | none; keep talking | "Every Meta call as it happens: Transcribe → captions, Spark → each language; ~14 ¢ a lecture per language" (53 words, tightest) | 1:03–1:26 |
| 6 | A slide described | S full, then V1's Slides view | you: **Next** to p3, **Pen**, circle the diagram, p3 line (2:00) | "Muse Spark describes each new slide for anyone who can't see it" | 1:26–1:43 |
| 7 | Rewind costs no model call | V2, band | V2: click stage, **J J J**, 8 s, **G** (3:00) | "Jumps back 30 s; slide, pen and Japanese replay; no new call" | 1:43–2:03 |
| 8 | Chapters, glossary, recap | V2's panel | V2: **Terms**, 2 s, **Chapters** (3:30) | "A running outline, revised as the talk goes" | 2:03–2:13 |
| 9 | Under the hood | V1 with stats | V1: click stage, **I**, hold 12 s, close (4:00) | "Every AI job is a MoQ track; lazy agents; the stream-credit bug we fixed" (50 words) | 2:13–2:35 |
| 10 | It stays as a recording | S (End talk), then **R** | you: p4 line, **End talk** (5:00); after: muted tab, Tur, seek a third in | "When I end the talk, it stays online with every track" | 2:35–2:45 |
| 11 | End card | end card | — | "Talk Tracks. Try it live." | 2:45–2:49 |

Before every take: V1's panel on *Chapters → Slides*, V2's on *Chapters → Chapters*, subtitles **Off**
([what the viewers switch on](../submission-video.md#what-the-viewers-must-switch-on-before-the-talk-starts)).

**Good looks like:** a take where Turkish arrives in 7–12 s, the terminal prints `translate tr` / `translate ja`,
`describe slide` within 15 s of the page turn, a `chapters` line by 3:00, and V2's rewind shows no `translate ja`
line for the past; no code, link, token, hostname, e-mail or notification in any frame.

**If it goes wrong:** per beat, each beat in the script has its *Can go wrong → fallback* line. The big ones:
22:35 with no usable take → shoot [the alternate cut](../submission-video.md#the-alternate-cut-one-viewer-or-none)
alone (one friend two windows, or the demo live session `/watch/dataviz` with `--room dataviz`). A friend drops
out → the same alternate cut. *Capped* → new room, redo the take.

---

## 4 · 23:00–23:35 · Edit, export, upload

**Why.** Judges stop at 3:00 and score the video's quality; the link must play for anyone logged out.

**Steps**

1. **Edit** in DaVinci Resolve per the [edit plan](demo-video-shoot.md#the-davinci-edit-plan): 1920×1080 30 fps;
   *Auto Align Clips → Based on Waveform* on the clap with S's mic as reference; VO on A2; your mic (A1) is the
   master; friends' audio muted. The beat table there gives each beat's layout, cut points and zooms.
2. **Captions:** English captions for the VO (upload an `.srt` of the VO lines, or YouTube *Auto-sync* by pasting
   the VO text), plus an English caption under the first Turkish and Japanese lines (V7 text track).
3. **Privacy pass:** step through every cut at 1 s: no access code, speaker link, token, VM address or host,
   e-mail, notification, the terminal band included. Blur anything that is.
4. **Export** ([Export](demo-video-shoot.md#export)): MP4 H.264 High, 1920×1080 30 fps, 8 000 Kb/s, AAC 48 kHz
   stereo 320 kb/s, `talk-tracks-demo.mp4` (about 175 MB). Play it once: length, sound in both ears.
5. **Upload** ([Upload and submit](demo-video-shoot.md#upload-and-submit)): YouTube → *Create → Upload video*.
   Title *Talk Tracks: a live lecture in any language (Meta Global AI Developer Hackathon)*. Description: two
   sentences, the site link, the repo link, and the EMF credit line only if a demo room is in the cut. *Not made for
   kids*. **Visibility: Public** if the form allows any link, else **Unlisted**; never Private. The rules say
   "unlisted or public" ([rules](../workstreams/07-submission.md#the-rules-checked-2026-11-02)).
6. *Subtitles → Add → Upload file* (the `.srt`).
7. **Logged-out check** in a private window: it plays to the end, says under 3:00, captions turn on (1080p may still
   be processing; an unlisted link works before HD finishes).
8. **Send the coordinator the YouTube URL** (the `https://youtu.be/...` or `watch?v=` link, nothing else). It goes
   into [submission.md, Demo Video](../submission.md#demo-video-owner) and is committed before you submit.

**Good looks like** ([After the edit](../submission-video.md#after-the-edit-checked-before-upload)): total **≤ 2:50**,
the opening line done by 0:17, VO captions, the friends agreed to appear, the link plays logged out.

**If it goes wrong:** not locked by 23:20 → drop beat 8 and give its 10 s to beat 9, then the cut list below. Export
fails → export what is locked as it is. YouTube stuck processing → submit with the unlisted link; HD finishes
later.

---

## 5 · 23:35–00:00 · The form

**Why.** The form is the submission; after it, the repo is frozen ("Changing the repository after the deadline will
mark this project late"). Sign in at the
[Cerebral Valley submit page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit). The fields
below are the ones *reported* for the form; agents never saw it, so map what you see (check).

| Form field | Value is in `wiki/submission.md` | Who |
|---|---|---|
| Project name | [Project name](../submission.md#project-name): Talk Tracks | paste |
| Tagline (if any) | [Tagline](../submission.md#tagline-if-the-form-has-one) | paste |
| Track | [Track and theme](../submission.md#track-and-theme-owner): **Indie developer** (decided, ticket 0027) | **owner** picks it |
| Theme | same section: **Build for Your World** | **owner** picks it |
| Team members | [Team](../submission.md#team): Levent Aksakal (solo) | **owner** adds himself |
| GitHub Repository | [GitHub Repository](../submission.md#github-repository) | paste |
| Live Project | [Live Project](../submission.md#live-project) | paste |
| Demo Video | [Demo Video](../submission.md#demo-video-owner): your YouTube URL | **owner** |
| Project Description | [Project Description](../submission.md#project-description), all its subsections | paste |
| Notes / how to try (if any; else append to the description) | [How judges try it](../submission.md#how-judges-try-it-put-in-the-description-or-a-notes-field-if-the-form-has-one) | paste, then **type the access code by hand** over the `<ACCESS CODE …>` placeholder |
| Cover image (only if asked) | not in submission.md: `web/public/og.png` (1200×630) or the title card (1920×1080) ([rules table, Images](../workstreams/07-submission.md#the-rules-checked-2026-11-02)) | owner uploads |

**Before pressing Submit (owner)**, verbatim from [submission.md](../submission.md#before-pressing-submit-owner):

- [ ] **Demo video** link is on YouTube, **unlisted or public** (not private), opens in a logged-out window, and is
      3:00 or less.
- [ ] **Repository** https://github.com/LeventAksakal/talk-tracks is **public** and opens logged out.
- [ ] **Live project** link opens, a live session plays with captions, and the access code in the form works (try
      it once with a throwaway room name).
- [ ] The access code is typed **only into the form**, never into this file or the repository.
- [ ] Track, theme and team member filled in; the description pasted from the blocks above.
- [ ] `main` is tagged and is what the VM runs.
- [ ] **After submitting, push nothing to the repository** ("Changing the repository after the deadline will mark
      this project late"). Later work waits on a branch until judging ends, or until the owner says otherwise.

**Good looks like:** the form's confirmation page. Tell the coordinator "submitted at HH:MM"; nothing is pushed
after that. Keep the VM running through judging (Nov 4–8).

**If it goes wrong:** a field you did not expect → paste the closest block, or ask the coordinator for a line (it
drafts in chat, nothing pushed). The form will not save → screenshot it, retry in a fresh window; the hard deadline
is 05:00 +03. The access code fails in the throwaway-room test → tell the coordinator before submitting (it checks
the code's caps and `max_rooms` on the VM).

---

## 6 · If time runs out: cut in this order

1. **Take 3 and the pickups** (shoot two takes, use the better beats of each).
2. **The friends' rehearsal** (block 1 covered your side; brief the friends by phone instead).
3. **Beat 8, chapters**: its 10 s go to beat 9 (the runbook's own first cut).
4. **The phone shots for beat 1**: hold the title card to 0:06, then S full frame (script, beat 1 fallback).
5. **Zooms, highlight boxes and lower thirds** beyond the opening one; keep the band and the English captions.
6. **HD processing wait**: submit with the unlisted link while YouTube processes.
7. **The 00:00 target itself**: if the cut is not right, the rules allow until 05:00 +03; the runbook's last moment
   to submit is **03:30**. Never trade the logged-out check or the privacy pass for time.

---

## Known gaps between the docs (for the coordinator)

- **Clock.** The runbook plans the night from 22:00 to a 03:30 submit (VO 23:55–00:20, sync and edit to 01:45,
  export 02:40, upload 03:05). This evening's plan gives the edit, export and upload **35 minutes** (23:00–23:35)
  against the runbook's ~2 h 45 min. Expect to need the cut list, or to move the submit past 00:00 (deadline 05:00).
- **Friends' booking.** The runbook books them for 22:45–23:55; the shoot now starts 21:45 (check they moved).
- **Video length.** The script is 2:49 (≤ 2:50 at the edit check); `07-submission.md` still says 2:55 and the
  feedback ledger says 2:58. The rule is 3:00; aim for the script's 2:49.
- **Owner items.** WEB-SPEAKER-CHECK, P-DRIFT and HUMAN-QA are named only in the 11-03 hand-off, not defined in the
  wiki; the definitions in block 1 are inferred.
- **Form fields.** Only *reported* (an entrant read them); the owner sees the real form first at 23:35.
