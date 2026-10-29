// The one clock everything lines up on: room time, in ms. Every sliced agent track cuts group k as room
// time [k·S, (k+1)·S) (decision 0012, design §4.1), so a seek is arithmetic.

import { SLICE_MS, sliceOf } from "../contracts/types";

export { SLICE_MS, sliceOf };

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
