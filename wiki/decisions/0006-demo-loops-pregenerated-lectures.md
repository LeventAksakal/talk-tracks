---
status: accepted
date: 2026-10-27
decision-makers: project owner
---

# The public demo loops licence-free lectures whose AI tracks were generated once

## Context and Problem Statement

The demo must be up around the clock for judges without spending API credit on every viewing, and a live talk is not
always running.

## Decision Outcome

Demo rooms are seeded with licence-free lectures. The agent tracks for each lecture (captions, translations, slide
descriptions, chapters) are generated once, at a one-time API cost, and then replayed in a loop together with the
lecture video so the room behaves like a live talk. Any visitor can join a room, follow it live, rewind, and
subscribe to or drop tracks (captions, descriptions and other accessibility tracks). A live room with real agents is
the signed-token path (decision 0005).

### Consequences

* Good, because the API cost of the public demo is fixed and small.
* Good, because rewind becomes part of the product (it was cut from the earlier scope).
* Bad, because a recorder and a looping publisher are new components, and the teacher broadcast now carries video.
* Open questions are tickets: which lectures; how rewind and the loop work over the relay; what the demo moments
  (agent started mid-talk, caption agent killed on camera, load panel) become in looped rooms.
