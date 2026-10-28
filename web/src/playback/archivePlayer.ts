// Plays the archived speaker media from any media time with Media Source Extensions: one SourceBuffer
// per archived track, the init segment, then the media segments around the playhead. Segment times are
// the speaker's media clock, so element.currentTime * 1000 is the media time the AI slices use.

import { type ArchiveClient, type ArchiveTrack, archivedRanges, type RunIndex, segmentAt } from "./archive";
import { mergeRanges, type Range } from "./slices";

export interface ArchivePlayerOptions {
  /** Media buffered ahead of the playhead, ms. */
  aheadMs?: number;
  /** Media kept behind the playhead, ms. */
  behindMs?: number;
  /** How often a growing run's index is read again, ms. */
  refreshMs?: number;
  now?: () => number;
}

interface Lane {
  track: ArchiveTrack;
  buffer: SourceBuffer;
  /** The init segment appended last. */
  init: string | undefined;
  /** Segment numbers appended and not evicted. */
  appended: Map<number, Range>;
  busy: boolean;
}

/** Tracks the browser can play, and the MIME type to ask for. */
export function playableTracks(run: RunIndex, isTypeSupported: (mime: string) => boolean): ArchiveTrack[] {
  return run.tracks.filter((t) => t.segments.length > 0 && isTypeSupported(t.mime));
}

/**
 * An archive playback on one media element. Open it at a media time; it appends what the playhead
 * needs, evicts what it left behind, re-reads a growing run's index, and steps over gaps.
 */
export class ArchivePlayer {
  readonly element: HTMLMediaElement;
  #client: ArchiveClient;
  #run: RunIndex;
  #aheadMs: number;
  #behindMs: number;
  #refreshMs: number;
  #now: () => number;
  #source: MediaSource;
  #url: string;
  #lanes: Lane[] = [];
  #abort = new AbortController();
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastRefresh = 0;
  #listeners = new Set<() => void>();
  #error: string | undefined;
  #closed = false;

  constructor(element: HTMLMediaElement, client: ArchiveClient, run: RunIndex, options: ArchivePlayerOptions = {}) {
    this.element = element;
    this.#client = client;
    this.#run = run;
    this.#aheadMs = options.aheadMs ?? 30_000;
    this.#behindMs = options.behindMs ?? 60_000;
    this.#refreshMs = options.refreshMs ?? 3_000;
    this.#now = options.now ?? Date.now;
    this.#source = new MediaSource();
    this.#url = URL.createObjectURL(this.#source);
    element.src = this.#url;
  }

  /** Start at media time `ms`. Resolves once the source is open; playback starts when data arrives. */
  async open(ms: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (this.#source.readyState === "open") return resolve();
      this.#source.addEventListener("sourceopen", () => resolve(), { once: true });
      this.#abort.signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
    });
    const tracks = playableTracks(this.#run, (m) => MediaSource.isTypeSupported(m));
    if (tracks.length === 0) throw new Error("this browser cannot play the archived media");
    this.#lanes = tracks.map((track) => ({
      track,
      buffer: this.#source.addSourceBuffer(track.mime),
      init: undefined,
      appended: new Map(),
      busy: false,
    }));
    this.element.addEventListener("timeupdate", this.#onTime);
    this.element.addEventListener("waiting", this.#onTime);
    this.#timer = setInterval(this.#onTime, 500);
    this.seek(ms);
  }

  get run(): RunIndex {
    return this.#run;
  }

  get error(): string | undefined {
    return this.#error;
  }

  /** The playhead, media ms. */
  position(): number {
    return this.element.currentTime * 1000;
  }

  /** What the element has buffered, media ms. */
  buffered(): Range[] {
    const b = this.element.buffered;
    const out: Range[] = [];
    for (let i = 0; i < b.length; i++) out.push({ start: b.start(i) * 1000, end: b.end(i) * 1000 });
    return mergeRanges(out);
  }

  /** What the archive holds, media ms. */
  available(): Range[] {
    return archivedRanges(this.#run);
  }

  seek(ms: number): void {
    const first = this.available()[0];
    const target = first && ms < first.start ? first.start : ms;
    this.element.currentTime = target / 1000;
    void this.#fill();
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    clearInterval(this.#timer);
    this.element.removeEventListener("timeupdate", this.#onTime);
    this.element.removeEventListener("waiting", this.#onTime);
    this.element.pause();
    this.element.removeAttribute("src");
    this.element.load();
    URL.revokeObjectURL(this.#url);
    this.#listeners.clear();
  }

  #onTime = () => {
    if (this.#closed) return;
    this.#skipGap();
    void this.#fill();
    for (const fn of [...this.#listeners]) fn();
  };

  /** Stalled at the end of a buffered range with the next one ahead (a gap in the archive): jump. */
  #skipGap(): void {
    const pos = this.position();
    const ranges = this.buffered();
    if (ranges.some((r) => pos >= r.start && pos < r.end - 100)) return;
    const next = ranges.find((r) => r.start > pos && r.start - pos < 60_000);
    if (next) this.element.currentTime = next.start / 1000 + 0.01;
  }

  async #fill(): Promise<void> {
    const pos = this.position();
    let needMore = false;
    for (const lane of this.#lanes) {
      if (lane.busy) continue;
      lane.busy = true;
      try {
        needMore = (await this.#fillLane(lane, pos)) || needMore;
      } catch (e) {
        if (this.#abort.signal.aborted) return;
        this.#error = e instanceof Error ? e.message : String(e);
        console.warn("archive playback", e);
      } finally {
        lane.busy = false;
      }
    }
    if (needMore && this.#now() - this.#lastRefresh > this.#refreshMs) await this.#refresh();
  }

  /** Append the next segment the playhead needs, evict what it left behind. True when the index ran out. */
  async #fillLane(lane: Lane, pos: number): Promise<boolean> {
    const segments = lane.track.segments;
    // Evict far behind the playhead, and far ahead of it after a seek back.
    const evictTo = pos - this.#behindMs;
    if (evictTo > 0 && [...lane.appended.values()].some((r) => r.end <= evictTo)) {
      await this.#update(lane.buffer, () => lane.buffer.remove(0, evictTo / 1000));
      for (const [n, r] of lane.appended) if (r.end <= evictTo) lane.appended.delete(n);
    }
    const evictFrom = pos + 2 * this.#aheadMs;
    if ([...lane.appended.values()].some((r) => r.start >= evictFrom)) {
      await this.#update(lane.buffer, () => lane.buffer.remove(evictFrom / 1000, Infinity));
      for (const [n, r] of lane.appended) if (r.start >= evictFrom) lane.appended.delete(n);
    }
    for (let i = segmentAt(segments, pos); i >= 0 && i < segments.length; i++) {
      const s = segments[i]!;
      if (s.start_ms > pos + this.#aheadMs) return false;
      if (lane.appended.has(s.n)) continue;
      if (lane.init !== s.init) {
        const init = await this.#client.bytes(this.#client.initUrl(this.#run, lane.track, s), this.#abort.signal);
        await this.#update(lane.buffer, () => lane.buffer.appendBuffer(init));
        lane.init = s.init;
      }
      const data = await this.#client.bytes(this.#client.segmentUrl(this.#run, lane.track, s), this.#abort.signal);
      await this.#update(lane.buffer, () => lane.buffer.appendBuffer(data));
      lane.appended.set(s.n, { start: s.start_ms, end: s.end_ms });
      // One segment per call: the playhead may have moved meanwhile.
      return false;
    }
    return true;
  }

  async #refresh(): Promise<void> {
    this.#lastRefresh = this.#now();
    try {
      const run = await this.#client.run(this.#run.room, this.#run.run, this.#abort.signal);
      this.#run = run;
      for (const lane of this.#lanes) {
        const t = run.tracks.find((x) => x.track === lane.track.track);
        if (t) lane.track = t;
      }
      for (const fn of [...this.#listeners]) fn();
    } catch (e) {
      if (!this.#abort.signal.aborted) console.warn("archive index refresh", e);
    }
  }

  #update(buffer: SourceBuffer, op: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.#closed) return reject(new Error("closed"));
      const done = () => {
        buffer.removeEventListener("updateend", done);
        buffer.removeEventListener("error", fail);
        resolve();
      };
      const fail = () => {
        buffer.removeEventListener("updateend", done);
        buffer.removeEventListener("error", fail);
        reject(new Error("SourceBuffer error"));
      };
      buffer.addEventListener("updateend", done);
      buffer.addEventListener("error", fail);
      op();
    });
  }
}
