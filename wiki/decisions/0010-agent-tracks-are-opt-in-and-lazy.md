---
status: accepted
date: 2026-10-28
decision-makers: project owner
---

# Agent tracks are opt-in, and an agent spends only while someone subscribes to its track

## Context and Problem Statement

The first build runs every live agent eagerly. Captions transcribe whenever a speaker is on air, and translation,
chapters and slide descriptions process every line and slide. The viewer subscribes to every track by default. That
spends API credit on tracks nobody reads.

## Decision Outcome

API use is lazy, not eager:

* **Viewers opt in to each track.** Watching a talk is like watching a video: subtitles, a translation, the chapter
  summary and slide descriptions are each switched on or off by the viewer. None is on by default.
* **An agent does paid work only while its track has at least one subscriber,** directly or through a downstream
  agent. For example, translation subscribing to captions keeps captions running. With no subscribers it stays
  connected and idle, spending nothing.
* **Generated output is kept, so it is paid for once.** A track's history is stored (decisions 0007 and 0009), so
  later viewers and rewinds read it without new API calls.
* **Demo rooms are the exception.** Their tracks are generated once, all together, when the lecture is prepared
  (decision 0006). Replaying them costs nothing.

### Consequences

* Good, because spend follows real use; an empty room or a room nobody reads costs nothing.
* Good, because it makes the MoQ argument concrete: the relay only forwards what someone asked for, and the publisher
  sees when nobody is asking.
* Bad, because a track switched on mid-talk starts from that moment. Its earlier part needs a back-fill path, or it
  stays empty.
* Bad, because agents must track their subscribers through the relay. moq-relay subscribes upstream on demand, and how
  promptly it drops an upstream subscription after the last viewer leaves has to be measured.
* Bad, because the viewer's defaults change: ticket 0014's "subscribe to everything except other translations" is
  replaced by "nothing until chosen".
