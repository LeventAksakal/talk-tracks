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
anyone else, or any recorded screen.** Type the code yourself, by hand, only into the site's *Start a talk* form and,
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
7. In the viewer: **Chapters** (bottom-right) → **Slides** view.
8. Talk in full, plain sentences for 3–4 minutes (pages 1–3, the
   [cue lines](../submission-video.md#the-lecture-the-owner-gives)). At about 0:30 in the viewer: **CC** →
   type `tur` → **Turkish · Türkçe**. Then open a second viewer tab (muted)
   and pick `jap` → **Japanese · 日本語** (check: two languages at once, as in beat 4).
9. Turn to page 3, pick **Pen**, draw a circle. Watch the viewer: the circle appears at once; the Slides view shows
   a description within 15 s.
10. In the viewer, click the stage, **J J J** (back 30 s): slide, circle and subtitles replay. **G** returns to live.
11. Page 4, **End talk** → confirm.
12. Open the same `/watch/<room>` again (muted): it is now a **recording**. **CC** → `tur` → **Turkish · Türkçe**, then click
    the timeline inside the part you watched live. The subtitle is there at once.
13. Tell the coordinator what you saw, one line per problem. It goes into the feedback ledger.

**Good looks like**

- *On air* within ~10 s; the viewer hears you and sees camera and page 1; the meter moves.
- First Turkish subtitle **7–12 s** after the pick; Japanese the same
  ([measured waits](../submission-video.md#waits-measured-on-the-live-site-11-03-and-what-the-cut-does-with-them)).
- The talk did not pause or jump while you typed in the CC list.
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
   on screen. Create each take's room **before OBS starts** (one room per take: `video-take1`, `video-take2`).
4. **OBS:** one scene, four *Window Capture* sources, canvas 3840×2160 30 fps, NVENC CQP 20, mic on track 1 only,
   desktop audio off ([the four windows](../submission-video.md#the-four-windows-povs-and-their-davinci-frames)).
5. **Terminal of Meta calls**: Windows Terminal, Cascadia Mono 22 pt, dark, tab title `Meta API calls`. Start it
   straight from ssh so no prompt is drawn:
   `ssh -t $VM 'clear; python3 ~/talk-tracks/deploy/meta-calls.py --room video-take1 --width 110'`.
   OBS records it as the fourth window; restart it with each take's room.
6. **OBS layout** for the one-take shoot: see [the four windows](../submission-video.md#the-four-windows-povs-and-their-davinci-frames) (3840×2160 canvas, four window captures in quadrants, address bars cropped).
7. **Do not disturb** on, Focus session on; quit chat, mail, updaters.
8. **Audio safety:** no viewer tab unmuted on this machine while on air. No agent or QA stream plays on this device;
   if anything starts making sound that is not you, close that tab and tell the coordinator.
9. Read the [script's beats](../submission-video.md#beats) aloud once, VO lines only, against a stopwatch.

**Good looks like:** every recorder shows a picture; a 10 s test clip in OBS plays back with your voice on track 1
only; the terminal prints lines for the room; the coordinator says the tag `submission-2026-11-04` is deployed and
the smoke check passed.

**If it goes wrong:** no OBS → Snipping Tool → Record per monitor (sound on); Resolve conforms the frame rate. The
terminal shows nothing → wrong `--room` or ssh dropped; restart it (permission denied on the archive → prefix
`sudo`). Smoke check not green by 21:45 → ask the coordinator whether to shoot on the current build or wait.

---

## 3 · The shoot: alone, one take, four windows (updated 11-04 night)

**Why.** The video is one real live talk recorded in one OBS take: the speaker console, two muted incognito
listeners (Turkish and Japanese) and a terminal of live Meta API calls; it scores under Demo (25 %), and judges stop
at 3:00 ([rules](../workstreams/07-submission.md#the-rules-checked-2026-11-02)). No friends, no phone, no clap.

**Follow [the script's Shot order](../submission-video.md#shot-order-one-take-top-to-bottom) top to bottom while
OBS records.** It lists the setup before OBS starts (room, windows, mute, terminal command), the 19 steps of the
take, and the pickups. The beats, borders and labels for DaVinci are in the same file
([Beats](../submission-video.md#beats), [the four windows](../submission-video.md#the-four-windows-povs-and-their-davinci-frames)).

| Time | What | Done when |
|---|---|---|
| 0:00–0:10 | Setup before OBS: room, Speaker window, two muted incognito listeners, terminal, OBS quadrants | every quadrant shows a picture, address bars cropped |
| 0:10–0:20 | The take (steps 1–19) | OBS stopped after the hub pickup |
| 0:20–0:25 | Scrub the recording: Turkish and Japanese arrived, `translate` lines in the terminal, the circle reached the listener | keep, or one more take in a new room |
| 0:25–0:35 | Voice-over, 11 clips, one per beat | each clip within its beat's length |

**Good looks like:** Turkish within ~15 s of the pick; JA's subtitles and `translate ja` lines stop while paused; a
`describe slide` line within 15 s of the page turn; no new `translate ja` line during the rewind; the replay plays
Turkish at once; no code, speaker link, token, hostname, e-mail or notification in any frame.

**If it goes wrong:** no subtitle after 20 s → reload that listener and pick again, keep recording, cut the miss.
The console will not go on air → reload it; still failing → shoot the listeners on a demo talk under *Live now* and
drop beats 2, 6 and 10's speaker shots. *Capped* → new room, new take.

---

## 4 · 23:00–23:35 · Edit, export, upload

**Why.** Judges stop at 3:00 and score the video's quality; the link must play for anyone logged out.

**Steps**

1. **Edit** in DaVinci Resolve per the [edit plan](demo-video-shoot.md#the-davinci-edit-plan): 1920×1080 30 fps;
   *Auto Align Clips → Based on Waveform* on the clap with S's mic as reference; VO on A2; your mic (A1) under it at −20 dB. The
   one OBS clip holds all four windows: crop each quadrant per beat. The beat table there gives each beat's layout, cut points and zooms.
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
the opening line done by 0:12, VO captions, the link plays logged out.

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
2. **The demo-talk and hub pickups** (P2, P3): end on the recording (beat 10) and the end card.
3. **The pause half of beat 5**: keep the terminal highlights.
4. **Beat 9 (chapters and transcript)**: its 12 s go to the end card.
5. **Zooms, highlight boxes and lower thirds** beyond the opening one; keep the band and the English captions.
6. **HD processing wait**: submit with the unlisted link while YouTube processes.
7. **The 00:00 target itself**: if the cut is not right, the rules allow until 05:00 +03; the runbook's last moment
   to submit is **03:30**. Never trade the logged-out check or the privacy pass for time.

---

## Known gaps between the docs (for the coordinator)

- **Clock.** The runbook plans the night from 22:00 to a 03:30 submit (VO 23:55–00:20, sync and edit to 01:45,
  export 02:40, upload 03:05). This evening's plan gives the edit, export and upload **35 minutes** (23:00–23:35)
  against the runbook's ~2 h 45 min. Expect to need the cut list, or to move the submit past 00:00 (deadline 05:00).
- **Shoot plan changed (11-04 night).** One take, owner alone, four windows; the runbook's friends, phone and take sheet are superseded by [the script](../submission-video.md).
- **Video length.** The script is 2:49 (≤ 2:50 at the edit check); `07-submission.md` still says 2:55 and the
  feedback ledger says 2:58. The rule is 3:00; aim for the script's 2:49.
- **Owner items.** WEB-SPEAKER-CHECK, P-DRIFT and HUMAN-QA are named only in the 11-03 hand-off, not defined in the
  wiki; the definitions in block 1 are inferred.
- **Form fields.** Only *reported* (an entrant read them); the owner sees the real form first at 23:35.
