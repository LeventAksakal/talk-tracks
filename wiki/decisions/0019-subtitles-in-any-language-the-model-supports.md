---
status: accepted
date: 2026-10-30
decision-makers: project owner
---

# Subtitles translate into any language the Muse model supports

## Context and Problem Statement

[Decision 0014](0014-translations-in-turkish-spanish-and-arabic.md) fixed three languages (tr, es, ar). In a media
player, translation is a subtitle language, and the CC menu offers a searchable list of languages
([decision 0017](0017-viewer-is-a-media-player-and-every-interaction-is-a-track.md)).

## Decision Outcome

* A listener can pick any language the Muse model supports. A translation track per requested BCP 47 tag is created
  on its first subscribe and stays lazy (decision 0010), within the room's spend cap (decision 0008).
* The pre-made tr, es and ar tracks of the demo rooms stay. Another language in a demo room is translated live and
  is spent against that room's cap.
* Language names show in their own script (`Intl.DisplayNames`); right-to-left languages render in their own block.

### Consequences

* Good, because the language list is open, which is what a player's subtitle menu implies.
* Bad, because the agents must accept track names they have not announced in advance, and every new language costs
  live spend. Supersedes the "three languages" part of decision 0014.
