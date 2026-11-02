# Lecture package, version 1

A lecture package is a `.zip` a listener downloads from the side panel's Download popover ("Lecture package
(.zip)"). It holds a talk as files an AI assistant can read: the transcript in each language, the chapters and
glossary, every slide with the speaker's ink baked in, the listener's own notes and annotations, the slide
descriptions when the describe agent already ran, and one Markdown file, `lecture.md`,
that holds the whole lecture on its own. The owner chose the format in
[ticket 0023](../../tickets/0023-lecture-package-format.md) (option 1 with the recommendation: a folder in a .zip,
built in the browser, with option 2's single Markdown file inside it).

The code is `web/src/package/`; `lecture.ts` writes the files, so it is the reference for this page.

## 1. How it is built

- **In the browser**, from the tracks the player already reads. Nothing is built on the server and nothing is stored.
- **Without moving the playhead.** Transcripts are read slice by slice over each track's history (the same path as
  the transcript download). Slides, ink and marks are read by FETCH from the speaker's archive
  (`talk/<room>/archive/slides`), falling back to the live name for slices not archived yet, never through the
  player's slide store.
- **Final ink.** A slide's picture shows the ink and text marks on it at the end of the last span it was on screen.
  The ink carry-in holds only the slide on screen (container formats §1), so that is one ink group and one marks
  group per slide. The drawing is the player's: `canvas/ink.ts` on an `OffscreenCanvas`.
- **The listener's own annotations.** Their strokes, shapes and text marks are read from the audience track
  (`talk/<room>/annotations`, tracks `ink` and `marks`) the same way, at the end of each slide's last span, and only
  the records whose author is this listener are kept: the id the room service gave this browser
  (`tt.listener.v1`). A slide they annotated gets a second picture, `slides/NN.mine.png`, with theirs drawn over the
  speaker's. Everyone else's are left out (§5).
- **Slide descriptions.** The describe agent's descriptions are read over its history like a transcript, only when
  the same rule as the translations' says it costs nothing (below): subscribed, running, or recorded. Otherwise the
  track is never subscribed, and the package has none (`manifest.descriptions` is null). Each slide takes the newest
  description written for its position in the deck.
- **The talk so far.** During a live talk the package ends at the live edge, and says so (`lecture.live`).
- **Cost guard.** Only translations that cost nothing more to read are included: ones this listener has subscribed,
  ones the room catalog says are running (`tt.status[agent].status` is `live` and fresh), and recorded ones (catalog
  `tt.cost` is `free`, as in a looped room). Any other translation would wake a paid agent (decisions 0010 and
  0019), so it is left out and named in `manifest.leftOut` and the README. The same rule applies to the transcript
  download's "All languages".
- **Progress and cancel.** The popover shows a progress bar and a Cancel button. Cancelling stops the FETCHes and
  saves nothing.
- **Zip.** STORE only (no compression), UTF-8 names, no zip64 (`package/zip.ts`, no dependency). PNGs don't
  compress and the text is small.

## 2. Layout

```text
<room>-lecture.zip
├── manifest.json        what is in the package (§3)
├── README.md            for an AI reader: what each file is and how to read it
├── lecture.md           the whole lecture in one file (§4)
├── transcript/
│   ├── <lang>.vtt       WebVTT subtitles, one language
│   └── <lang>.md        the same as Markdown, a line per cue with its talk time
├── chapters.json        { recap, chapters: [{ number, title, summary, startMs, endMs, start }] }
├── glossary.json        [{ term, definition }]
├── slides/
│   ├── NN.png           the slide as shown, with the speaker's ink and text marks drawn on it
│   ├── NN.mine.png      the same with the listener's own annotations over it (only slides they annotated)
│   └── NN.md            the slide's text layer, when it was on screen, how much ink is on it, its description
└── notes.md             the listener's notes and bookmarks
```

| File | Purpose |
|---|---|
| `manifest.json` | The index: format, version, the lecture, languages, slides and every other file with its role and size. |
| `README.md` | Tells an assistant what the package is, which file to start with, and how far to trust machine output. |
| `lecture.md` | The lecture as one document an assistant can read without the rest (§4). |
| `transcript/<lang>.vtt` | Subtitles in one language. The original language is the first in `manifest.languages`. |
| `transcript/<lang>.md` | The same transcript as Markdown. |
| `chapters.json` | The chapters agent's outline: chapters with summaries, and a recap of the talk. |
| `glossary.json` | Terms from the talk with definitions. |
| `slides/NN.png` | Slide NN (1-based, two digits) as a PNG at the deck's own size, ink and marks baked in. |
| `slides/NN.mine.png` | Slide NN with the listener's own ink, shapes and text marks over the speaker's; only when they made any. |
| `slides/NN.md` | Slide NN's text, in reading order with line breaks, when it was shown, and its description (when gathered). |
| `notes.md` | The listener's notes and bookmarks (kept in their browser), with talk time and slide. |

- `<lang>` is the track's BCP 47 tag (`en`, `es`, `pt-BR`).
- With more than one deck in the talk, slides are named `d<deck>-NN` (`d0-03.png`), where `<deck>` is the deck
  track's group.
- A slide with no picture (the deck could not be read, or the browser cannot draw) has `slides/NN.md` only, and its
  manifest entry has `"image": null`.
- A room with no slides, captions or outline still gets a package: `manifest.json`, `README.md`, `lecture.md`,
  `chapters.json`, `glossary.json` and `notes.md`, with what there is.

## 3. `manifest.json`

```json
{
  "format": "talk-tracks/lecture-package",
  "version": 1,
  "createdAt": "2026-11-02T14:03:11.000Z",
  "lecture": { "title": "…", "speaker": "…", "room": "rsa", "live": false, "durationMs": 1712000 },
  "entry": "lecture.md",
  "languages": [
    { "lang": "en", "name": "English (original)", "original": true, "lines": 412,
      "files": ["transcript/en.vtt", "transcript/en.md"] },
    { "lang": "tr", "name": "Türkçe", "original": false, "lines": 409,
      "files": ["transcript/tr.vtt", "transcript/tr.md"] }
  ],
  "leftOut": { "languages": ["العربية"] },
  "chapters": 7,
  "glossary": 12,
  "notes": 3,
  "descriptions": 8,
  "slides": [
    { "number": 1, "deck": 0, "image": "slides/01.png", "text": "slides/01.md",
      "shown": [{ "startMs": 0, "endMs": 41000 }], "ink": 0, "marks": 1,
      "mine": { "image": "slides/01.mine.png", "ink": 2, "marks": 0 },
      "description": "A title slide with a photograph of a river delta." }
  ],
  "files": [
    { "path": "transcript/en.vtt", "role": "transcript-vtt", "mediaType": "text/vtt", "bytes": 48211, "lang": "en" }
  ]
}
```

| Field | Meaning |
|---|---|
| `format`, `version` | Always `talk-tracks/lecture-package`; the version of this page. A reader rejects a version it does not know. |
| `createdAt` | When the package was built (ISO 8601, UTC). |
| `lecture` | Title, speaker (or null), room name, whether the talk was still going, and the length covered. |
| `entry` | The file to read first: `lecture.md`. |
| `languages` | One entry per transcript, the original first: tag, name in its own script, line count, files. |
| `leftOut.languages` | Translations the room offers that were not running, so not gathered (cost guard, §1). |
| `chapters`, `glossary`, `notes` | How many of each. |
| `descriptions` | How many slides have a description; null when the descriptions were not gathered (the agent was not running). |
| `slides` | Every slide of each deck shown: number, deck, picture and text files, spans on screen, ink and mark counts; `mine` (the listener's picture and counts, or null); `description` (text or null, only when gathered). |
| `files` | Every file in the zip except `manifest.json` itself: path, role, media type, size in bytes, language. |

Roles: `readme`, `lecture`, `transcript-vtt`, `transcript-md`, `chapters`, `glossary`, `slide-image`,
`slide-image-mine`, `slide-text`, `notes`.

**Times** are talk time: milliseconds from the start of the talk in JSON (`startMs`, `endMs`, `durationMs`), `m:ss`
or `h:mm:ss` in text, as the player's clock shows them. In a looped room that is the time within the loop.

## 4. `lecture.md`

One Markdown file an assistant can read on its own:

1. `# <title>`, a line with the speaker, length and download date, and a sentence on how the file is laid out.
2. `## Recap`, when the outline has one.
3. `## Contents`: the chapters with their start times.
4. One `## N. <chapter title>` per chapter, with its start time and summary, then the original transcript as
   `**m:ss** text` lines. Where a slide was first shown, its text is quoted inline (`> **Slide 3** (shown at 4:12;
   picture with the speaker's ink: slides/03.png)` and the slide's text, then its description when there is one; the
   listener's own picture is named too). With no chapters, one `## Transcript`.
5. `## Slides not shown in the talk`, for deck slides never put on screen that have text.
6. `## Glossary` and `## My notes`, when there are any.

## 5. What is left out, and why

- **Other listeners' ink, marks and comments.** Slide comments are supplementary and off by default
  ([brand.md §6](../product/brand.md));
  the package shows the speaker's annotations and the listener's own, never anyone else's.
- **Audio and video.** The package is for reading; the replay link is the room.
- **Slide descriptions** when the describe agent is neither running nor recorded: reading them would wake a paid
  agent, so the slide's own text layer stands alone.

## 6. Versioning

A change that a version 1 reader would misread (a file moved, a field's meaning changed) bumps `version`. Adding a
file or a field does not: readers ignore what they do not know. `slides/NN.mine.png`, `descriptions` and the slides'
`mine` and `description` fields were added (11-02) within version 1 on that rule.
