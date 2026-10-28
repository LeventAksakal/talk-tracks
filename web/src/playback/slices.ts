// The one clock everything lines up on: the speaker's media time, in ms. Every sliced agent track cuts
// group k as media time [k·S, (k+1)·S) (decision 0012, design §4.1), so a seek is arithmetic.

export const SLICE_MS = 4_000;

/** The slice (group) that holds media time `ms`. */
export function sliceOf(ms: number): number {
  return Math.max(0, Math.floor(ms / SLICE_MS));
}

export function sliceStart(slice: number): number {
  return slice * SLICE_MS;
}

export function sliceEnd(slice: number): number {
  return (slice + 1) * SLICE_MS;
}

/** A half-open range of media time, [start, end) in ms. */
export interface Range {
  start: number;
  end: number;
}

/** Sort and join overlapping or touching ranges; empty ones are dropped. */
export function mergeRanges(ranges: Iterable<Range>): Range[] {
  const sorted = [...ranges].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Ranges covered by a set of slice numbers. */
export function slicesToRanges(slices: Iterable<number>): Range[] {
  return mergeRanges([...slices].map((k) => ({ start: sliceStart(k), end: sliceEnd(k) })));
}

export function inRanges(ranges: readonly Range[], ms: number): boolean {
  return ranges.some((r) => ms >= r.start && ms < r.end);
}
