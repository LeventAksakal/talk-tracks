# Demo video script: a live lecture from three points of view

**Length:** 2:58 at most; aim for 2:50. Judges stop watching at 3:00
([rules](workstreams/07-submission.md#the-rules-checked-2026-11-02)).
**Format (owner's choice, 2026-11-03):** a real live lecture. The owner teaches it as the speaker; one or two
friends join as viewers on their own machines and use the player. Each point of view (POV) is screen-recorded, then
mixed in DaVinci Resolve with a terminal that prints every Meta model call as it happens (`deploy/meta-calls.py`).
**How to shoot it:** [howto/demo-video-shoot.md](howto/demo-video-shoot.md).
**Cards:** `web/public/brand/video/title.png` and `end.png`, both 1920×1080.

What scores, and where the video earns it:

| Weight | What the judges look for | Where it is in the cut |
|---|---|---|
| Impact 30 | real people a talk normally loses | a viewer in her own language (0:40), a slide described for someone who cannot see it (1:22), a late joiner catching up (1:45) |
| Use of Meta AI 25 | beyond a basic integration | five model jobs, each its own live track; the terminal shows every call with its input and output; lazy: a call runs only for a track someone watches |
| Technical depth 20 | it holds up, it is hard | rewind with no new model call (the terminal stays quiet), stats for nerds, one MoQ publisher per agent |
| Demo 25 | working end to end | one unbroken flow: the speaker goes on air, viewers pick tracks, the talk ends as a recording |

Only features built during the event (Oct 27 – Nov 4) are shown. The relay, the browser MoQ libraries and Media
Chrome are named once, in the opening line, as not ours.

## The opening line

Said over the title card, 0:00–0:09, about 30 words:

> "Talk Tracks was built this week, from the first commit on October 27th: the AI agents, the track model, the speaker
> console and the player. Not ours: the open-source MoQ relay, the player controls, and Meta's models."

The facts behind it, checked on 2026-11-03:

- First commit `8321f2b`, 2026-10-27 12:13 +03 ("Add agent core: ..."); 460 commits since, every one between
  Oct 27 and Nov 3, inside the building period (Oct 26 – Nov 4). Nothing in the repository is older: before the event
  the owner ran feasibility measurements and kept notes, no code (README, *Built during the hackathon*).
- **Pre-existing, used under their licences ([NOTICE](../NOTICE)):** moq-relay and the `@moq/*` browser libraries,
  aiomoqt (the agents' MoQ client), Media Chrome (the player's controls), hls.js, PDF.js, perfect-freehand, PyAV,
  the fonts; Meta's models (Muse Voice Transcribe, Muse Spark); the four EMF 2026 demo lectures (CC BY-SA 4.0).
- **Built this week:** the agents and their track formats, the room service, archive and recordings, the spend
  ledger and access codes, the speaker console, the viewer and its tracks, rewind, the demo sessions, the benchmark.

## Who is on screen

| POV | Who | Machine | Opens | Records |
|---|---|---|---|---|
| **S** | the owner, speaking | his laptop | the speaker console (app window, no address bar) | OBS: the console; mic on its own track |
| **V1** | friend 1, a viewer in her language | her machine | `/watch/<room>` in Chrome | OBS (or the OS recorder): the whole screen, her mic on its own track |
| **V2** | friend 2, arrives late | his machine | `/watch/<room>` in Chrome, 2 minutes in | as V1 |
| **T** | the Meta-call terminal | the owner's laptop, ssh to the VM | `python3 ~/talk-tracks/deploy/meta-calls.py --room <room>` | a second recorder on the terminal window (runbook) |

**The frame in the edit:** the POV that is acting fills the top 1440×810 (75 %). The terminal is a band along the
bottom, 1920×270, about six lines. The top-right 480×810 holds a small picture of another POV (the speaker's
console while a viewer acts, a viewer while the speaker acts), or the friend's webcam if filmed. When the terminal
line that matters appears, highlight it (a soft box, 1 s) so the eye finds it.

**The lecture itself:** a short talk the owner really gives, 5–6 minutes, with his own 4-page PDF (his own text and
drawings; no third-party images). It is the source of every caption and translation, so speak in full sentences.
The speaker lines in the table are suggestions that make good captions; the voice-over (VO) is recorded afterwards
and laid over the lecture audio, which is ducked to about −20 dB under it.

## Beats

Times are where each beat starts and ends in the final cut, not on the shoot: the shoot runs about 6 minutes and is
cut down. "T shows" is the terminal line that must be readable in that beat.

| # | Time | On screen | What happens (exact actions) | Voice-over / speaker line | T shows |
|---|---|---|---|---|---|
| 1 | 0:00–0:09 | **Title card** | Hold. | VO: the opening line above. | — (no band yet) |
| 2 | 0:09–0:24 | **S** full, V1 small | Already on air: the owner speaks to camera, turns to page 1 of his PDF. | VO: "A talk reaches only the people who can hear it, follow its language, see the slides, and arrive on time. Talk Tracks is a live lecture player where every AI job is a track in the broadcast, and each listener picks the tracks they need." | the band fades in: `captions  muse-voice-transcribe-1.0  turn  "…"` lines scrolling with the speaker's words |
| 3 | 0:24–0:40 | **S**, a fast montage | Cut from the shoot's start: home → **Start a talk** → title, name, room name, access code (blurred) → **Start** → **Open console** → allow the microphone and camera, drop in the PDF → **Go on air**. | VO: "I give the talk from my browser. An access code gives me a room with its own spending cap. My voice, my camera, my slides and my pen go out over Media over QUIC." | `captions … 1 min $0.0030  audio paid a minute ahead`: the first Muse Voice Transcribe minute, paid before it is sent |
| 4 | 0:40–1:05 | **V1** full, S small | V1 opens **CC**, captions appear. She types her language (for example *Turkish*) in **Search any language** and picks it. Subtitles switch to Turkish about seven seconds later. | Speaker (heard under the VO): a full sentence. VO: "My friend opens the subtitles. Captions come from Muse Voice Transcribe, listening right now. She types Turkish: nothing ran for Turkish until this moment. A Muse Spark agent starts a Turkish track for this room, translating each line with the lines before it as context. The first Turkish line is on screen in about seven seconds." | `translate tr  muse-spark-1.3  ~7s to first line  $0.0004` with `"<English line>" → "<Turkish line>"` below it; highlight one |
| 5 | 1:05–1:22 | **V1** with **V2** split (or V1 alone) | V2 (or V1's second window, see the alternate cut) picks a second language, for example *Japanese*. Both subtitles run under the same slide. | VO: "Any language the model handles, one track each, made only while someone watches it. Ten viewers in one language cost the same as one: the relay fans the track out." | `translate tr` and `translate ja` lines interleaving: two calls per English line |
| 6 | 1:22–1:45 | **S** turns a page, then **V1** | The owner turns to his diagram page and draws a circle with the pen (D). V1 opens the side panel (**S** key), tab **Chapters** → view **Slides**: the new slide's description appears; she turns on *Speaker and slide descriptions* in the sound menu for a second. | Speaker: "This diagram shows …" VO: "A new slide goes to Muse Spark with vision. Its description is a track too: the text alternative for a listener who cannot see the slide, read by the screen reader or aloud." | `describe slide  muse-spark-1.3  ~4s $0.003` with `"<the description>"` below |
| 7 | 1:45–2:12 | **V2** full | V2 joins two minutes late. Side panel → **Chapters**, the *So far* recap at the top; then press **J** three times: "You missed" appears, the slide, the ink and the subtitles replay as they were. Press **B** to bookmark. Press **G**: back to live. | VO: "My second friend is late. Chapters, a glossary and a recap are Muse Spark's running outline of the talk, revised as it goes. He rewinds: the slides, my ink and his subtitles replay exactly as they were. Look at the terminal: rewind made no model call. The past comes from the same tracks, cached by the relay." | first a `chapters  muse-spark-1.3  ~6s  "4 chapters, 7 glossary terms · latest: …"` line; then, during the rewind, **no new line**: hold the band on screen and let the silence show |
| 8 | 2:12–2:30 | **V1**, stats | V1 presses **I** (stats for nerds): the track list, subscribers per track, the agents running, WebTransport. | VO: "Under the hood, every agent is its own publisher in the room: captions, each language, slides, chapters. Each viewer subscribes only to the tracks it wants. Every model call goes through one spend ledger, with a cap per room." | keep scrolling lines; optional overlay of the line count and dollars so far |
| 9 | 2:30–2:46 | **S** ends, then a recording | The owner says goodbye and presses **End talk**. Cut to home → *Recordings* → a demo lecture (`/watch/dataviz-recording`): the speaker's camera tile beside letterboxed slides; drag to the middle, pick a language. | VO: "Every lecture also comes as a recording, with the speaker beside the slides. Pick a language there and the translation is made for the part you watch: under a second once it exists." | `translate es ⟲  muse-spark-1.3` back-fill lines (⟲ = made for a past slice someone fetched), in room `dataviz-recording` |
| 10 | 2:46–2:58 | **End card** | Hold; lower third `talk-tracks.leventaksakal.com`. | VO: "Talk Tracks. Live talks for everyone in the room, and everyone who isn't. Try it live." | — |

About 330 words of voice-over: an easy pace for 2:49 of talk time.

**Beat 9 needs the terminal started without `--room`** (or a second terminal on `--room dataviz-recording`), and the
recording rooms served with the live-agents switch on (decision 0035). If that is not ready, cut beat 9 to the
recording alone (no language pick, no terminal line) and give its 16 s to beat 7.

## The alternate cut: one viewer, two browsers

If only one friend can join, V2 is the same friend in a second browser window on the same machine, or the owner's
second device:

- **One friend, two windows.** V1 in Chrome, V2 in Edge (or a second Chrome profile), side by side, each 960×1080.
  She plays both parts: beat 4 in the left window, beat 5 picks the second language in the right one, beat 7 is the
  right window opened late. Her screen recording already holds both, so the edit crops each half to full size for
  its beat. Keep one of the two windows muted (the tab's mute), or the speaker echoes.
- **No friend at all.** The owner's second machine (or a phone-free spare laptop) runs V1 and V2 as two windows; the
  owner operates it between speaking beats, so beats 4–7 are cut from moments when he pauses. Say "a viewer" in the
  VO, not "my friend".
- Timing is unchanged: 0:00–2:58, the same ten beats.

## After recording

- [ ] Total under 3:00 (aim for 2:50); the opening line is in the first 10 s.
- [ ] Freeze-frame check: no access code, speaker link or token, VM address or hostname, e-mail address, or a
      friend's notification readable in any frame, the terminal band included.
- [ ] Burned-in English captions or an uploaded caption file for the voice-over (the video is about accessibility).
- [ ] Credit line in the description: "Demo lectures: Electromagnetic Field 2026, EMF Video Team and C3VOC,
      CC BY-SA 4.0 (media.ccc.de). Trimmed, re-encoded, AI tracks added."
- [ ] The friends agreed to appear (voice, name, screen) in a public video.
- [ ] Upload to YouTube (unlisted or public), open the link in a logged-out window, paste it into the form and into
      [submission.md](submission.md#demo-video-owner).
