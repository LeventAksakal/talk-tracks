---
status: accepted
date: 2026-11-02
decision-makers: project owner, coordinator
supersedes-in-part: 0026
---

# The look is a streaming platform; the mascot is removed

## Context and Problem Statement

The owner, 2026-11-02, on the deployed UI: "UI is really shitty design. everything is chucked into the right drawer
without intent and care ... The mascot is terrible remove that entirely. Web page content is garbage and redundant
'create'->'start a talk' and should open a modal. also what you've delivered in the UI is just a plain regualr site. I
asked for a Streming platform UI look. Glass card with on:dselect extended view view descriptions be creatiev suprise
me".

## Decision Outcome

* The site looks like a streaming platform: a hero for what is live, rows of glass cards (lectures, live sessions,
  recordings); a card expands on hover or focus into an extended view with the description, speaker, languages and
  tracks, and a play button. The design lanes choose the details; the owner asked to be surprised, so visual choices
  are not re-asked.
* **No mascot.** Chalky is removed from the site, the player, the loading states and the brand assets. Decision 0026's
  chalk look is replaced; its "a panel is a track subscription" rule stands.
* Copy is short and says each thing once. Starting a talk is one action ("Start a talk") that opens a modal, not a
  page section repeated as "Create".
* The player's side panels each have one job, chosen from what the viewer is doing; nothing is added to a drawer
  because there was room.
