---
status: open
created: 2026-10-31
tags: [downloads, replay, format, design]
---

# What is in the downloadable lecture package?

## Question

The owner (10-31): "ability to download the transcipt is useful. maybe some format then ability to download the whole
thing so e.g you can hook in your agent like claude give the lecture (the packaged format we'Ll define) and it has the
transcripts the slides and basically on accord with you on the lecture". What format do the transcript download and
the lecture package take, and when is the package built?

## Context

- The design puts a Download menu on the side panel: the transcript (.txt, .vtt, .md; one language or all) and a
  "Lecture package · .zip" for an AI assistant (Reference Canvas, board "Panels, transcript and stats for nerds").
- Everything the package needs already exists as tracks: transcripts per language, chapters, glossary, slides and
  ink. The listener's notes live only in the browser.
- During a live talk the package can only hold what has happened so far.
- Spec style for formats is IETF-like, in the backlog (memory: tracks are containers with defined semantics).

## Options

1. **A folder in a .zip with a `manifest.json`:** `transcript/<lang>.vtt` and `.md`, `chapters.json`,
   `glossary.json`, `slides/NN.png` with the ink baked in plus `slides/NN.md` (slide text), `notes.md`, and a
   `README.md` written for an AI reader. Built in the browser from tracks it fetches. Easy to read for people and
   agents; heavy for long decks.
2. **One Markdown file:** chapters as headings, transcript under each, slide text inline, images linked to the
   replay. Smallest and pastes straight into a chat. Loses the images unless the assistant can fetch them.
3. **Built by the room service at talk end:** the same layout as option 1, stored with the replay. A download is
   instant and works without a live tab. Needs storage and a job on the VM.

## Recommendation

Option 1, built in the browser, with option 2's single Markdown file inside it as `lecture.md`. An agent can read
that one file, and the folder carries the images and data.

## Answer

