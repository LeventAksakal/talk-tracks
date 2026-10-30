// Progress-bar geometry (ui-design §4.3, §4.5): YouTube-style chapter segments over the scrubbable span,
// the chapter at a time, and the holes where nobody broadcast.

import type { Chapter } from "../contracts/types";
import type { Range } from "../playback/slices";

export interface Segment {
  start: number;
  end: number;
  /** The chapter this stretch belongs to; undefined before the first chapter or with none. */
  chapter: Chapter | undefined;
}

/**
 * One segment per chapter over [from, to]: each runs to the next chapter's start, the last one open to `to`
 * (it grows live). The stretch before the first chapter is a segment of its own. No chapters: one segment.
 */
export function chapterSegments(chapters: readonly Chapter[], from: number, to: number): Segment[] {
  if (to <= from) return [];
  const sorted = [...chapters].sort((a, b) => a.start_ms - b.start_ms);
  const out: Segment[] = [];
  let cursor = from;
  let current: Chapter | undefined = sorted.filter((c) => c.start_ms <= from).at(-1);
  for (const c of sorted) {
    if (c.start_ms <= from) continue;
    if (c.start_ms >= to) break;
    out.push({ start: cursor, end: c.start_ms, chapter: current });
    cursor = c.start_ms;
    current = c;
  }
  out.push({ start: cursor, end: to, chapter: current });
  return out.filter((s) => s.end - s.start > 0);
}

/** The chapter playing at `t`: the last one that started by then. */
export function chapterAt(chapters: readonly Chapter[], t: number | undefined): Chapter | undefined {
  if (t === undefined) return undefined;
  let found: Chapter | undefined;
  for (const c of chapters) if (c.start_ms <= t && (!found || c.start_ms >= found.start_ms)) found = c;
  return found;
}

/**
 * Holes between archived ranges within [from, to] (nobody broadcast); none when nothing is archived. The
 * stretch after the last range is the archive trailing live, not a hole.
 */
export function holesIn(available: readonly Range[], from: number, to: number): Range[] {
  if (available.length === 0 || to <= from) return [];
  const out: Range[] = [];
  let cursor = from;
  for (const r of [...available].sort((a, b) => a.start - b.start)) {
    if (r.end <= cursor) continue;
    if (r.start >= to) break;
    if (r.start > cursor) out.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  return out.filter((h) => h.end - h.start >= 1_000);
}

/** "−4:30" for how far behind live. */
export function formatBehind(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `−${m}:${String(s).padStart(2, "0")}`;
}
