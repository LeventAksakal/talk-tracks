# 04 · Slides canvas and tools

**Status:** in review (`lane/slide-tools`) · **Session:** slide tools lane · **Due:** Mon Nov 2, 18:00 +03 · **Depends on:** 02 (ink palette), a
contract change via 05 · **Feeds:** 06, 07

## Goal

Make drawing on slides feel as good as Excalidraw: a compact toolbar with basic shapes, pen, marker, eraser and laser,
plus undo, colours and stroke widths. Everything stays on the existing tracks, so it replays exactly in rewind.

## What exists (2026-10-31)

- **Console tools:** pen, highlighter, text marks (underline and highlight on the slide's PDF text), laser, eraser,
  clear (`web/src/speaker/draw.ts`, `runs.ts`, `Console.tsx`, `Stage.tsx`).
- **Player drawing:** slides, ink, marks and laser from their tracks, live and rewound
  (`web/src/player/SlideSurface.tsx`, `slideTracks.ts`, `overlays.ts`), on a main-thread canvas tied to the frame
  clock (decision 0020).
- **Contracts:** `InkTool = "pen" | "highlighter"`; ink records `begin`, `points`, `end`, `stroke` (carry-in),
  `erase`, `clear`, with `by` authorship; coordinates are fractions of the slide (`web/src/contracts/types.ts`,
  Python models in `agents/`, schemas in `contracts/`). There are **no shape records**.
- **Audience:** pen and marks for listeners go through the room service (`talk/R/annotations`), in flight on
  `lane/audience-annotations`.

## What to take from Excalidraw (MIT licence)

| Excalidraw feature | Here |
|---|---|
| One floating toolbar, one-key shortcuts, number keys for tools | Same pattern on the console's slide; check Excalidraw's current key map and copy it |
| Freehand strokes via `perfect-freehand` (MIT) | Use the library for pen and marker: smoothing, pressure, tapering |
| Rectangle, ellipse, diamond, line, arrow | Rectangle, ellipse, line and arrow are a must; diamond is optional |
| Laser with a fading trail | Our pointer track already samples about 20 per second; draw a fading trail from it |
| Eraser that removes whole elements when you sweep over them | Same, using the existing `erase` record |
| Stroke colour, width, opacity popover | Colour from the ink palette (02), 3 widths, marker uses fixed opacity |
| Undo and redo | Undo publishes `erase` for your last element; redo re-sends it as a `stroke` or `shape` |
| Hand-drawn look via `roughjs` (MIT) | Optional; clean lines by default suit slides better |

**Recommendation:** borrow the UX and the two small libraries; **do not embed `@excalidraw/excalidraw`**. It is a
large bundle that hurts LCP, and its own scene model would fight our track model (carry-ins, `by` authorship,
replay at room time). Any code copied from Excalidraw keeps its MIT notice, listed in `NOTICE`.

## Contract change (through the coordinator, 05)

Add a `shape` element to the ink track, so shapes are archived, carried in and replayed like strokes:

- `kind: "shape"`, `stroke` (id), `shape: "rect" | "ellipse" | "line" | "arrow"`, `from` and `to` as slide
  fractions, `color`, `width`, `by`; carried in by object 0 like a finished stroke; removed by `erase` and `clear`.
- Optionally widen `InkTool` with `"marker"` as a name for the highlighter.
- Python model, generated JSON Schema, TS types and validators updated together. The archive mirrors the ink track
  as is; confirm a replay carries shapes.

## Scope

1. Contract change above, agreed with the coordinator first (half a day at most).
2. Shared canvas module (`web/src/canvas/`): tool state, hit-testing, rendering of strokes and shapes, used by both
   the console and the player, so live and replay draw the same.
3. Console toolbar: select tool (keys), colour, width, undo/redo, clear with confirm; laser trail.
4. Player: render shapes and the laser trail live and in rewind; the listener toolbar (if annotations merged) uses
   the same component with the listener's allowed tools.
5. Pointer and touch: pen pressure where available, `setPointerCapture`, no scrolling while drawing on phones.

## Performance budget

- The drawing path must not drop frames: under 4 ms per pointer move on a mid laptop; no long tasks over 50 ms while
  drawing (06 checks with a DevTools trace).
- Points batched into `points` records at the current rate; no new record per pixel.

## Definition of done

- On the console: rectangle, ellipse, line, arrow, pen, marker, eraser, laser, undo/redo, colours and widths all
  work by mouse, pen and touch, with shortcuts.
- In the player: the same drawing appears live within the normal delay and replays identically after a seek.
- Tests for the new records (contracts) and for the canvas reducer; web checks pass; merged by the coordinator.

## Start prompt

> You are the Slides canvas session for Talk Tracks. Read `wiki/workstreams/04-slides-canvas.md`, the ink contract in
> `web/src/contracts/types.ts`, and the console and player drawing code. First propose the `shape` record and the
> canvas module layout to me (short), then build on branch `ws/slides-canvas`. Log progress in the workstream file.

## Log

| When (+03) | Session | Entry |
|---|---|---|
| 10-31 12:57 | coordinator | Brief written. |
| 10-31 | slide tools lane | Contract: `shape` record on the ink track (`rect`, `ellipse`, `line`, `arrow`; `start`, `end`, `color`, `width`, `by`; stroke id space, re-sent while dragged). Undo/redo are `erase` and whole re-sends, no new record; room service accepts a listener's own whole `stroke`/`shape`. Shared drawer `web/src/canvas/ink.ts` (perfect-freehand pen). Console: shape tools R/O/A/I, digits, 3 widths (`[` `]`), Shift for even shapes, Undo/Redo + Ctrl+Z/Y, per-slide history. Verified in a browser: console draw/undo/redo/eraser, `/demo` live and rewound. Open: listener toolbar width/shapes/undo (contract ready), laser trail, marker rename, touch/pen pressure not checked, Shift-constrain only unit-tested. |
