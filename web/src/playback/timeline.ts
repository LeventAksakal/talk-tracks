// The timeline a viewer scrubs: where the playhead is, where live is, what can be played, and what the
// viewer skipped when they come back to live ("what you missed", design §5.6).

import type { Chapter } from "../contracts/types";
import type { Mode } from "./aiTracks";
import type { MediaStatus } from "./media";
import { mergeRanges, type Range } from "./slices";
import type { LineItem, Outline } from "./wire";

export interface TimelineView {
  mode: Mode;
  /** The playhead, media ms (live: the live position, when known). */
  position: number | undefined;
  /** The live edge, media ms. */
  liveEdge: number | undefined;
  /** The earliest media time to seek to. */
  start: number;
  /** How far the playhead trails live, ms (0 when live). */
  behindMs: number;
  /** Archived speaker media. */
  available: Range[];
  /** Media the element holds. */
  buffered: Range[];
  /** AI-track slices held, across opted-in tracks. */
  held: Range[];
  mediaStatus: MediaStatus;
}

export interface Missed {
  fromMs: number;
  toMs: number;
  reason: "rewound" | "away";
  /** Chapters that started in the skipped range, from the newest outline (no API call). */
  chapters: Chapter[];
  /** Whether the outline track is on; without it the chapters are unknown. */
  outlineOn: boolean;
  /** Caption lines over the range, once loaded on request (one FETCH per slice). */
  transcript: LineItem[] | undefined;
  transcriptLoading: boolean;
}

/** Skipped less than this, there is nothing worth telling. */
export const MISSED_MIN_MS = 20_000;

export function chaptersIn(outline: Outline | undefined, fromMs: number, toMs: number): Chapter[] {
  return (outline?.chapters ?? []).filter((c) => c.start_ms >= fromMs && c.start_ms < toMs);
}

export function buildTimeline(input: {
  mode: Mode;
  position: number | undefined;
  liveEdge: number | undefined;
  available: Range[];
  buffered: Range[];
  held: Range[][];
  mediaStatus: MediaStatus;
}): TimelineView {
  const held = mergeRanges(input.held.flat());
  const starts = [input.available[0]?.start, held[0]?.start].filter((x): x is number => x !== undefined);
  const start = starts.length > 0 ? Math.min(...starts) : 0;
  const behindMs =
    input.mode === "live" || input.position === undefined || input.liveEdge === undefined
      ? 0
      : Math.max(0, input.liveEdge - input.position);
  return {
    mode: input.mode,
    position: input.position,
    liveEdge: input.liveEdge,
    start,
    behindMs,
    available: input.available,
    buffered: input.buffered,
    held,
    mediaStatus: input.mediaStatus,
  };
}

/** "m:ss" or "h:mm:ss" for a media time. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
