---
status: accepted
date: 2026-10-29
decision-makers: project owner
---

# Live and demo rooms carry Turkish, Spanish and Arabic translations across an expanded lecture hallway

## Context and Problem Statement

The first demo rooms (`virus` and `dataviz`) carry only a Turkish translation (`translate-tr`). One translation track
understates the "one track per language, viewer subscribes only to what they read" argument and does not exercise
right-to-left (RTL) subtitle and transcript layout ([ticket 0006](../../tickets/0006-demo-languages.md)). Two rooms
also give judges a narrow sample of subjects and slide styles ([ticket 0001](../../tickets/0001-demo-lectures.md)).

## Decision Outcome

* **Three translation languages:** Turkish (`tr`), Spanish (`es`) and Arabic (`ar`) run in live rooms (`translate-tr`,
  `translate-es`, `translate-ar`, all lazy under [decision 0010](0010-agent-tracks-are-opt-in-and-lazy.md)) and in every
  looped demo room.
* **Offline translation from recorded captions:** additional languages for a finished demo recording are generated
  directly from its recorded captions (cue-aligned + `resplit` to fit 84-character subtitle cues) without replaying the
  video or re-running speech recognition, slide description or chapters.
* **More demo rooms:** expand the public demo hallway beyond `virus` and `dataviz` with additional CC BY-SA 4.0 talks
  from the vetted shortlist (for example computer science and engineering/history) so judges can switch across subjects.

### Consequences

* Good, because Arabic demonstrates RTL accessibility and three parallel translations make selective subscription
  visually obvious.
* Good, because offline cue translation adds a language to a 20-minute lecture for roughly \$0.07–\$0.10 in seconds,
  and each extra `looper` container sleeps between pre-packetised frames (~1 % CPU).
* Bad, because the viewer UI must render RTL text (`dir="auto"` / `lang="ar"`) cleanly in both overlay cues and
  transcript lists.
