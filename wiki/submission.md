# Submission text

Paste-ready text for the Cerebral Valley form, one block per field. The fields are the ones reported for the form
(GitHub Repository, Live Project, Demo Video, Project Description, team members); the owner checks them when he signs
in ([rules](workstreams/07-submission.md#the-rules-checked-2026-11-02)). Blocks marked **owner** need his input.
After submitting, replace this note with "Submitted on <date, time>" and keep the text as sent.

Never put the access code in this file: the repository is public. It goes only into the form.

---

## Project name

Talk Tracks

## Tagline (if the form has one)

Live talks over Media over QUIC, where every AI job publishes its own track: captions, translations, slide
descriptions and chapters you pick, live and on rewind.

## Track and theme (owner)

- Track: **Indie developer** (solo).
- Theme: **Build for Your World**.

## Team

Levent Aksakal (solo).

## GitHub Repository

https://github.com/LeventAksakal/talk-tracks

## Live Project

https://talk-tracks.leventaksakal.com

## Demo Video (owner)

`<YouTube link, unlisted or public, checked in a logged-out window>`

The video is a real live lecture filmed from three points of view (the speaker and two viewers), with a terminal of
the VM's Meta model calls along the bottom: [script](submission-video.md), [shoot runbook](howto/demo-video-shoot.md).

## How judges try it (put in the description, or a notes field if the form has one)

> Open https://talk-tracks.leventaksakal.com in desktop Chrome. No account needed.
>
> 1. **Watch a live session.** Pick a lecture under *Live now*. Each one plays once from 00:00 and starts again. Open
>    **CC** and type any of 50 languages in *Search any language*. A translation is made only once someone picks it:
>    in our muted test runs the first live subtitle came 7.2 s after picking Japanese. The captions and translations come from agents listening to that
>    session right now. Open the side panel for chapters, glossary and transcript.
> 2. **Rewind.** Drag the progress bar back (or press J). Slides, drawings and subtitles replay at that moment. Press
>    G to go live.
> 3. **Stats for nerds.** Press I, or right-click the video: every track in the room, who subscribes to it, which
>    agents are running, WebTransport or WebSocket.
> 4. **Give a talk.** Press *Start a talk*, enter a title, your name, a room name and the access code
>    **`<ACCESS CODE: owner pastes it here in the form only>`**. Open the speaker link, allow the microphone, pick a
>    PDF or share a screen, press **Go on air**, and open the audience link in a second window.
> 5. **Recordings** are under *Recordings*: the whole lecture, seekable, the speaker's camera beside the slides, AI
>    tracks labelled as recorded. Pick a language there too: it is translated for the part you watch (0.4 s to the first subtitle once made, 20.5 s for a part not made yet, right after a seek).
>
> If the network is bad, `/demo` plays the player on a scripted room, offline.

## Project Description

### The problem

A talk reaches only the people who can hear it, see the slides, follow its language and arrive on time. Live
captions, translation, slide descriptions and a "what did I miss" summary each exist somewhere, but as separate
products bolted onto a video stream: one caption feed, a separate translation service, a chat bot on the side. They do
not share a timeline, they cannot be rewound with the video, and every one of them runs whether anyone uses it or not.

### What it does

Talk Tracks is a live talk platform where every AI job is a track in the broadcast. A speaker talks from the browser
with a microphone, a camera, a PDF deck or a shared screen, a pen and a laser pointer. Listeners open a media player and
pick what they want:

- **captions** as the speaker talks;
- **subtitles in their language**: any of 50 languages (the list is marked unconfirmed, as Meta publishes none), each made only when the first viewer picks it, in live
  talks and recordings alike;
- **slide descriptions**, so a listener who cannot see the slide hears or reads what is on it;
- **chapters, a glossary and a recap**, so a late joiner can catch up;
- **rewind** to any moment, with the slides, drawings and subtitles exactly as they were, and **Go live** back;
- **chat**, private notes and bookmarks, and a download of the transcript or of the whole lecture as a package.

When the talk ends, the same tracks become the recording. The site runs four public lectures (Electromagnetic Field
2026, CC BY-SA 4.0) as live sessions with live agents, and as recordings that show the speaker's camera in a tile
beside the letterboxed slides.

### How it is built

- **Media over QUIC.** The speaker's browser publishes audio, video, slides, ink and the laser pointer to a MoQ relay
  (moq-relay) over WebTransport, with a WebSocket fallback for Safari. Viewers subscribe to the same relay.
- **One publisher per agent.** Captions, each translation language, slide descriptions and chapters are separate
  Python processes. Each subscribes to the tracks it needs (audio, captions, slide frames) and publishes its own named
  track, `talk/<room>/agents/<agent>`. An agent can be added, swapped or killed mid-talk: a restarted agent resumes from
  its own track history with no duplicate lines, and the agents downstream follow it without restarting.
- **The track model.** Every AI track is a timeline of 4-second slices: each slice opens with a carry-in (the state so
  far) and then new records. A late joiner gets the current state at once; rewind fetches earlier slices of the same
  track by MoQ FETCH, and the relay caches them, so the second viewer to rewind costs no model call.
- **Lazy, capped AI.** The relay merges subscriptions, so an agent sees when nobody watches its track and does nothing
  until someone does. Every model call goes through one spend ledger with a cap per room and a ceiling for the whole
  deployment. Presenters create rooms with an access code that mints a signed, room-scoped token.
- **Honest live AI, plus a recording.** Each demo lecture is two rooms: a live session that plays the lecture once in
  real time, with its AI tracks from agents hearing that audio now (never a replay of earlier output), and a recording
  of the whole lecture with its tracks labelled as recorded. A room service archives every room as it plays (CMAF
  segments, HLS playlists and the agents' slices), and the player, built on Media Chrome, plays both.
- Python 3.13 on aiomoqt for the agents; React 19 and TypeScript for the web app; everything on one VM with Docker
  Compose. A benchmark in the repo compares MoQ with LL-HLS and WebRTC on the same encode (its fan-out table is not reproduced and is not cited here).

### How we use Meta's models

- **Muse Voice Transcribe** (realtime, endpointing) turns the speaker's audio into caption lines. It is the source text
  for every other AI track.
- **Muse Spark** translates each caption line, with the lines before it as context, into any language a viewer asks
  for. Each language is its own track, started by the first viewer who picks it, and nothing is translated before
  that (decision 0035). In a recording, a language is translated slice by slice for the part a viewer fetches.
- **Muse Spark with vision** describes each new slide for listeners who cannot see it. A slide shown again reuses its
  description.
- **Muse Spark** builds the chapters, glossary and recap as the talk goes, revising them as the transcript grows.
- **Muse Spark** re-punctuates a recording's captions without changing a single word (checked word for word), so
  subtitles break at sentence ends instead of mid-phrase.

What surprised us: the models are fast enough to sit inside a live broadcast as peers of the speaker, not as a
post-processing step. Making each model call its own publisher, with its own track and its own history, means a model
can be swapped or restarted mid-talk and no viewer notices.

### Challenges

- **Honesty in the demo.** Our first demo rooms replayed recorded translations in sync with the speech. It looked
  fake, because it was. We split every demo into a live session with live agents and a separate, labelled recording.
- **Subtitles that break mid-phrase.** Realtime transcription lines have no word timings and little punctuation. A
  punctuation pass that may not change any word cut the cues that end mid-phrase from over 80 % to about 13 % on the
  two lectures that had the most.
- **A relay stream limit.** moq-relay advertises every namespace it knows to each agent connection, and each
  advertisement holds one bidirectional stream. The 52 lazy language tracks per room used up aiopquic's default 512
  streams, and the relay's SUBSCRIBE and FETCH waited forever. Granting 16384 (`TT_MOQ_MAX_STREAMS_BIDI`) fixed it.
- **A moving standard.** MoQ is an IETF draft and its libraries change weekly. We pinned the relay and browser
  libraries, stayed on one draft, and wrote down every relay behaviour we hit: for example, a FETCH of the slice that
  was open when the relay first subscribed never completes, so the player takes that slice from the live
  subscription instead.
- **Safari.** The browser MoQ library sends every WebKit browser to the WebSocket fallback, so that path had to be a
  first-class one.
- **A player that behaves like a player.** We first built our own controls; they lacked the basics. We moved the
  player onto Media Chrome as a custom media element around our MoQ pipeline, and kept our live-edge, rewind and
  track model.

### What's next

- Publish the track formats (room clock and slices, captions, slides, ink, outline) as short specifications, so
  anyone can write an agent or a player that joins a talk.
- More agents as tracks, for example grouping the audience's questions by slide, or slide descriptions in the
  listener's language.
- Relays in front of the origin for large audiences, and a CDN once one speaks the same MoQ dialect.

### Built during the hackathon

All code in the repository was written from Oct 27, 2026 (first commit), in the building period. Before the event we
ran feasibility measurements only. Third-party parts, used under their licences and listed in NOTICE: moq-relay and the
`@moq/*` browser libraries, Media Chrome (player controls), hls.js, PDF.js, perfect-freehand, aiomoqt, PyAV, the
fonts, and the four EMF 2026 lectures (CC BY-SA 4.0, credited in the README).

## Before pressing Submit (owner)

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
