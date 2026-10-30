// A slide's text layer as TextRuns (decision 0021): PDF.js `page.getTextContent()` items placed on
// the rendered page, each run's box in fractions of the slide. Text marks address these runs
// ("underline slide 13, run t23"); a part of a run is placed by character count across its box.

import type { Point, Region, TextRange, TextRun } from "../contracts/types";

/** The fields of a PDF.js TextItem the layout needs. */
export interface PdfTextItem {
  str: string;
  /** Text space to PDF user space, [a, b, c, d, e, f]. */
  transform: number[];
  /** Advance width in PDF user space. */
  width: number;
}

/** The fields of a PDF.js PageViewport the layout needs. */
export interface PdfViewport {
  width: number;
  height: number;
  scale: number;
  /** PDF user space to viewport pixels. */
  transform: number[];
}

/** Share of the font size above the baseline (PDF.js's text layer default). */
const ASCENT = 0.8;

/** PDF.js Util.transform: m1 · m2 for 2D affine matrices [a, b, c, d, e, f]. */
export function multiply(m1: readonly number[], m2: readonly number[]): number[] {
  const [a1 = 1, b1 = 0, c1 = 0, d1 = 1, e1 = 0, f1 = 0] = m1;
  const [a2 = 1, b2 = 0, c2 = 0, d2 = 1, e2 = 0, f2 = 0] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000;

/**
 * The runs of a page in reading order (content order), ids t0, t1, … in that order. Whitespace-only
 * and zero-width items are skipped; so is rotated text, which a horizontal box cannot place.
 */
export function textRuns(items: readonly PdfTextItem[], viewport: PdfViewport): TextRun[] {
  const runs: TextRun[] = [];
  for (const item of items) {
    if (!item.str.trim() || item.width <= 0) continue;
    const [a = 0, b = 0, c = 0, d = 0, x = 0, baseline = 0] = multiply(viewport.transform, item.transform);
    if (Math.abs(b) > 1e-6 * Math.abs(a) || a <= 0) continue;
    const size = Math.hypot(c, d);
    const width = item.width * viewport.scale;
    if (size <= 0 || width <= 0) continue;
    const box: Region = {
      x: clamp(x / viewport.width),
      y: clamp((baseline - size * ASCENT) / viewport.height),
      w: clamp(width / viewport.width),
      h: clamp(size / viewport.height),
    };
    runs.push({ id: `t${runs.length}`, text: item.str, box });
  }
  return runs;
}

/** The box of characters [start, end) of a run, placed by character count. */
export function spanBox(run: TextRun, start = 0, end?: number | null): Region {
  const n = Math.max(1, run.text.length);
  const s = Math.min(n, Math.max(0, start));
  const e = Math.min(n, Math.max(s, end ?? n));
  return { x: run.box.x + (run.box.w * s) / n, y: run.box.y, w: (run.box.w * (e - s)) / n, h: run.box.h };
}

/** Where a point falls in the text: the run and the character boundary nearest to it. */
export function hitText(runs: readonly TextRun[], [x, y]: Point, slack = 0.01): { run: number; char: number } | null {
  let best: { run: number; char: number } | null = null;
  let bestD = Infinity;
  for (const [i, r] of runs.entries()) {
    const { x: rx, y: ry, w, h } = r.box;
    const dx = x < rx ? rx - x : x > rx + w ? x - rx - w : 0;
    const dy = y < ry ? ry - y : y > ry + h ? y - ry - h : 0;
    const d = Math.hypot(dx, dy);
    if (dx > slack || dy > slack || d >= bestD) continue;
    const char = w > 0 ? Math.round(Math.min(1, Math.max(0, (x - rx) / w)) * r.text.length) : 0;
    best = { run: i, char };
    bestD = d;
  }
  return best;
}

/**
 * The text range a drag selects, from where it started to where it ended, in reading order: the
 * rest of the first run, the whole runs between, the start of the last run. Null when it selects
 * no character, or did not start or end on text.
 */
export function rangeBetween(runs: readonly TextRun[], from: Point, to: Point): TextRange | null {
  const a = hitText(runs, from);
  const b = hitText(runs, to);
  if (!a || !b) return null;
  let [first, last] = a.run < b.run || (a.run === b.run && a.char <= b.char) ? [a, b] : [b, a];
  if (first.run === last.run && first.char === last.char) {
    // A click on a word: mark that word.
    const text = runs[first.run]!.text;
    const left = text.lastIndexOf(" ", Math.max(0, first.char - 1)) + 1;
    const right = text.indexOf(" ", first.char);
    first = { run: first.run, char: left };
    last = { run: first.run, char: right < 0 ? text.length : right };
    if (first.char === last.char) return null;
  }
  const range: TextRange = [];
  for (let i = first.run; i <= last.run; i++) {
    const run = runs[i]!;
    const start = i === first.run ? first.char : 0;
    const end = i === last.run ? last.char : run.text.length;
    if (end <= start) continue;
    range.push({
      run: run.id,
      ...(start > 0 ? { start } : {}),
      ...(end < run.text.length ? { end } : {}),
    });
  }
  return range.length ? range : null;
}

/** The boxes a text range covers on the slide, one per run span. */
export function rangeBoxes(runs: readonly TextRun[], range: TextRange): Region[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  return range.flatMap((s) => {
    const run = byId.get(s.run);
    return run ? [spanBox(run, s.start ?? 0, s.end)] : [];
  });
}
