---
status: accepted
date: 2026-11-02
decision-makers: project owner, coordinator
---

# The lecture package is a zip built in the browser

## Context and Problem Statement

Asked in [ticket 0023](../../tickets/0023-lecture-package-format.md), which lists the options and their trade-offs.

## Decision Outcome

Chosen: the ticket's recommended option (owner, 2026-11-02, through the question prompt). The Download popover offers a .zip built in the browser from the room's tracks: `manifest.json`, transcripts (.vtt, .md), chapters, glossary, slides as PNG with ink plus their text, the listener's notes, a README for an AI reader, and one `lecture.md` an assistant can read on its own. Only languages already running or archived are included.

### Consequences

Good: no server job or storage; works for live, looped and recorded rooms. Bad: heavy for long decks, and the tab must stay open while it builds.
