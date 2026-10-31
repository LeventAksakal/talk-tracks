// Where a point falls on a slide's text and ink (decision 0021), shared by the speaker's console and the player's
// listener tools: text hit tests and ranges on the slide's TextRuns, and what an eraser touches. Positions are
// fractions of the slide; a part of a run is placed by character count across its box (container-formats §3).

import type { StrokeRecord, TextMarkRecord } from "../contracts/tracks";
import type { Point, Region, TextRange, TextRun } from "../contracts/types";

/** The box of characters [start, end) of a run, placed by character count. */
export function spanBox(run: TextRun, start = 0, end?: number | null): Region {
  const n = Math.max(1, run.text.length);
  const s = Math.min(n, Math.max(0, start));
  const e = Math.min(n, Math.max(s, end ?? n));
  return { x: run.box.x + (run.box.w * s) / n, y: run.box.y, w: (run.box.w * (e - s)) / n, h: run.box.h };
}

/** How far past either end of a line a drag may start or finish and still select up to that end. */
export const DRAG_REACH = 0.2;

/**
 * Where a point falls in the text: the run and the character boundary nearest to it. `slack` is how
 * far off a line, above or below, still counts; `reach` how far before or after it.
 */
export function hitText(
  runs: readonly TextRun[],
  [x, y]: Point,
  slack = 0.01,
  reach = slack,
): { run: number; char: number } | null {
  let best: { run: number; char: number } | null = null;
  let bestD = Infinity;
  for (const [i, r] of runs.entries()) {
    const { x: rx, y: ry, w, h } = r.box;
    const dx = x < rx ? rx - x : x > rx + w ? x - rx - w : 0;
    const dy = y < ry ? ry - y : y > ry + h ? y - ry - h : 0;
    const d = Math.hypot(dx, dy);
    if (dx > reach || dy > slack || d >= bestD) continue;
    const char = w > 0 ? Math.round(Math.min(1, Math.max(0, (x - rx) / w)) * r.text.length) : 0;
    best = { run: i, char };
    bestD = d;
  }
  return best;
}

/**
 * The text range a drag selects, from where it started to where it ended, in reading order: the
 * rest of the first run, the whole runs between, the start of the last run. A drag may run past
 * either end of a line (people overshoot); a click must land on a word. Null when it selects no
 * character, or did not start or end on a line of text.
 */
export function rangeBetween(runs: readonly TextRun[], from: Point, to: Point): TextRange | null {
  const click = from[0] === to[0] && from[1] === to[1];
  const reach = click ? undefined : DRAG_REACH;
  const a = hitText(runs, from, undefined, reach);
  const b = hitText(runs, to, undefined, reach);
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

/** Distance from p to the segment ab, in slide fractions scaled by the aspect (x by `aspect`). */
function segmentDistance(p: Point, a: Point, b: Point, aspect: number): number {
  const [px, py] = [p[0] * aspect, p[1]];
  const [ax, ay] = [a[0] * aspect, a[1]];
  const [bx, by] = [b[0] * aspect, b[1]];
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Strokes within `radius` (a fraction of the slide's height) of p. */
export function strokesAt(strokes: readonly StrokeRecord[], p: Point, aspect: number, radius = 0.015): string[] {
  return strokes
    .filter(({ data: s }) => {
      const reach = radius + (s.width * aspect) / 2;
      const pts = s.points;
      if (pts.length === 1) return segmentDistance(p, pts[0]!, pts[0]!, aspect) <= reach;
      for (let i = 1; i < pts.length; i++) if (segmentDistance(p, pts[i - 1]!, pts[i]!, aspect) <= reach) return true;
      return false;
    })
    .map((s) => s.data.stroke);
}

/** Marks whose text boxes contain p. */
export function marksAt(marks: readonly TextMarkRecord[], runs: readonly TextRun[], [x, y]: Point): string[] {
  return marks
    .filter((k) => rangeBoxes(runs, k.data.span).some((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h))
    .map((k) => k.data.id);
}
