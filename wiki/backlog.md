# Backlog

Work agreed with the owner but not scheduled in [plan.md](plan.md). Each entry leads with its purpose; the ID in
parentheses is for replies.

## Specification papers for the Talk Tracks container formats, in the style of the IETF LOC and CMAF drafts (backlog 1)

**Why.** The owner's instruction (decision [0021](decisions/0021-deck-annotations-are-shared-state-on-event-tracks.md)):
"you must note all the container format defined in here and produce specification papers similar to LOC or CMAF IETF
drafts". The formats are noted in [design/container-formats.md](design/container-formats.md); the papers make each
one implementable by someone who never read our code.

**Each paper states:** the MSF catalog entry (packaging, mimeType, eventType, role, template, the `tt` extension); the
group (time slice or document), object 0 (keyframe, carry-in) and later objects (deltas); the record syntax as JSON
Schema (generated from `contracts.py`); the decoding algorithm at room time `t` and the carry-in builder, with the
"next keyframe = keyframe + deltas" invariant; publisher rules (re-send on slide change, lateness, End of Group);
authorship and who may change what; declared deviations from MSF; examples from `contracts/examples/`; security and
privacy considerations; IANA-style registrations of the `com.talktracks.*` event types.

**Formats to cover:**

| Format | Track(s) | eventType / object |
|---|---|---|
| Room clock and slicing (the common part: room time, `E`, `tt.shift`, 4 s groups, carry-ins) | all sliced tracks | MSF template `[0, 4000, [0,0], [1,0], E, 4000]` |
| Room catalog extension (`tt`: `E`, `shift`, `status`, `sources`; per-track `tt`) | `talk/R/catalog` `catalog` | `RoomCatalog` |
| Room state | `talk/R/catalog` `room` | `com.talktracks.room`, `RoomStateObject` |
| Slide deck (init object + images + text runs) | `talk/R/slides` `deck` | `com.talktracks.deck`, `DeckObject` |
| Slide shown | `talk/R/slides` `slide` | `com.talktracks.current-slide`, `CurrentSlideObject` |
| Ink, the pencil (speaker and audience) | `talk/R/slides` `ink`, `talk/R/annotations` `ink` | `com.talktracks.ink`, `InkObject` |
| Text marks, underline and highlight (speaker and audience) | `talk/R/slides` `marks`, `talk/R/annotations` `marks` | `com.talktracks.marks`, `MarksObject` |
| Laser pointer | `talk/R/slides` `pointer` | `com.talktracks.pointer`, `PointerObject` |
| Comments on slides | `talk/R/comments` `comments` | `com.talktracks.comments`, `CommentsObject` |
| Slide frames for the describe agent | `talk/R/slides` `frames` | `SlideFrame` |
| Captions and translations (WebVTT-MSF cues with `rev`, `final`, carry-in note) | `talk/R/agents/<agent>` `items` | `urn:msf:captions:webvtt`, `CueObject` |
| Slide descriptions | `talk/R/agents/describe` `items` | `com.talktracks.slides`, `SlideObject` |
| Outline: chapters, glossary, recap | `talk/R/agents/chapters` `outline` | `com.talktracks.outline`, `OutlineObject` |
| Recordings of agent output (archive files, not on the wire) | archive | `Recording`, `RecordedSnapshot` |

The speaker's media (`talk/R/teacher`, hang `catalog.json`, Opus, H.264) is hang's format: referenced, not specified.

**Done when:** one paper per row (or one paper with a section per row) in `wiki/spec/` in IETF draft structure,
reviewed by an agent that has read only the papers and can write a conforming reader for the examples.
