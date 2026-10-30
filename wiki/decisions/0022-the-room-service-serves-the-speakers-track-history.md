---
status: proposed
date: 2026-10-30
decision-makers: coordinator, project owner
refines: 0012 (who is the FETCH origin of a track's past), 0018 (the speaker's event tracks)
---

# The room service serves the past of the speaker's event tracks, on `talk/<room>/archive/slides`

## Context and Problem Statement

Every interaction is an event track in 4 s slices with a carry-in, and a replay reads the same tracks by FETCH
(decisions [0012](0012-ai-track-history-by-fetch-from-the-agent.md), [0017](0017-viewer-is-a-media-player-and-every-interaction-is-a-track.md),
[0018](0018-speaker-sends-slides-ink-laser-and-camera.md)). For an agent track the publisher is the origin of its
past: moq-relay forwards a FETCH it cannot serve from its ~30 s cache to the publisher, and the agent answers from
its slice store.

The speaker's `deck`, `slide`, `ink`, `marks` and `pointer` tracks are published by a browser on `talk/<room>/slides`. A
browser cannot be that origin: `@moq/publish` keeps no history to answer a FETCH from, and the browser is gone when
the talk ends, after which moq-relay serves nothing of the track. Someone else must hold the past
and answer FETCH for it, under a name a player can find.

## Considered Options

* **A. The room service mirrors the speaker's tracks and serves their past on a second name,
  `talk/<room>/archive/slides`**, same track names, group numbers and bytes. Live stays on the speaker's track.
* **B. The room service is the only publisher of `talk/<room>/slides`:** the console publishes to a private
  namespace, and the room service re-publishes it live and serves its past, so live and past share one name.
* **C. Two publishers of `talk/<room>/slides`:** the room service announces the speaker's namespace too, to catch
  FETCH misses.
* **D. Rewind by HTTP:** the player reads the archived slices as files, as media rewinds over HLS.

## Decision Outcome

Chosen: **A**.

* The room service (`python -m talk_tracks.archive`) subscribes to every track `room_catalog.speaker_tracks` lists,
  with a Joining FETCH, while the speaker's namespace is announced. That is free: no agent does work for it
  (design §5.4). It writes each object as received, under the speaker's group and object numbers, into the slice store
  (`<room>/slides/<track>/<k>.slice`). A group it joined after object 0 is skipped, not stored in part.
* It publishes the same track names on `talk/<room>/archive/slides` and answers each FETCH there from the archive
  (disk, then the bucket), with the true End Location, as an agent does. A group never archived is a REQUEST_ERROR.
  At start it serves the history of every room in the archive, so a talk stays fetchable after its speaker left.
* Tracks the room service publishes itself (`room` now; `comments` and the audience `ink` and `marks` on
  `talk/<room>/annotations` when their lanes land, with the re-send at each slide change that container-formats.md
  asks) need no second name: like an agent, it writes each object live and to the archive, and answers FETCH on the
  same name.
* A looped demo room has no room service. Its looper computes `deck` and `slide` from the lecture's slides and
  publishes them on both names, so the player's rule holds there too.
* **The player's rule:** subscribe live to the speaker's `talk/<room>/slides/<track>`; fetch a past group from
  `talk/<room>/archive/<rest>/<track>`. That is `history_path(namespace)` in `talk_tracks.archive.events`. Room service
  and agent tracks are fetched on their own names.
* The room service's token adds publish on `talk/*/archive/**`, `talk/*/comments` and `talk/*/annotations`; a looper's adds
  `talk/R/slides` and `talk/R/archive/**`.

### Consequences

* Good, because the history is served by FETCH, through the relay and its cache, in the same slices and bytes as
  live, and it outlives the speaker's browser.
* Good, because no contract or console change is needed: the speaker keeps publishing what decision 0018 says, and a
  console reload continues the same tracks.
* Good, because the live path keeps one hop: the speaker's laser and ink reach viewers without passing through
  Python.
* Good, because which tracks are mirrored comes from `room_catalog`, so a speaker track added there is archived with
  no change in the room service.
* Bad, because live and past have two names for the speaker's tracks. The player needs the naming rule, and the
  catalog does not say it yet (see below).
* Bad, because the archive holds what reached the room service: a slice that started before its subscription, or
  while it was restarting, is missing from the history (seconds at most).
* Bad, because a seek inside the live slice reads the archive's copy so far, which can trail the speaker's by the
  relay hop. The player can take the open slice from its live subscription.

### Why not the others

* **B** gives one name, but every live stroke and laser sample passes through a Python process, and a room service
  restart drops the speaker's live slides for all viewers. It also changes the contracts, the console and the
  speaker's token two days before the Nov 2 checks.
* **C:** moq-relay routes a broadcast to its newest announcer (spike S2), so the room service would take over live
  subscriptions, and its own subscription to the speaker would loop back to itself.
* **D** works, but it leaves MoQ for event tracks, which decision 0012 keeps in it. Media stays on HLS (0012).

## Follow-ups

* Contracts pass 2: a catalog field that names the history namespace, for example `tt.history` on each speaker
  track, so the player reads it instead of the rule. Until then the rule holds.
