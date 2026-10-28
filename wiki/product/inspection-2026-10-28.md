# Inspection of the running app (2026-10-28)

The owner's walk through the deployed app, ahead of the design session the same day. Findings feed `wiki/spec/` and
the Product spec and UI lane.

## Screens

| Screen | Path | What it is |
|---|---|---|
| Landing | `/` | entry page |
| Viewer | `/watch/<room>` | a room's speaker, opted-in tracks, captions, translation, slide descriptions, chapters |
| Speaker console | `/talk/<room>?token=…` | publishes the speaker's audio (and slides) with a signed token |
| Offline demo | `/demo` | a scripted room with no relay, for when the network fails |

## Known before the inspection

- The `demo` room still plays the synthetic placeholder: four repeating lines, a `[tr]` prefix instead of Turkish,
  and every track labelled "fake". The Demo content lane replaces it with the two picked lectures.
- Tracks are all on by default; decision 0010 makes them opt-in.
- At the default pane width, the viewer shows no visible video before "Play speaker audio" (one media element on the
  page).

## Owner's verdict

The current web app is a smoke-test shell, not the product. What we build is a finished product any teacher or student
can use: a properly designed, thought-through interface, with richer features and our own UI twist on what existing
video-conferencing and lecture products do.

Next: a field research pass over video-conferencing, webinar, lecture-capture and live-caption products, their UI
and their capabilities, for inspiration (`wiki/product/research-video-products.md`). The design session works from
it.
