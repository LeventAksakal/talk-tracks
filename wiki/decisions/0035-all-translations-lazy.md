---
status: accepted
date: 2026-11-03
decision-makers: project owner, coordinator
supersedes-in-part: 0014, 0019
---

# Every translation is lazy, in every room, from one language list

## Context and Problem Statement

The owner, 2026-11-03: "translations are whatever languages meta api supports and all should be lazy". Until then
three languages were special: dedicated `translate-tr`, `translate-es` and `translate-ar` services ran beside
`translate-any` ([decision 0014](0014-translations-in-turkish-spanish-and-arabic.md)), the demo rooms replayed
pre-made tr, es and ar tracks from their recordings, and `translate-any` skipped those three there
([decision 0019](0019-subtitles-in-any-language-the-model-supports.md)). No agent ever joined a recording room
(`<id>-recording`, [decision 0032](0032-each-demo-lecture-has-a-recording-and-a-live-session.md)): agents serve a
room while its speaker is on air, and a recording room has no speaker. So a recording offered only its baked tracks.
The language list was written twice, in `web/src/player/languages.ts` (called a placeholder) and
`agents/src/talk_tracks/languages.py`.

Asked through the question prompt on 2026-11-03, the owner chose:

1. Scope: **"Live + recordings"**. Drop the fixed tr/es/ar services, and let `translate-any` also serve recording
   rooms on demand, from the archived captions.
2. The pre-made tr/es/ar of the four demo lectures: **"Drop them"**. Every language is made the same way, on first
   pick.
3. The menu's language list: **"Meta's documented list"**, generated for the web and the agents from one file.

## Decision Outcome

* **One agent, every language, lazy everywhere.** `translate-any` (`translate --lang any`) publishes one lazy track
  per listed language in each room it serves. A track spends only while a viewer subscribes (live translation) or
  fetches a past slice nobody produced (back-fill), against the room's cap (decision 0008). No language is special:
  the `translate-tr/es/ar` services, `TT_LANG_EXCLUDE` and the demo rooms' pre-made skip are gone.
* **Demo rooms** are served like the other live agents serve them: only with `TT_DEMO_LIVE_AGENTS` on (decision
  0034), live only, session by session, never back-filled. With the switch off a demo room has no translation, and
  no model call happens in it.
* **Recording rooms** are served with the switch on, back-fill only:
  * **Found in the archive.** `translate-any` lists `<archive>/<id>-recording/room.json` (what `record-archive`
    writes) and serves each such room for good, read again every 60 s. A recording room has no speaker to come on air
    and is ended from the start, so neither starts nor stops it. Only the archive scan makes a room a recording room,
    never its name: a live room whose speaker goes on air is served live whatever it is called, and creating a room
    whose name ends in `-recording` is refused.
  * **All past.** The room's clock edge is just past its end (its `room` track's last slice), so a FETCH of any
    slice up to the end is translated once from the captions slice `serve-recording` answers from the archive, then
    served from disk. Nothing runs live and nothing is made without a FETCH: no slice clock runs, and an idle track
    rewrites its `track.json` only when its state changes.
  * **Spend.** The room's own cap (`TT_ROOM_CAP_USD`, or a caps batch that lists it, as decision 0034's demo batch
    does), with the whole cap open to back-fill (share 1.0, not the 25 % a live room keeps for live work: a
    recording room has none). Out of budget, the track is capped and the catalog says so.
  * **Catalog.** `serve-recording` publishes only the baked tracks and, on every catalog heartbeat, lists the
    translations announced in the room now. A translation is listed only while its agent is up to answer for it, and
    each track has one publisher.
* **Switch off, no translation in a demo lecture's rooms.** With `TT_DEMO_LIVE_AGENTS` off, neither a demo room
  nor its recording room offers any translation at all: no language is listed, none can be picked, and no model call
  happens in either (decision 0034). This follows from dropping the pre-made tracks, and is accepted.
* **Generation rooms.** `translate-any` never serves a `gen-*` room, where `generate` records a demo lecture:
  translations are never recorded, so a viewer there could only spend.
* **No pre-made translation.** `generate` subscribes no translation track (its recorder skips them), and a
  recording's translations are left out wherever it is replayed (`session.honest_recording`): a switch-off session
  and `record-archive`. The offline fixes for them, `retranslate` and `resplit`, are removed: nothing else used them.
* **One list.** `contracts/languages.json` holds the tags and English names. The player imports it; the agents'
  `language_list.py` is generated from it (`python -m talk_tracks.languages`), since the agents image has no
  `contracts/` folder, and `test_languages` fails while the two differ.
* **Source unconfirmed.** Meta documents no language list for `muse-spark-1.3`. Searched on 2026-11-03: the models
  page (`https://dev.meta.ai/docs/models.md`) lists modalities and IDs but no languages; `https://dev.meta.ai/llms.txt`
  has no page on languages; Muse Spark Open (`https://dev.meta.ai/docs/muse-spark-open.md`) says only that it "was
  trained on data from more than 100 languages"; the one list Meta publishes is Muse Voice Transcribe's 25 speech
  languages (`https://dev.meta.ai/docs/speech-to-text.md`), which is the captions model, not the translator. So the
  file keeps the project's 50 languages, marked `"source": "unconfirmed"`.

### Why this design for recording rooms

* An archive scan needs no new setting or token: `record-archive` already marks a built room with `room.json`, and
  the room service never archives a `*-recording` room (`TT_ARCHIVE_SKIP`), so nothing else matches. A fixed room
  list in the compose file would have to be kept in step with the rooms built; watching the relay for
  `talk/*-recording/catalog` would need a new announcement path.
* The existing back-fill path does the work unchanged: the same FETCH handler, archive and ledger as an idle track
  in a live room. Only the clock edge differs, which is what lets every past slice be back-filled.
* Listing announced translations in `serve-recording`'s catalog, not every folder on disk, keeps the catalog honest:
  switch off (or the agent down), a recording room lists no translation it cannot answer for.

### Consequences

* Good, because a translation in any listed language costs nothing until a viewer picks it, in every room type,
  and a recording room now offers every language too.
* Good, because the language list lives in one file with an agreement test.
* Bad, because the first lines of a newly picked language take a model call each: a live track starts with the
  next captions, a recording room's slices come as the player fetches them (one call per 4 s slice, one at a time
  behind live calls).
* Bad, because a recording room's back-fill spend is cumulative against its cap, like any room's, until a caps
  batch for the recording rooms is set (wiki/howto/demo-rooms.md).
* Bad, because the list is not Meta's: a language the model translates poorly can still be picked.
* Supersedes in part: decision 0014's three fixed languages and its offline `retranslate`/`resplit` path, and
  decision 0019's "the pre-made tr, es and ar tracks of the demo rooms stay".
