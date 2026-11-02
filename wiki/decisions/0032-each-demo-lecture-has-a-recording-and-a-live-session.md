---
status: accepted
date: 2026-11-02
decision-makers: project owner, coordinator
supersedes-in-part: 0015
---

# Each demo lecture has a recording and a live session; demo AI tracks are honest

## Context and Problem Statement

The owner, 2026-11-02: "translation feels faked for live content. transcript sentencing feels off like cut in
arbitrary positions ... lets strip loopback instead have VOD + live version of each stuff. live one after end stops
then starts from 00:00 again." Asked how translations behave in a demo's live version, the owner answered: "for demo
day we must be honest so be ready for flipping aswitch and erasing all traces".

Checked in code: a looped room replays recorded translations and releases each with its caption cue, with no
translation delay (`resegment.translations_with_captions`), and cue breaks are placed by character share inside
half-minute speech-recognition lines that have no word timings.

## Decision Outcome

* **No loop.** Each demo lecture is two things: a **recording** (VOD: the whole lecture, seekable, from the archive,
  its AI tracks labelled as recorded) and a **live session** that plays the lecture once from 00:00, ends, and starts a
  new session from 00:00. A session boundary is a real end and start, not a wrap inside one timeline.
* **Honest live AI.** One switch per deployment (`TT_DEMO_LIVE_AGENTS`) makes a live session's AI tracks come from real
  agents running on its audio in real time (captions, translations, slide descriptions), capped per room by the spend
  ledger. When it is on, nothing pre-recorded is published as a live AI track: the replay path for live sessions is
  deleted, not hidden. The recording keeps its recorded tracks, labelled as such.
* Until the switch is flipped (it is on for demo day, and when the owner says), a live session publishes recorded
  tracks at the delay the live agent really had, never ahead of or in sync with speech it had not heard yet.
  `translations_with_captions` is removed.
* **Sentences.** Subtitle cues break on sentence ends, then clause marks; a cue never ends mid-phrase to meet a
  character count.

Reading of the owner's answer recorded here so it can be corrected: "erasing all traces" means no pre-recorded AI
output is presented as live once the switch is on.
