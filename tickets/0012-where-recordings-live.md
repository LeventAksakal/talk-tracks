---
status: open
created: 2026-10-27
tags: [demo, deploy, data]
---

# Where do generated recordings live?

## Question
Where are demo recordings (the lecture video plus the agent tracks from the one paid API run) kept, and do any of
them go into git?

## Context
A recording is a directory `data/demo/<lecture>/`: `recording.json`, `agents/<agent>.jsonl` and `lecture.mp4`. It is
git-ignored today. On the VM it needs a mounted folder, which Caddy could also serve for rewind (ticket 0002). The
agent tracks are the expensive part to regenerate; the lecture licences are still open (ticket 0001).

## Options
- **A. A VM folder, copied there by a deploy step.** The repo stays small and public-safe; the recordings need their
  own backup.
- **B. Commit the agent tracks (not the video) to the repo.** The paid output is versioned; each lecture adds a few MB
  of JSON lines to the public repo.

## Recommendation
A: recordings are build output, and until the licences are checked they may not belong in a public repo.

## Answer

