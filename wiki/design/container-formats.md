# Container formats of the Talk Tracks tracks

Video defines what its units mean: an I-frame decodes alone, a P-frame needs the frames before it, a GOP starts with
an I-frame so a player can start there. Every Talk Tracks track states the same things here: **what a group is, what
object 0 holds (the keyframe), what later objects hold (the deltas), and how a reader rebuilds the state at room time
`t`**. The owner asked for this ([decision 0021](../decisions/0021-deck-annotations-are-shared-state-on-event-tracks.md));
the IETF-style specification papers that grow out of it are [backlog 1](../backlog.md).

Models: `agents/src/talk_tracks/contracts.py` (the source of truth), schemas in `contracts/*.schema.json`, TypeScript in
`web/src/contracts/`. Names and publishers: [lane-briefs.md §Namespaces](lane-briefs.md#namespaces).

## 1. The common model

All event tracks are MSF event timelines ([moq-track-system §4.1–4.2](moq-track-system.md#41-groups-are-time-slices-on-the-room-clock)).

| Video | Talk Tracks event track |
|---|---|
| sample | a **record** `{"m": <room ms>, "data": {"kind": …}}` |
| frame | an **object**: a JSON array of records, written once (immutable) |
| GOP, closed | a **group**: on sliced tracks the 4 s slice `[4k, 4k+4) s` of room time; nothing in it refers to another group |
| I-frame (IDR) | **object 0, the carry-in**: the state in effect at the slice start, enough to draw it with no earlier group |
| P-frames | **objects 1 and up, the deltas**: records in publication order, each applied to the state before it |
| intra refresh | a **re-send**: whole-state records sent again inside a slice when the slide changes (below) |
| init segment (CMAF header) | object 0 of a `deck` group (`DeckInfo`) |
| decoder | the reducer of the track (`records.py` = `tracks.ts`), which is also the carry-in builder |

Rules that hold for every sliced track:

- **Keyframe.** Object 0 of group `k` = `reducer(every record before 4k s)`, reduced to what the carry-in keeps. Its
  records keep the `m` of when they took effect, so they may lie before the slice. MSF §8.3 wants all records so far;
  ours is bounded to what is on screen (declared deviation, moq-track-system §4.2).
- **Deltas.** Objects 1.. hold the slice's records in publication order, each in the slice of its `m`. Speaker and
  room-service tracks are on time (`latenessMs` 0); a batch (pointer samples) is cut at the slice boundary.
- **Decoding at `t`.** Fetch group `⌊t/4000⌋` (one group, no index needed), take its objects in order, keep records
  with `m ≤ t` (`upTo`), and reduce. Live is the same from SUBSCRIBE at the edge.
- **Next keyframe = this keyframe + this group's deltas.** `reducer(object 0 of k, objects 1.. of k)` equals object 0
  of `k+1`. Both test suites check this against `contracts/examples/carry-ins.json`.
- **Re-send (intra refresh) on slide change.** The carry-in holds only the slide on screen, so a slide shown again
  mid-slice would be missing its ink. Whoever publishes a per-slide state track re-sends that slide's whole state
  (`stroke`, `mark`, the threads) at the moment it is shown, with `m` = that moment. Re-sending is idempotent: a whole
  record replaces the one with the same id.
- **Missing groups** are not empty groups: a slice with nothing new still has object 0 when the publisher was live.
  An idle agent publishes none (moq-track-system §4.1).
- **End of Group** closes each slice; End of Track only when the room service closes the room.

Unsliced tracks (`deck`, `outline`, `catalog`, `frames`) have one group per document or revision, and every group
decodes alone.

## 2. Per track

`R` is the room. "State" is what the reducer returns, which is what the player draws.

### Speaker (`talk/R/slides`), published by the console

| Track | Group | Object 0 (keyframe) | Objects 1.. (deltas) | State at `t` |
|---|---|---|---|---|
| `frames` | one per slide shown | the `SlideFrame` (JPEG/PNG + wall time), the only object | none | the newest frame; input for the describe agent, not drawn |
| `deck` | **one per deck**, group number = deck id (not time) | `DeckInfo` (count, aspect, title): the init segment | `DeckImage`s (image + `runs`, the text layer), all at once or each before its slide is first shown | the deck's images and text runs; read by id, not by time |
| `slide` | 4 s slice | the last record (`show` deck/index, or `hide`) | `show` / `hide` | `currentSlide` |
| `ink` (pencil) | 4 s slice | a whole `stroke` or `shape` record per element visible on the slide on screen (`done: false` while a stroke is drawn) | `begin`, `points`, `end`, `stroke` (re-send, redo), `shape` (new, dragged, re-send, redo), `erase` (eraser, undo), `clear` | `inkCarry(records, on)`: strokes and shapes on the slide on screen |
| `marks` (text tool) | 4 s slice | a `mark` record per mark on the slide on screen | `mark` (new or re-send), `unmark`, `clear` | `marksCarry(records, on)` |
| `pointer` (laser) | 4 s slice | the last record (`at` x/y, or `off`) | `at` about 20/s while held, `off` | the last record; **ephemeral**: never re-sent, never kept per slide |

### Room service

| Track | Group | Object 0 | Objects 1.. | State at `t` |
|---|---|---|---|---|
| `talk/R/annotations` `ink` | 4 s slice | as speaker `ink`, for everyone else's strokes | as speaker `ink`; listeners' records stamped with their `by` | `inkCarry` of this track; draw with the speaker's |
| `talk/R/annotations` `marks` | 4 s slice | as speaker `marks` | as speaker `marks` | `marksCarry` of this track; draw with the speaker's |
| `talk/R/comments` `comments` | 4 s slice | the `comment` and `reply` records of the threads anchored on the slide on screen, edits applied, hidden ones left out | `comment`, `reply`, `edit`, `hide`, re-sent threads | `commentsCarry(records, on)` (the Discussion tab reads `commentThreads` over many groups) |
| `talk/R/catalog` `room` | 4 s slice | the last `state` record | `state` | the last record |
| `talk/R/catalog` `catalog` | one per change | the whole MSF catalog (`RoomCatalog`) | none | the newest group |

### Agents (`talk/R/agents/<agent>`)

| Track | Group | Object 0 | Objects 1.. | State at `t` |
|---|---|---|---|---|
| captions `items`, translation `items` (`CueObject`) | 4 s slice (+ `latenessMs`) | optional note (`tt.capped`, `tt.from`), then the last 2 cues before the slice | cues; a cue id may come again with a higher `rev` (interim → final) | merge by id, highest `rev` (`latest`); a seek fetches `⌊t/4⌋−1 … ⌊(t+L)/4⌋` |
| descriptions `items` (`SlideObject`) | 4 s slice | optional note, then the slide description on screen | new descriptions | the last description with `at ≤ t` |
| chapters `outline` (`OutlineObject`) | one per revision | the whole outline (chapters, terms, recap) | none | the newest group |

### Media (`talk/R/teacher`)

hang's own format (`catalog.json` with the root `clock`, Opus audio, H.264 video): groups are hang's, keyframe at
each video group start. Archived as fMP4/HLS. Not ours to define; listed so the papers can reference it.

## 3. Shared annotation state (decision 0021)

- **Three tools, three tracks.** The laser is `pointer` (ephemeral, not state). The pencil is `ink` (strokes that stay
  on their slide, with `pen` and `highlighter` its two nibs, and shapes: `rect`, `ellipse`, `line`, `arrow`). Text marks are `marks` (underline or highlight anchored to
  a range of the slide's text runs, so "underline slide 13 run t23" is `{deck, index: 13, span: [{run: "t23"}]}`).
- **The deck is shared state.** State of slide `s` at `t` = the deck image of `s` + the strokes and marks of the
  speaker's tracks + those of the annotations tracks + the comment threads. Each track is reduced on its own; a
  record never changes another track's state.
- **Who may change what.** Every `begin`, `stroke`, `erase`, `clear`, `mark`, `unmark`, `comment`, `reply`, `edit`
  and `hide` carries `by: {id, name, speaker}`. `points` and `end` belong to their stroke's author. The reducers
  apply erase, unmark, clear and hide only to what `by` may change (its own, or anything for the speaker) and an
  edit only from the author; the room service also refuses the rest, so the rule holds even for a bad publisher.
  `clear` therefore empties the slide for the speaker and removes a listener's own strokes for them. The speaker
  moderates listener annotations through the room service (an `erase` with `by.speaker` on the annotations track).
- **Elements of the ink track.** A stroke and a shape are both elements, with ids from one space, so `erase` and
  `clear` take either. A stroke grows (`begin`, `points`, `end`); a shape is one whole `shape` record
  (`shape`, `start`, `end` as slide fractions, `color`, `width` a fraction of the slide's width), sent again with the
  same id while its author drags it: a whole record replaces the element with its id, so the last one wins and a
  reader that joins mid-drag sees the shape as it was then. Width rides on every stroke and shape.
- **Undo and redo are records.** The undo history is the author's (the console's, per slide); its effects are
  ordinary records, so replay and late joiners match live. Undoing a new element is an `erase` of it (a text mark:
  `unmark`); redoing it, or undoing an eraser sweep or a clear, re-sends the elements whole (`stroke` with
  `done: true`, `shape`, `mark`) with m = now, which restores them; redoing an erase or clear sends it again. A
  restored element is drawn on top (its m is the restore). Listeners do the same through the room service, which
  accepts a whole `stroke` (done) or `shape` only with an id of the writer's own.
- **Stamping.** The room service stamps `by` (and prefixes ids with the user id) from the listener's session; the
  console stamps the speaker's. A listener cannot claim `speaker`.
- **Text layout.** `DeckImage.runs` is the slide's text layer from the PDF (`page.getTextContent()`): runs in reading
  order, each with an id unique in the slide, its text and its box in fractions of the slide. A `RunSpan` takes
  characters `[start, end)` of one run (the whole run by default); a part of a run is placed by character count
  across its box. Comment anchors use the same `span`.
- **Fetchable.** Every mutation is an object on a live track, so the relay caches it and the archive serves it by
  FETCH, like any other track.
