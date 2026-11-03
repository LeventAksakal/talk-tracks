# Shoot the demo video: a live lecture from several points of view

The runbook for [the video script](../submission-video.md): the owner gives a short live lecture, one or two friends
watch on their own machines, every screen is recorded, and the edit puts a terminal of live Meta model calls along
the bottom. Plan about 90 minutes: 20 to set up, a 5-minute dry run, two or three takes of 6 minutes, and spare.

Never write the access code, a speaker link, the VM's address or a key into this repository, a chat with the
friends that gets recorded, or a frame of the video.

## Before the shoot

### The owner: a room for the talk

The room is created the same way any presenter creates one, with an access code (decision 0025;
[tokens.md, Access codes](tokens.md#access-codes-presenters-create-their-own-room); the server side is
`agents/src/talk_tracks/archive/create.py`):

1. Open https://talk-tracks.leventaksakal.com in desktop Chrome → **Start a talk**.
2. Fill in the talk's title, your name, a **room name** (3 to 40 of `a-z`, `0-9`, `-`; not a demo room's name and
   not ending in `-recording`) and the **access code** (from `$TT_DATA/room-codes.json` on the VM; never typed where
   a recorder can see it). Use a new room name per take, for example `lecture-take1`, `lecture-take2`: each take then
   starts its own clean timeline, rewind and spend.
3. **Start** gives two links: the **speaker link** (`/talk/<room>?token=…`, private, it is the right to broadcast)
   and the **audience link** (`/watch/<room>`). The same code asking for the same room again gives a fresh speaker
   link if one is lost.
4. Open the speaker link as an app window so no address bar (and no token) is on screen:
   `chrome --app="<speaker link>"` (Windows: `start chrome --app="<speaker link>"`). **Open console** there.
5. In the console: allow the microphone and camera, drop in your PDF (3–4 pages, your own text and drawings), check
   the microphone meter. Do not press **Go on air** until every recorder is running.
6. Send the friends **only the audience link**, by a message that is not on any recorded screen.

The room's spend is held to the access code's own room cap (its caps batch, `caps/code-<label>.json`), not the demo
rooms' $5 a day.

### The friends: what to open

- **Desktop Chrome** (or Edge), up to date. Not Safari: it falls back to WebSocket, which works but is not what we
  want to film.
- A **guest window** or a fresh Chrome profile: no bookmarks bar, no extensions, no other tabs, zoom 100 %.
- The **audience link** `https://talk-tracks.leventaksakal.com/watch/<room>`. V2 (the late joiner) opens it only
  when the owner says so, about 2 minutes in.
- **Headphones**, so the friend's microphone does not pick up the lecture.
- The screen at **1920×1080**. On a larger display, set the display to 1920×1080 for the shoot, or keep the Chrome
  window at 1920×1080 and record that window. A laptop below 1080p is fine for a viewer but looks soft: say so before
  the shoot and give that POV less screen time.
- **Notifications off:** Windows, *Settings → System → Notifications → Do not disturb* (and Focus); macOS, Control
  Centre → *Focus → Do Not Disturb*. Quit chat apps, mail and anything that pops up. Hide the taskbar or Dock if
  they can.
- They should agree to appear in a public video: screen, voice, and their name if it is said.

### The owner's terminal: Meta calls on the VM

The script is in the repository (`deploy/meta-calls.py`), so the VM needs the branch with it merged into `main` and
pulled (`ssh <vm-alias> 'cd ~/talk-tracks && git pull'`; nothing restarts: it is a read-only script). It reads the
spend ledger (`~/tt-data/ledger.jsonl`) and the agents' slice files (`~/tt-data/archive/<room>/agents/…`), writes
nothing, and prints no key, token, host or address.

Open a terminal window used only for this, and start the viewer directly from ssh, so no shell prompt (which would
show the VM's user and host) is ever drawn:

```bash
ssh -t <vm-alias> 'clear; python3 ~/talk-tracks/deploy/meta-calls.py --room lecture-take1 --width 110'
```

- `--room` follows one room. Without it, every room is shown with a room column: use that (or a second terminal
  with `--room dataviz-recording`) for beat 9 of the script.
- `--no-captions` leaves out the caption lines if the band gets too busy.
- `--since 30 --no-follow` prints the last 30 minutes of calls and the total spent, then exits (no snippets: what
  each call produced is matched only while following).
- If it says permission denied on the archive, the containers wrote it as root: prefix `sudo`.

What it prints, one line per call (from a test against simulated agent writes):

```text
Meta model calls · room lecture-take1 · Ctrl-C to stop
13:54:00  captions        muse-voice-transcribe-1.0           turn  "Every AI job in this talk is its own track."
13:54:01  translate ja    muse-spark-1.3               ~1s $0.0003
          "Every AI job in this talk is its own track." → "この講演のすべてのAIジョブは独自のトラックです。"
13:54:07  describe slide  muse-spark-1.3               ~2s $0.0030
          "A diagram: the speaker, a relay and three agents, each publishing its own track."
13:54:10  chapters        muse-spark-1.3               ~3s $0.0080
          2 chapters, 1 glossary term · latest: "Tracks, not features"
13:54:10  captions        muse-voice-transcribe-1.0  1 min $0.0030  audio paid a minute ahead
```

- **captions … turn**: a final caption line from Muse Voice Transcribe's realtime stream (no per-line cost: speech
  is paid by the minute, the `1 min` line).
- **translate xx / describe slide / chapters**: one Muse Spark call, its latency (whole seconds: the ledger keeps
  seconds), its cost, and below it the input → output. `⟲` after the agent marks a back-fill (a past slice someone
  fetched, as in a recording room). `refused, $0` is a call the API turned down, not paid.
- Token counts are not shown: they are only in the agents' container logs, and the brief was to add no logging.

**Framing the terminal.** Windows Terminal: a profile with *Cascadia Mono* at **22 pt**, a dark scheme, no
scrollbar, padding 16, and *Appearance → Tab title* set to `Meta model calls` with *Suppress title changes* on (so
the title bar never shows `ssh <vm-alias>`). Size the window to about 1920×600 (110 columns × 12 rows): the edit crops
the last six lines into the 1920×270 band. Record only this window (next section), never the full desktop with an
ssh command visible.

## Recording settings

### OBS, every POV (owner and friends)

| Setting | Value |
|---|---|
| *Video → Base and Output resolution* | 1920×1080, both |
| *Video → Common FPS* | 30 |
| *Output → Recording format* | Hybrid MP4 (or MKV, then *File → Remux* to MP4); it survives a crash |
| *Output → Encoder* | NVENC H.264 or Apple VT H.264 (hardware), else x264 *veryfast*; quality CQP/CRF 18–20 |
| *Output → Audio tracks* | tick 1 and 2 |
| *Advanced Audio Properties* | microphone on **track 1 only**; desktop audio on **track 2 only** |
| Source | *Window Capture* of the Chrome window (or *Display Capture* of the 1920×1080 display) |
| Microphone | a headset or USB mic, not the laptop's; noise suppression filter on |

The owner's OBS records the console window; his mic on track 1 is the lecture's master audio. A friend's OBS
records her player; her desktop track is what she heard, her mic track is for a reaction line if wanted.

If a friend cannot install OBS: Windows 11 *Snipping Tool → Record* (a region, with system audio) or macOS
*Cmd+Shift+5 → Record entire screen*, with "show mouse clicks" on. Both record at the display's rate; Resolve
conforms it to 30 fps.

### The terminal (owner's laptop, at the same time)

OBS records one scene at a time, so record the terminal with a second recorder: **Snipping Tool → Record** with the
region set to the terminal window, or *Xbox Game Bar* (Win+G, record the focused window; *Settings → Gaming →
Captures*: 30 fps, standard quality). Start it before going on air and stop it after **End talk**. On a second
monitor this is easiest: console on one, terminal on the other.

### Syncing the POVs in Resolve

1. Everyone checks their clock is synced (Windows: *Settings → Time → Sync now*; macOS: *Set time automatically*).
2. After every recorder is running and the owner is on air, the owner says **"three, two, one"** and **claps once
   on camera**. The clap is in the owner's mic track, in each viewer's desktop track (heard through the player), and
   in the camera tile on each viewer's screen.
3. In Resolve, put each POV on its own track and line them up on the clap: the owner's mic track as the master, each
   viewer's desktop track (track 2) on its clap (*Auto Sync Audio → Based on Waveform* does it). A viewer's clip then
   shows what that viewer saw when the speaker said it, latency included, which is the honest view.
4. The terminal has no audio: line it up on time. Its lines carry the VM's clock (`HH:MM:SS`); the owner's clap
   produces a caption line ("three, two, one") within a few seconds; match that line's appearance to the clap.
5. Mute every desktop track in the final mix except where a viewer's screen-reader moment (beat 6) needs it. The
   lecture audio comes from the owner's mic track only, ducked to about −20 dB under the voice-over.

## Rehearsal: a 5-minute dry run

Use a throwaway room (`lecture-rehearsal`), every recorder running, the real lecture's first two pages, and both
friends. Run beats 2–8 of the script in order without stopping, then watch the recordings back for a minute.

Checklist, before take 1:

- [ ] Each recording plays: 1080p, 30 fps, the mic on track 1, desktop audio on track 2.
- [ ] The clap is audible in every recording.
- [ ] Captions reach V1 within a few seconds of each sentence; the terminal prints `captions … turn` lines.
- [ ] A language V1 picks prints `translate xx` lines with readable input → output, and its subtitles appear by the
      next sentence or the one after.
- [ ] Turning to the diagram page prints a `describe slide` line within about 10 s, and its text appears in V1's
      *Slides* view.
- [ ] A `chapters` line appears after a minute or two of talk.
- [ ] V2's rewind (J ×3) shows "You missed" and the old slide; **no** new Muse Spark line appears in the terminal
      while he is in the past; G returns to live.
- [ ] Stats for nerds (I) lists the agents and says WebTransport.
- [ ] No access code, speaker link, token, hostname, e-mail or notification in any frame (scrub each recording).
- [ ] The terminal text is readable when shrunk to the 1920×270 band.
- [ ] The rehearsal's spend, printed by `--since 15 --no-follow --room lecture-rehearsal`, is in line with the
      budget below.

## Budget

Every Muse Spark and Muse Voice Transcribe call is paid through the VM's spend ledger, under the deployment's $100
ceiling and each room's cap. Estimates from the demo rooms' generation runs (howto/demo-rooms.md, *Spend per
room-hour*: about $0.75 for a fully watched 18–20 minute session):

| Track | Per minute of talk | A 6-minute take |
|---|---|---|
| Captions (Muse Voice Transcribe, $0.18 per audio hour) | $0.003 | $0.02 |
| Each translation language (Muse Spark) | about $0.008 | about $0.05 |
| Slide descriptions (vision; about one call per new slide) | about $0.004 | about $0.03 |
| Chapters, glossary, recap (revised as the talk grows) | about $0.011 | about $0.07 |
| **A take with two languages** | **about $0.035** | **about $0.22** |

The rehearsal and three takes come to about **$1**, well inside an access code's room cap (one new room per take
anyway) and the ceiling. The demo rooms' cap ($5 per room per day, decision 0034) applies only if the shoot uses a
demo room (the fallback below): a fully watched session is about $0.75 there, so the cap allows six. A recording
room's back-fill (beat 9) is one call per 4-second slice fetched, a few cents for a minute of seeking.

Check the total before and after: `ssh -t <vm-alias> 'python3 ~/talk-tracks/deploy/meta-calls.py --since 1440
--no-follow | tail -1'` (the last 24 hours, every room).

## If something fails

| Problem | What to do |
|---|---|
| The console cannot go on air, or the relay drops | A short network drop: the console reconnects and keeps its broadcast. Otherwise reload the console and go on air again (a new broadcast in the same room). If it still fails, switch to **a demo live session**: the friends open `/watch/dataviz` (live agents on, decision 0034), the owner narrates instead of lecturing, and beats 2–3 are cut; the terminal runs with `--room dataviz`. The VO says "a live session of a recorded lecture". |
| No live session works at all | **A recording room**: `/watch/dataviz-recording`. Seek, pick a language: back-fill calls (`⟲`) show in the terminal with `--room dataviz-recording`. Beats 4–8 work on it, without the late-joiner framing; say "on the recording". |
| A translation is slow to start | Normal: a new language starts with the **next** caption line, so it can take one or two sentences. Keep talking; cut the wait in the edit. If nothing comes after 20 s: look at the terminal. `translate xx` lines but no subtitles → the viewer reloads. `refused, $0` → the API refused it; pick another language and move on. No line at all → the agent is not serving the room: after the take, `docker compose -f deploy/compose.vm.yml --profile live logs --since 10m translate-any` on the VM. |
| A language translates badly (garbled, wrong script) | Pick another for the take, and try the pair in the rehearsal first. The list is the project's, not Meta's (decision 0035), so a listed language can still be weak. |
| The room says *capped* | Its cap is spent: create a new room with the code (a new room name) and do the take again. |
| The describe line is slow (vision) | Turn to the diagram page early, then keep talking about it; it lands in 5–15 s. |
| Captions stop | The ASR session reopens on its own after a failure; keep talking. If they do not return within 30 s, end the take and use a new room. |
| A friend drops out | Use the alternate cut in the script (one viewer, two browsers). |

## Audio

- The owner records **his own device's audio** in OBS (his mic, and desktop audio if he wants a viewer's view); that
  is fine and expected.
- The agents and the coordinator never play sound on the owner's device: QA browsers run muted and close their tabs
  after checks. Nothing in this runbook asks an agent to play audio.
- On the owner's machine, never open the audience view unmuted while on air: it would feed the lecture back into the
  mic. If he wants to see the audience side, mute that tab.
- The friends wear headphones; their mic tracks stay muted in the mix unless a line of theirs is used.
- The voice-over is recorded after the edit is locked, on the same mic, in a quiet room; or an AI voice-over (the
  rules allow it).
