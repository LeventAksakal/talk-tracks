# Design brief: the Talk Tracks client app (2026-10-28)

The self-contained brief for the owner's design session in Claude Design. Upload this file (and, if the tool takes
more, the attachments listed at the end). The prompts to paste are in [design-prompts.md](design-prompts.md). When
the design is decided, the Product spec and UI lane turns it into `wiki/spec/`, decisions and code.

## 1. What Talk Tracks is

A teacher speaks into a browser. One Media over QUIC (MoQ) relay fans the talk out to students in their browsers.
AI agents each publish **their own live track** into the same broadcast:

| Track | What the viewer gets | Data per item |
|---|---|---|
| Captions | live words of the teacher, with an interim (still-forming) line | `id, start_ms, end_ms, text`, interim text |
| Turkish translation | the captions, translated | `id, text` (same ids as captions) |
| Slide descriptions | for blind and low-vision students: a description of each new slide | `id, at_ms, description` |
| Outline | chapters, a glossary and a recap ("so far"), revised as the talk goes | chapters `id, start_ms, title, summary`; glossary `term, definition`; `recap` |
| Speaker media | the teacher's voice and video, plus slide images | audio, video, slide frames |

**The rules that shape the UI:**

- **Every AI track is off until the viewer switches it on, and switching it off cancels it** (decision 0010). An
  agent spends API money only while someone subscribes. A track switched on starts at "now"; its past may be empty
  (translation can be back-filled on demand when the viewer scrolls back).
- **Rewind:** a viewer can rewind a live talk, and every opted-in track moves with the playhead. "Go live" returns
  to the edge, and the app says **what you missed** (the chapters in the skipped stretch, and its transcript on
  request).
- **Live output takes a moment:** a track starts at least about 1 s after you switch it on; captions trail speech by
  a few seconds; a capped room's tracks go silent with a reason.
- **Safari and every iPhone browser use a WebSocket fallback** (higher latency, TCP). The UI must work, and say the
  truth about delay, on that path.

## 2. Who uses it

| Person | Wants | Where |
|---|---|---|
| Student | follow a lecture live, catch up after looking away, understand terms, take notes | desktop browser, and often a phone (iPhone = WebSocket path) |
| Blind or low-vision student | the slides described as they change, everything reachable by keyboard and screen reader, spoken descriptions | desktop with a screen reader (NVDA, JAWS, VoiceOver), phone with VoiceOver |
| Deaf or hard-of-hearing student | readable, large, high-contrast captions | any |
| Non-native speaker | Turkish beside or instead of English | any |
| Teacher | start a room, share the link or QR, run slides, see who uses which track and what it costs | desktop |
| Judge (Meta hackathon) | understand the twist in seconds; see that MoQ does real work (lazy agents, relay aggregation, SUBSCRIBE vs FETCH) | desktop, a looped demo room |

## 3. Screens to design

| Screen | Path today | Purpose |
|---|---|---|
| Landing | `/` | what it is, join a room, try a demo lecture, "I'm teaching" |
| Join / room creation | `/` and links | join by name, link or QR. A teacher gets a signed publishing link from the organiser (a browser cannot mint tokens); design the "paste or open your teaching link" path |
| Student viewer, desktop | `/watch/<room>` | the stage, the tracks, rewind, transcript, outline, notes |
| Student viewer, phone | same | the same features in a phone layout, not a reduced mode |
| Speaker console | `/talk/<room>?token=…` | mic and camera, on air / off air, slides, share link and QR, track meter (which tracks are on, how many viewers, spend against the cap), errors (no mic, clock missing) |
| Judge inspector | a panel in the viewer | per track: producing or idle, FETCHes served by the agent (origin) vs the viewer's own (the gap is the relay cache), back-fills, spend |
| Offline demo | `/demo` | a scripted room with no network, for when the venue Wi-Fi fails; must look like the real viewer, clearly labelled as a demo |

Two looped demo lectures exist for judges: biology and data visualisation (CC BY-SA talks from EMF). They must be
credited on screen.

## 4. States every design must cover

- Connection: connecting, connected, reconnecting, failed; WebSocket fallback in use.
- Room: waiting for the teacher, live, teacher paused/off air, ended, looped demo.
- Track: off, starting, live, behind (seconds), stale (no output for a while), capped (spend limit reached, with the
  reason), no history before the moment you switched it on, back-filling.
- Playback: live (red LIVE), behind live (grey LIVE, offset like −04:30, "Go live"), loading a seek, holes where
  nobody broadcast, media unavailable (AI tracks still rewind alone).
- "What you missed": after Go live, after the tab was hidden for a while, after a reconnect; with the outline off it
  offers to switch it on.
- Empty: no tracks on yet (first visit), nothing said yet, no chapters yet.

## 5. Features and the lane's recommended priority

From the field research of 27 products (`research-video-products.md` §5). Build time for the UI is about four days
(Oct 29 – Nov 1).

| Feature | Recommendation | Size |
|---|---|---|
| One tracks panel: every layer with a switch, live status and one-line explanation; bottom sheet on phones (O1) | must | S–M |
| Rewind with every track in sync, LIVE badge, offset, "Go live" (O2; the engine is built by the Rewind lane) | must | M |
| "What you missed" on Go live, late join or return to the tab (O3; engine provides the data) | must | M |
| Slide descriptions: polite screen-reader announcements, optional spoken voice, expand (O5) | must | M |
| Caption display modes: size, contrast themes, position, remembered (O11) | must | S |
| Real phone layout, plus QR join from the console (O12) | must | S–M |
| Live chapters as marks on the timeline, click to jump (O4) | should | M |
| Glossary terms underlined in captions/transcript, definition popover, "first mentioned at" jump (O6) | should | M |
| Interactive transcript: follow live, "jump to latest", search, click to seek, English and Turkish side by side (O7) | should | M |
| Notes and bookmarks stamped with time and slide, kept in the browser, Markdown export (O8) | could | S–M |
| Teacher console track meter: tracks in use, viewers, spend vs cap (O10) | should | M |
| Judge inspector panel | must (judges) | S |
| "I'm lost" per slide, upvoted Q&A (O9) | cut: needs a viewer back-channel and tokens | M |
| Ask the lecture (O13) | cut: a new agent, another lane | M |
| Spoken Turkish with a mix slider (O15) | cut: costliest track, L | L |
| Tracks kept with the recording (O14) | done by the archive lanes; UI only shows it | – |

## 6. Direction (the lane's recommendation, for the owner to accept or change)

**Concept: the multitrack timeline.** Our twist is that the AI is not a menu of features but a set of *tracks* you
compose, the way a video editor or a music workstation shows its lanes.

- Under the stage sits a timeline. Each opted-in track is a thin lane on it (captions, Turkish, slides, outline),
  showing where it has output, where it is still loading, and where it has none. Chapters and slide changes are
  marks; glossary terms are ticks.
- Scrubbing moves the media and every lane together. The live edge is a bright line at the right; behind it the
  LIVE badge greys and "Go live −04:30" appears. Returning shows "What you missed" as a card anchored to the skipped
  stretch on the timeline.
- Switching a track on makes its lane slide in and start filling from "now", so a viewer *sees* that a track is
  lazy and starts on demand. Switching it off removes the lane. This is the MoQ story told without words.
- The tracks panel is a compact "track list" beside the lanes (like a mixer's channel labels): name, switch, status
  ("starting", "4 s behind", "capped"), a one-line explanation.
- On a phone: slide/video on top, the timeline collapses to a single scrubber with chapter marks, the text tracks
  become swipeable tabs (Captions · Transcript · Slides · Outline · Notes), and the track list is a bottom sheet.

**Tone:** light and dark from the system setting, with a toggle; calm, reading-friendly surfaces; one strong accent
for LIVE and the live edge; captions with their own high-contrast modes (for example yellow on black).

**Alternatives considered:** a mixing-desk tracks panel (striking, but the twist stays in a side panel); a
reading-first "lecture notebook" (great for students, weaker as live video); a conventional player with CC-style
chips (fastest, no twist).

## 7. Constraints for the design

- **Stack:** React 19 + Vite + TypeScript with Meta's Astryx design system (decision 0002): switches, buttons,
  badges, text inputs, tabs, focus handling come from Astryx; our own parts are plain CSS. Design within what
  Astryx's components can look like; custom pieces (timeline, caption overlay, track lanes) are ours.
- **Accessibility:** WCAG 2.2 AA in both themes; full keyboard use with visible focus; a skip link; screen-reader
  announcements that are polite and not chatty (new slide descriptions yes, every caption word no); respects
  reduced motion; touch targets at least 44 px on phones; text resizable to 200 %.
- **Phone:** a first-class layout at 375 px width; iPhone Safari is the WebSocket path.
- **Honesty:** never show a track as live when it is not; show delay and cost states plainly.
- **Public repo:** no hostnames, IPs, keys or personal details in designs that will be committed.

## 8. Questions the design session should settle

1. The hero of the demo video: the student viewer (recommended), the blind student, the teacher, or the judge.
2. The concept: multitrack timeline (recommended), mixing desk, lecture notebook, or conventional player.
3. Scope: which "should" and "could" rows in §5 make the build.
4. Tone: system-led light + dark (recommended), dark only, or light only.
5. Where the judge inspector lives: a toggle in the viewer (recommended), a separate page, or only in demo rooms.
6. First visit with every track off: an onboarding prompt suggesting captions (recommended), a preset picker
   ("Follow along", "Accessible", "Turkish"), or nothing.
7. The name, logo and any illustration style.

## 9. What to hand back to the lane

- The chosen direction and answers to §8.
- Design tokens: palette (light and dark, with contrast checked), type scale and fonts, spacing, radii, motion.
- Each screen in §3, desktop and phone, with the states in §4 that change its layout.
- Any exported HTML/CSS or images; the lane rebuilds them in React with Astryx.

## Attachments (optional, if the tool takes more context)

- `wiki/product/research-video-products.md`: the 27-product research, pattern catalogue and O1–O15 ideas.
- `wiki/product/inspection-2026-10-28.md`: the owner's verdict on today's app.
- `wiki/decisions/0010-agent-tracks-are-opt-in-and-lazy.md`: opt-in and lazy tracks.
- `wiki/design/moq-track-system.md` §5.2, §5.5–5.7, §7: opt-in, rewind, what you missed, back-fill, what judges see.
- Screenshots of today's `/watch/demo` and `/demo` for "what not to do".
