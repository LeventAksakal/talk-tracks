// Drawing the slide's annotations (decisions 0020, 0021): where a text mark sits from the slide's text runs, and
// the ink drawer (canvas/ink.ts, shared with the console), a pure function of (context, elements, size) that takes
// an OffscreenCanvas context too, so it can move into a worker if profiling ever asks for it.

import type { Region, TextRange, TextRun } from "../contracts/types";

/**
 * The boxes a text range covers, in fractions of the slide: one per run span, a part of a run placed by character
 * count across its box (container-formats §3), and neighbours on the same line joined so an underline across
 * words is one line. Spans naming a run the slide does not have are skipped.
 */
export function markBoxes(span: TextRange, runs: readonly TextRun[]): Region[] {
  const boxes: Region[] = [];
  for (const s of span) {
    const run = runs.find((r) => r.id === s.run);
    if (!run) continue;
    const len = Math.max(1, run.text.length);
    const start = Math.min(len, Math.max(0, s.start ?? 0));
    const end = Math.min(len, Math.max(start, s.end ?? len));
    if (end <= start) continue;
    const { x, y, w, h } = run.box;
    boxes.push({ x: x + (w * start) / len, y, w: (w * (end - start)) / len, h });
  }
  const out: Region[] = [];
  for (const b of boxes) {
    const last = out.at(-1);
    const sameLine = last && Math.abs(last.y + last.h / 2 - (b.y + b.h / 2)) < Math.min(last.h, b.h) / 2;
    const gap = last ? b.x - (last.x + last.w) : Infinity;
    if (last && sameLine && gap >= -0.001 && gap < Math.max(last.h, b.h)) {
      const top = Math.min(last.y, b.y);
      last.h = Math.max(last.y + last.h, b.y + b.h) - top;
      last.y = top;
      last.w = b.x + b.w - last.x;
    } else out.push({ ...b });
  }
  return out;
}

/** Draw the ink track's strokes and shapes, clearing the canvas first (the shared drawer, canvas/ink.ts). */
export { drawElements as drawInk, inkSignature } from "../canvas/ink";
