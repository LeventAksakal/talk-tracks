# Demo video script

**Length:** 2:55, under the rules' 3 minutes ([rules](workstreams/07-submission.md#the-rules-checked-2026-11-02)).
The demo counts for 25 % of the score, and judges must be able to tell what was built during the event.
**Path:** the golden path in [journeys.md](product/journeys.md#4-3-minute-demo-video-golden-path): judge cold entry
(J8) → listener (J2, J3, J4) → presenter (J6) → architecture proof.
**Cards:** `web/public/brand/video/title.png` and `end.png`, both 1920×1080.

The voice-over is about 330 words, which fits 2:55 at an easy pace. Read the **Say** column as written, or in your
own words; the times are where each shot should end.

## Before recording

- [ ] **Live agents on** (`TT_DEMO_LIVE_AGENTS`, from Tue evening, decision 0034), so the live session's tracks are
      really live. Check the dataviz live session has played **at least 6 minutes** (rewind needs something to go back
      to); sessions restart at 00:00, so time the take.
- [ ] **Screen:** 1920×1080, Chrome at 100 % zoom, one profile with no extensions or bookmarks bar, notifications off
      (Windows Focus), the taskbar hidden.
- [ ] **Two Chrome windows** side by side for shot 5: left, the speaker console; right, the audience view.
- [ ] **A short PDF of your own** (3–4 pages, your own text and drawings, no third-party images) for the deck.
- [ ] **Hide secrets:** the access code and the speaker link (it carries a token) must never be readable on screen.
      Type the code with the field scrolled out of frame, or blur it in the edit; open the speaker link in an app
      window (`chrome --app=<link>`) so no address bar shows. No terminal with the VM's address or a key.
- [ ] **Sound:** headset microphone for the voice-over; the lecture's own audio low (about −20 dB) under your voice.
- [ ] **Recorder:** OBS (or similar) at 1080p, 30 fps. Record each shot as its own clip; cut them together after.
- [ ] Turn on burned-in captions or upload a caption file; the video is about accessibility.

## Shot list

| # | Ends at | Screen | Do | Say |
|---|---|---|---|---|
| 1 | 0:05 | **Title card** (`title.png`) | Hold. | *(no voice, or)* "Talk Tracks." |
| 2 | 0:25 | **Home**, `/` | Let the hero play. Hover a lecture card in *Live now* so it expands; move to the *Recordings* row. | "A talk reaches only the people who can hear it, see the slides, follow the language and arrive on time. Talk Tracks is a live talk platform where every AI job is a track in the broadcast, and each listener picks the tracks they need." |
| 3 | 0:55 | **Player**, *Data Visualisation* live session | Click the card's play button. Open **CC**, pick **العربية** (Arabic). Then type "Japanese" in *Search any language* and pick it. | "This is a live session of a real lecture. The captions come from Muse Voice Transcribe, listening right now. I switch to Arabic: that's a separate agent, publishing its own track with Muse Spark. A language nobody asked for yet, like Japanese, starts the moment the first viewer picks it. Nothing runs for a track nobody watches." |
| 4 | 1:20 | **Player**, side panel | Press **S** for the side panel; show *Chapters*, then *Glossary*. Then press **J** three or four times (or drag the bar back a few minutes); wait for "You missed"; press **G**. | "Chapters, a glossary and a recap are another agent's track, built as the talk goes. If I arrive late, I rewind: the slides and subtitles replay exactly as they were, and the past comes from the same tracks, cached by the relay. Go live, and I'm back." |
| 5 | 2:15 | **Two windows**: console (left) and audience (right) | On the home page press **Start a talk**; fill title, name, room name, access code (out of frame); press **Start**, **Open console**. Allow the microphone, drop in your PDF, press **Go on air**. Open the audience link in the right window. Talk for a few seconds; draw a circle with the pen (D), use the laser (L), turn a page. Point at the captions appearing on the right. | "Now I give a talk. An access code gives me a room with its own capped budget. In the console I have my microphone, a camera, a PDF rendered in the browser or a shared screen, a pen and a laser. I go on air. On the right is the audience: my ink, my laser and my slide arrive on their own tracks over Media over QUIC, and my words come back as captions a moment later, from agents that joined my room when the first listener did." |
| 6 | 2:38 | **Stats for nerds** in the audience window | Press **I** (or right-click the video). Point at the track list, the subscriber counts, the agents running, and *WebTransport*. | "Stats for nerds shows the architecture. Every publisher is separate: the speaker, each agent and the room service. Each viewer subscribes only to the tracks it wants. An agent can be killed mid-talk; it resumes from its own history, and nobody downstream restarts. Every model call goes through a spend ledger with a cap per room." |
| 7 | 2:44 | **Recording**, back on home → *Recordings* → any | Open a recording; drag to the middle. | "When the talk ends, the same tracks become the recording." |
| 8 | 2:55 | **End card** (`end.png`) | Hold. Add the live address as a lower third: `talk-tracks.leventaksakal.com`. | "Built during the hackathon: the agents, the track model and both apps. The relay and the player controls are open source. Try it live." |

## After recording

- [ ] Total length under 3:00 (aim for 2:55).
- [ ] Freeze-frame check: no access code, token, speaker link, VM address or e-mail address readable in any frame.
- [ ] Credit line in the video description: "Demo lectures: Electromagnetic Field 2026, EMF Video Team and C3VOC,
      CC BY-SA 4.0 (media.ccc.de). Trimmed, re-encoded, AI tracks added."
- [ ] Upload to YouTube (unlisted or public), open the link in a logged-out window, paste it into the form and into
      [submission.md](submission.md#demo-video-owner).

## If something fails while recording

| Problem | Fallback |
|---|---|
| A live session has just restarted (nothing to rewind) | Do shot 4 on a recording (`/watch/dataviz-recording`) and say "on the recording" instead of "if I arrive late". |
| Live agents are slow to start a language | Pick the language before you start recording the shot; cut the wait. |
| The network drops | Shots 2–4 can be done on `/demo` and `/demo/rewind` (offline, scripted); say so in the voice-over. |
| Microphone not carried (console says the relay is not carrying it) | Reload the console; check no other tab holds the microphone. |
