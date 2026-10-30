---
status: proposed
date: 2026-10-30
decision-makers: project owner, coordinator
---

# The deck and its annotations are shared state: three tools, every mutation an event, each track's container defined

## Context and Problem Statement

The first contracts pass ([0017](0017-viewer-is-a-media-player-and-every-interaction-is-a-track.md),
[0018](0018-speaker-sends-slides-ink-laser-and-camera.md)) gave the speaker `ink` (pen, highlighter) and `pointer`
(laser) tracks and gave listeners `comments` through the room service. The owner was asked whether ink should come
back when the speaker returns to a slide, and answered:

> "well laser pointer and pencil and text underlining should be seperate tools and do what they suggest. If you treat
> the slide deck as a shared state then every mutation or operation (underline page.13 tesxt23 or pencil drawing
> etc.) those are live tracks (and cached so can be fetched) created by every user. Again what objects are (in video
> its I frame B frames etc; groups are GOPs etc.) we define the container format and actions there as per the
> application. you must note all the container format defined in here and produce specification papers similar to
> LOC or CMAF IETF drafts; note it in backlog."

Open points: is text underlining part of ink or its own thing, how is a piece of slide text addressed, who may create
and remove annotations, where do listeners' annotations go given that listeners never publish to the relay
([0005](0005-publishing-needs-a-signed-token.md)), and where is each track's container written down.

## Decision Drivers

* The owner's four points: separate tools; the deck as shared state; every mutation an event on a live, cached,
  fetchable track; containers defined like video's I-frames and GOPs.
* Seeking reads one group (ui-design §3.4); replay is the same tracks read by FETCH.
* Decision 0005: listeners hold no relay publish rights.
* Small change for lanes already building on the first pass (Player, Console, Archive).

## Considered Options

### A. Underlining

1. **A separate `marks` track of text marks anchored to text runs** (chosen).
2. A third ink tool (`underline`) drawn as a straight stroke under the text.
3. A comment kind (an anchor with no text).

| Option | Good | Bad |
|---|---|---|
| **1. `marks` track** | a separate tool, as the owner asked; addresses text ("page 13, text 23"), so it follows the text and can be searched and listed | needs the slide's text layout on the wire; one more track |
| 2. ink tool | no new track | pixels, not text: misses the owner's "underline page.13 text23"; not a separate tool |
| 3. comment kind | reuses anchors | mixes a drawing tool into discussion; comments are moderated text, marks are not |

### B. Addressing slide text

1. **Text runs with ids and boxes on each `DeckImage` (`runs`), ranges as run spans** (chosen).
2. A plain text string per slide with character offsets (the first pass's `text` and `TextSpan`).
3. Boxes only (regions), no text.

| Option | Good | Bad |
|---|---|---|
| **1. runs** | "run t23" is a stable name; the box places the mark without re-running PDF layout; PDF.js `getTextContent()` gives items with text and transform | a part of a run is placed by character count (approximate inside a run); a larger deck object |
| 2. string + offsets | small | offsets carry no position, so the player must lay text out again; no stable name |
| 3. regions | no text layer needed | not text: no search, does not follow the owner's addressing |

### C. Where listeners' annotations go

1. **One room-service namespace `talk/R/annotations` with `ink` and `marks`, the same objects as the speaker's**
   (chosen).
2. A track per user (`talk/R/annotations/<user>/ink`).
3. The room service writes into the speaker's tracks.
4. Listeners publish directly with a narrow token.

| Option | Good | Bad |
|---|---|---|
| **1. room-service tracks** | keeps 0005; one subscription per kind however many listeners; one carry-in builder; the room service stamps authors and enforces who may change what | the room service is in the path of every listener stroke (latency of one hop; rate limits needed) |
| 2. per user | matches "created by every user" literally | a player subscribes to an unknown, growing set of tracks; each needs a catalog entry, carry-ins and archive; listeners would still not publish (0005), so the room service would publish N tracks |
| 3. speaker's tracks | one track per kind | a MoQ track has one publisher; the speaker's browser owns `talk/R/slides` |
| 4. direct publish | lowest latency | reverses 0005; no place to stamp authors or rate-limit |

### D. Where container semantics live

1. **A design page, `wiki/design/container-formats.md`, linked from lane-briefs §Namespaces; the IETF-style papers
   are a backlog item** (chosen).
2. Write the papers now.

Option 2 costs a day before the Nov 2 checks; the page gives the lanes the semantics now and is the papers' outline.

## Decision Outcome

1. **Three separate tools.** The laser is `pointer`: ephemeral, never part of the deck's state, never re-sent, never
   kept per slide. The pencil is `ink`: freehand strokes (`pen`, `highlighter`) that stay on their slide and come back
   when it is shown again. Text marks are `marks`: `underline` or `highlight` anchored to a range of the slide's text.
2. **The deck with its ink, marks and comments is shared state.** Every mutation (`begin`/`points`/`end`/`stroke`,
   `erase`, `clear`, `mark`, `unmark`, `comment`, `reply`, `edit`, `hide`) is a record on a live event track, cached
   by the relay and served by FETCH from the archive like any other track.
3. **Anyone in the room may annotate.** The speaker publishes on `talk/R/slides` (`ink`, `marks`). *Coordinator's
   reading of the owner's "created by every user" together with 0005:* everyone else's mutations go through the room
   service, which publishes them on `talk/R/annotations` (`ink`, `marks`) and, as before, `talk/R/comments`.
   Every mutation names its author, `by: {id, name, speaker}`, stamped by the publisher; `points` and `end` belong to
   their stroke's author. Erase, unmark, clear and hide apply only to the author's own work, or to anyone's for the
   speaker; an edit only from the author. The reducers enforce this too, so every reader agrees.
4. **Each track's container is defined**: what a group is, what object 0 (the keyframe) holds, what later objects (the
   deltas) hold, and how a reader rebuilds the state at `t`, in
   [container-formats.md](../design/container-formats.md). The specification papers are
   [backlog 1](../backlog.md).

Text layout: `DeckImage.runs` (replacing the first pass's `text`), each `{id, text, box}` with the box in fractions of
the slide; ranges are lists of `{run, start?, end?}`; comment anchors use the same `span`.

### Consequences

* Good, because each tool does one thing, and underlines address text, as the owner described.
* Good, because the speaker's and the audience's annotations share one contract and one reducer; replay and seek are
  unchanged (one group).
* Good, because authorship makes moderation and "show only the speaker's ink" possible in the player.
* Bad, because every annotation record is larger (`by` on each mutation) and the deck object carries the text layer.
* Bad, because the room service gains two tracks, re-sends on slide change for them, and a write endpoint with rate
  limits (Comments lane scope grows).
* Neutral: the first pass's `Comment.author`/`speaker`, `Reply.author`/`speaker`, `TextSpan` and `DeckImage.text`
  are replaced (no lane had used them yet).

### Confirmation

Both test suites check the examples in `contracts/examples/` (which include a listener erasing another's stroke, a
listener's clear, and the speaker's moderation) against the same carry-ins, and that a carry-in rebuilt from the
previous one plus its group equals the one built from the whole history.
