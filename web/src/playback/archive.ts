// The speaker's media history, read over HTTP from the room archive (decision 0012 keeps 0007 for media;
// format in wiki/howto/archive.md). Segments are fMP4 with a µs timescale on the speaker's media clock,
// so a media element's currentTime in seconds is media ms / 1000, the clock the AI slices use.

import { mergeRanges, type Range } from "./slices";

export interface ArchiveSegment {
  n: number;
  /** The init segment to append before this one (changes only when the codec setup does). */
  init: string;
  start_ms: number;
  /** Exclusive. Equal to the next segment's start, except across a gap. */
  end_ms: number;
  samples?: number;
  bytes?: number;
}

export interface ArchiveTrack {
  track: string;
  kind: "audio" | "video";
  codec: string;
  /** For MediaSource.isTypeSupported and addSourceBuffer. */
  mime: string;
  segments: ArchiveSegment[];
}

export interface RunSummary {
  run: string;
  started_wall_ms: number;
  last_wall_ms: number;
  media_first_ms: number;
  media_last_ms: number;
}

export interface RoomIndex {
  room: string;
  /** Oldest first; the last one is the current talk, still growing if the room is live. */
  runs: RunSummary[];
}

export interface RunIndex extends RunSummary {
  room: string;
  media_last_wall_ms?: number;
  tracks: ArchiveTrack[];
}

export class ArchiveClient {
  readonly base: string;
  #fetch: typeof fetch;

  constructor(base = "/archive", fetchFn: typeof fetch = (...a) => fetch(...a)) {
    this.base = base.replace(/\/$/, "");
    this.#fetch = fetchFn;
  }

  /** The room's runs, or undefined when nothing of it is archived. */
  async room(room: string, signal?: AbortSignal): Promise<RoomIndex | undefined> {
    const res = await this.#fetch(`${this.base}/${room}/room.json`, { signal, cache: "no-cache" });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`room index: HTTP ${res.status}`);
    return (await res.json()) as RoomIndex;
  }

  async run(room: string, run: string, signal?: AbortSignal): Promise<RunIndex> {
    const res = await this.#fetch(`${this.base}/${room}/${run}/run.json`, { signal, cache: "no-cache" });
    if (!res.ok) throw new Error(`run index: HTTP ${res.status}`);
    return (await res.json()) as RunIndex;
  }

  /** The newest run, the one a seek in the current talk uses. */
  async currentRun(room: string, signal?: AbortSignal): Promise<RunIndex | undefined> {
    const index = await this.room(room, signal);
    const last = index?.runs.at(-1);
    return last ? this.run(room, last.run, signal) : undefined;
  }

  initUrl(run: RunIndex, track: ArchiveTrack, segment: ArchiveSegment): string {
    return `${this.base}/${run.room}/${run.run}/teacher/${track.track}/${segment.init}`;
  }

  segmentUrl(run: RunIndex, track: ArchiveTrack, segment: ArchiveSegment): string {
    return `${this.base}/${run.room}/${run.run}/teacher/${track.track}/${String(segment.n).padStart(6, "0")}.m4s`;
  }

  async bytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const res = await this.#fetch(url, { signal });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.arrayBuffer();
  }
}

/**
 * The index of the segment to play media time `ms` from: the one that holds it, or across a gap the
 * next one. -1 when `ms` is past the last segment.
 */
export function segmentAt(segments: readonly ArchiveSegment[], ms: number): number {
  let lo = 0;
  let hi = segments.length;
  // The first segment that ends after ms.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid]!.end_ms <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo < segments.length ? lo : -1;
}

/** Media time the archive can play: every track's segments joined, intersected across tracks. */
export function archivedRanges(run: RunIndex): Range[] {
  const tracks = run.tracks.filter((t) => t.segments.length > 0);
  if (tracks.length === 0) return [];
  const per = tracks.map((t) => mergeRanges(t.segments.map((s) => ({ start: s.start_ms, end: s.end_ms }))));
  return per.reduce(intersect);
}

function intersect(a: Range[], b: Range[]): Range[] {
  const out: Range[] = [];
  for (const x of a)
    for (const y of b) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) out.push({ start, end });
    }
  return mergeRanges(out);
}
