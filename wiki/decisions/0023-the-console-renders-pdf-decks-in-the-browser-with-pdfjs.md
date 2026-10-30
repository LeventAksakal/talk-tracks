---
status: proposed
date: 2026-10-30
decision-makers: coordinator, project owner
refines: 0018 (the speaker sends slides), 0021 (text runs anchor the marks)
---

# The speaker console renders PDF decks in the browser with PDF.js

## Context and Problem Statement

The speaker loads a deck as a PDF (exported from PowerPoint, Keynote or Google Slides). The console publishes
each slide as a `DeckImage` on the `deck` track, with the slide's text runs for text marks
([0021](0021-deck-annotations-are-shared-state-on-event-tracks.md)), and a `SlideFrame` JPEG for the describe agent
([0018](0018-speaker-sends-slides-ink-laser-and-camera.md)). Something must turn PDF pages into images and text runs
with boxes. Where does that run, and with which renderer?

## Decision Drivers

* Text runs need each text item's string and transform. Decision 0021 already assumes PDF.js `getTextContent()`.
* No server work before the talk: the console runs in the speaker's browser and the deck never leaves it except as
  the published slides.
* Public repo under a permissive licence: no AGPL dependency.
* Desktop Chrome first. The first slide should show within a second or two of choosing the file.

## Considered Options

* **A. PDF.js (`pdfjs-dist`, Apache-2.0) in the browser**, with its own worker.
* **B. MuPDF.js (WebAssembly) in the browser.** Fast and faithful, but AGPL-3.0, or a commercial licence.
* **C. PDFium compiled to WebAssembly** (for example an `@embedpdf/pdfium` build). Chrome's own renderer, but a
  community wasm wrapper with its own text API, and a further build artefact to track.
* **D. Render on the VM** (`pdftoppm` or similar) after an upload. Needs an upload endpoint, storage and a token, and
  makes a server step of what is a local action.

## Decision Outcome

Chosen: **A, PDF.js 6.4.299 in the browser.**

* `web/src/speaker/deck.ts` opens the file with `getDocument({ data })`, loads the worker from
  `pdfjs-dist/build/pdf.worker.min.mjs?url`, and imports both on demand, so only `/talk` pays for them.
* Each page is rendered 1600 px wide to WebP (quality 0.85, JPEG when the browser cannot encode WebP) for the
  `deck` track, and 1280 px wide to JPEG (0.8) for the `frames` track. The slide shown first is rendered first,
  the rest follow one by one.
* Text runs come from `page.getTextContent()`. Each item's transform is multiplied by the viewport's. The box is
  the item's width by its font size, with its top at the baseline minus 0.8 of the size (a standard ascent).
  Blank and rotated items are skipped. Ids are `t0`, `t1`… in content order (`web/src/speaker/runs.ts`).
* The QR code on the invitation is made with `uqr` 0.1.3 (MIT, no dependencies) and drawn as one SVG path.

### Consequences

* Good: one dependency serves images and text. It runs offline, needs no server, has a permissive licence, and is
  the most-used PDF engine on the web.
* Good: the deck's PDF fingerprint keys the speaker's private notes in local storage, so notes come back when the
  same deck is loaded again.
* Bad: PDF.js is large (the worker is about 1 MB minified). It is loaded only on `/talk`, after the speaker picks a
  file.
* Bad: run boxes are approximate. A part of a run is placed by character count, and the ascent is a fixed fraction,
  so underlines can sit a little off on unusual fonts. The marks still name the text exactly.
* Bad: fonts the PDF does not embed are substituted by PDF.js, so a slide can look slightly different from the
  speaker's app. Exporting with embedded fonts avoids it.

### Why not the others

* B: AGPL in a public hackathon repo forces the whole web app under AGPL, or a licence purchase.
* C: no gain over PDF.js for 16:9 slide decks, and a less proven text-position API.
* D: a server round trip before the first slide, and storage of the speaker's PDF, for no gain in what viewers see.
