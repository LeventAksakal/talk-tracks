// The AI tracks of one room as a viewer plays them: one live SUBSCRIBE per opted-in track, and FETCHes
// of the slices around the playhead while rewound (decision 0012, design §5.1, §5.2, §5.5).

import type { Closable } from "../transport/types";
import { SliceLog, type SlicedView } from "./sliceLog";
import { DEFAULT_LATENESS_MS } from "./roomCatalog";
import { type Range, sliceEnd, sliceOf } from "./slices";
import { type HistorySource, NotFound } from "./source";
import {
  type AgentMeta,
  agentPath,
  agentsPrefix,
  type Item,
  type LineItem,
  type Outline,
  parseAgentPath,
  parseObject,
  PRIORITY,
  type TrackKind,
  type TrackRef,
  tracksOf,
} from "./wire";

export type Mode = "live" | "rewound";

export interface TrackView {
  /** `<agent>/<track>`: unique in a room. */
  id: string;
  agent: string;
  track: string;
  kind: TrackKind | undefined;
  lang: string | undefined;
  label: string;
  model: string | undefined;
  costUsd: number;
  requests: number;
  /** The agent's broadcast is announced. */
  announced: boolean;
  /** This viewer opted in: one live subscription is open. */
  enabled: boolean;
  /** A sliced track at the playhead (or everything held, live). */
  sliced: SlicedView | undefined;
  /** The newest outline: always the latest snapshot, live or rewound (design §4.3). */
  outline: Outline | undefined;
  /** Media ranges this viewer holds for the track. */
  held: Range[];
  /** A slice the playhead needs is being fetched. */
  loading: boolean;
  /** Wall time of the last live object. */
  lastLiveAt: number | undefined;
  /** Live, the newest group is older than the slice the speaker media is in: no live output yet (§5.1). */
  stale: boolean;
}

export interface AiTracksView {
  mode: Mode;
  /** The playhead, media ms, while rewound. */
  position: number | undefined;
  /** The newest live slice's end across tracks, media ms. */
  liveEdgeMs: number | undefined;
  tracks: readonly TrackView[];
}

export interface AiTracksOptions {
  now?: () => number;
  /**
   * L for a track, ms: the most it publishes after an item's room time (catalog `tt.latenessMs`). Seeking
   * to t fetches slices ⌊t/S⌋−1 … ⌊(t+L)/S⌋ (design §5.5).
   */
  latenessMs?: (path: string, track: string) => number;
  /** Slices fetched behind the live edge when a track is switched on live, for scrollback. 0: none. */
  liveBack?: number;
  /** FETCHes in flight at once, across tracks (design §5.11: 2 for Safari on WebSocket). */
  maxInFlight?: number;
  /** Slices kept per track; the farthest from the playhead go first. */
  maxSlices?: number;
  /** A slice that was not found is asked for again after this long, if still wanted. */
  retryMissingMs?: number;
  /**
   * A FETCH that has not answered by then is a hole, like not found. moq-relay 0.17.8 never completes a
   * FETCH of the slice in which its upstream subscription began (wiki/benchmark.md).
   */
  fetchTimeoutMs?: number;
}

interface Entry {
  ref: TrackRef;
  id: string;
  path: string;
  announced: boolean;
  enabled: boolean;
  subscription: Closable | undefined;
  log: SliceLog;
  outline: { group: number; outline: Outline } | undefined;
  meta: AgentMeta | undefined;
  lastLiveAt: number | undefined;
  /** The first slice the open subscription delivered: it and every later slice come live, never by FETCH. */
  firstLive: number | undefined;
  /** Slices that were not found, with when. */
  missing: Map<number, number>;
}

interface Job {
  entry: Entry;
  slice: number;
  /** Where the result goes; the playback log unless this is a transcript load. */
  into: SliceLog;
  controller: AbortController;
  running: boolean;
  resolve: () => void;
}

export class AiTracks {
  readonly room: string;
  #source: HistorySource;
  #now: () => number;
  #lateness: (path: string, track: string) => number;
  #liveBack: number;
  #maxInFlight: number;
  #maxSlices: number;
  #retryMissing: number;
  #fetchTimeout: number;
  #entries = new Map<string, Entry>();
  #announce: Closable;
  #mode: Mode = "live";
  #position: number | undefined;
  /** A live edge known from elsewhere (the media), media ms. */
  #externalEdge: number | undefined;
  #queue: Job[] = [];
  #listeners = new Set<() => void>();
  #view: AiTracksView | undefined;
  #notifyQueued = false;
  #closed = false;

  constructor(source: HistorySource, room: string, options: AiTracksOptions = {}) {
    this.room = room;
    this.#source = source;
    this.#now = options.now ?? Date.now;
    this.#lateness = options.latenessMs ?? (() => DEFAULT_LATENESS_MS);
    this.#liveBack = options.liveBack ?? 3;
    this.#maxInFlight = options.maxInFlight ?? 2;
    this.#maxSlices = options.maxSlices ?? 90;
    this.#retryMissing = options.retryMissingMs ?? 15_000;
    this.#fetchTimeout = options.fetchTimeoutMs ?? 2_000;
    this.#announce = source.announced(agentsPrefix(room), ({ path, active }) => {
      const agent = parseAgentPath(path);
      if (agent) this.#onAnnounce(agent, active);
    });
  }

  // --- React glue ----------------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): AiTracksView => (this.#view ??= this.#buildView());

  // --- commands ------------------------------------------------------------------------------------

  /** Opt into a track (one live SUBSCRIBE) or out of it (the subscription is closed on the wire). */
  setEnabled(id: string, enabled: boolean): void {
    const entry = this.#entries.get(id);
    if (!entry || entry.enabled === enabled) return;
    entry.enabled = enabled;
    if (!enabled) {
      for (const job of this.#queue.filter((j) => j.entry === entry)) this.#cancel(job);
      entry.log.clear();
      entry.outline = undefined;
      entry.missing.clear();
    }
    this.#syncSubscription(entry);
    this.#plan();
    this.#changed();
  }

  /** Rewind to media time `ms`: fetch the slices around it for every opted-in track. */
  seek(ms: number): void {
    this.#mode = "rewound";
    this.#position = Math.max(0, ms);
    this.#plan();
    this.#changed();
  }

  /** The playhead moved while rewound (the media is playing). */
  setPosition(ms: number): void {
    if (this.#mode !== "rewound") return;
    const before = this.#position === undefined ? undefined : sliceOf(this.#position);
    this.#position = Math.max(0, ms);
    if (sliceOf(this.#position) !== before) this.#plan();
    this.#changed();
  }

  /** Back to the live edge: fetched state is dropped, the live subscriptions carry on. */
  goLive(): void {
    this.#mode = "live";
    this.#position = undefined;
    for (const job of [...this.#queue]) if (job.into === job.entry.log) this.#cancel(job);
    for (const entry of this.#entries.values()) entry.log.dropFetched();
    this.#plan();
    this.#changed();
  }

  /** Tell the tracks where the live edge is when the media knows better (media ms). */
  setLiveEdge(ms: number | undefined): void {
    if (ms === this.#externalEdge) return;
    this.#externalEdge = ms;
    this.#changed();
  }

  /**
   * The lines of a track over [fromMs, toMs), fetched slice by slice into a separate log so the
   * playback state is untouched ("what you missed", design §5.6). At most `maxSlices` slices, the
   * newest ones.
   */
  async transcript(id: string, fromMs: number, toMs: number, maxSlices = 75): Promise<LineItem[]> {
    const entry = this.#entries.get(id);
    if (!entry || !entry.ref.sliced || toMs <= fromMs) return [];
    const into = new SliceLog();
    const first = Math.max(sliceOf(fromMs), sliceOf(toMs - 1) - maxSlices + 1);
    const done: Promise<void>[] = [];
    const limit = this.#fetchLimit(entry, this.#edgeSlice());
    for (let k = first; k <= sliceOf(toMs - 1); k++) {
      const held = entry.log.get(k);
      if (held) into.addFetched(k, held.carry ? { items: held.carry, capped: held.capped } : undefined, held.items);
      else if (limit !== undefined && k < limit) done.push(this.#enqueue(entry, k, into));
    }
    this.#pump();
    await Promise.all(done);
    return into.view(undefined).lines.filter((l) => l.startMs >= fromMs && l.startMs < toMs);
  }

  close(): void {
    this.#closed = true;
    this.#announce.close();
    for (const job of [...this.#queue]) this.#cancel(job);
    for (const entry of this.#entries.values()) entry.subscription?.close();
    this.#listeners.clear();
  }

  // --- announcements and subscriptions -------------------------------------------------------------

  #onAnnounce(agent: string, active: boolean): void {
    for (const ref of tracksOf(agent)) {
      const id = `${agent}/${ref.track}`;
      let entry = this.#entries.get(id);
      if (!entry) {
        entry = {
          ref,
          id,
          path: agentPath(this.room, agent),
          announced: false,
          enabled: false, // nothing until chosen (decision 0010)
          subscription: undefined,
          log: new SliceLog(),
          outline: undefined,
          meta: undefined,
          lastLiveAt: undefined,
          firstLive: undefined,
          missing: new Map(),
        };
        this.#entries.set(id, entry);
      }
      entry.announced = active;
    }
    this.#changed();
  }

  /** One subscription per opted-in track, opened once and never updated (design §5.2). */
  #syncSubscription(entry: Entry): void {
    if (entry.enabled && !entry.subscription) {
      const priority = PRIORITY[entry.ref.kind ?? "unknown"];
      entry.subscription = this.#source.subscribe(
        entry.path,
        entry.ref.track,
        ({ group, payload }) => this.#onLive(entry, group, payload),
        { priority },
      );
    } else if (!entry.enabled && entry.subscription) {
      entry.subscription.close();
      entry.subscription = undefined;
      entry.firstLive = undefined;
    }
  }

  #onLive(entry: Entry, group: number, payload: Uint8Array): void {
    if (!entry.enabled) return;
    const parsed = parseObject(payload);
    if (!parsed.ok) {
      console.warn(
        `dropping an object from ${entry.path}/${entry.ref.track} that does not match the contract: ${parsed.error}`,
      );
      return;
    }
    const o = parsed.value;
    entry.meta = o.agent;
    entry.lastLiveAt = this.#now();
    if (entry.ref.sliced && (entry.firstLive === undefined || group < entry.firstLive)) entry.firstLive = group;
    const before = entry.log.liveEdge();
    if (o.kind === "snapshot") {
      if (!entry.outline || group >= entry.outline.group) entry.outline = { group, outline: o.outline };
    } else if (o.kind === "carry") {
      entry.log.addLive(group, { items: o.items, capped: o.capped }, undefined);
    } else {
      entry.log.addLive(group, undefined, o.item);
    }
    entry.log.trim(this.#maxSlices, this.#mode === "rewound" ? sliceOf(this.#position ?? 0) : group);
    // A new live slice: scrollback, or a slice fetched while in progress, may want fetching now.
    if (entry.ref.sliced && (before === undefined || group > before)) this.#plan();
    this.#changed();
  }

  // --- fetching ------------------------------------------------------------------------------------

  /** Which slices each opted-in track needs now, nearest first; queue those not held or in flight. */
  #plan(): void {
    if (this.#closed) return;
    const wanted = new Map<Entry, number[]>();
    const edge = this.#edgeSlice();
    for (const entry of this.#entries.values()) {
      if (!entry.enabled || !entry.ref.sliced) continue;
      let order: number[] = [];
      if (this.#mode === "rewound" && this.#position !== undefined) {
        // The playhead's slice, the one before (its carry-in may be cut), then every slice a late item
        // for this instant can still land in.
        const t = this.#position;
        const k = sliceOf(t);
        order = [k, k - 1];
        const last = sliceOf(t + Math.max(0, this.#lateness(entry.path, entry.ref.track)));
        for (let j = k + 1; j <= last; j++) order.push(j);
      } else {
        // Live: the slice before the first live one (the slice in progress at join, when the publisher
        // starts a subscription at the next group, design §5.1 and the looper), then scrollback.
        const live = entry.log.liveEdge() ?? edge;
        if (entry.firstLive !== undefined) order.push(entry.firstLive - 1);
        if (live !== undefined) for (let d = 1; d <= this.#liveBack; d++) order.push(live - d);
      }
      const limit = this.#fetchLimit(entry, edge);
      wanted.set(entry, limit === undefined ? [] : order.filter((k) => k >= 0 && k < limit));
    }
    // Cancel what is no longer wanted; transcript loads are never cancelled here.
    for (const job of [...this.#queue]) {
      if (job.into !== job.entry.log) continue;
      if (!wanted.get(job.entry)?.includes(job.slice)) this.#cancel(job);
    }
    // Interleave tracks by distance, so every track gets its current slice first.
    const lists = [...wanted.entries()];
    const longest = Math.max(0, ...lists.map(([, l]) => l.length));
    for (let i = 0; i < longest; i++) {
      for (const [entry, list] of lists) {
        const k = list[i];
        if (k === undefined || !entry.log.needs(k, edge)) continue;
        if (this.#queue.some((j) => j.entry === entry && j.slice === k && j.into === entry.log)) continue;
        const missedAt = entry.missing.get(k);
        if (missedAt !== undefined && this.#now() - missedAt < this.#retryMissing) continue;
        void this.#enqueue(entry, k, entry.log);
      }
    }
    this.#pump();
  }

  /**
   * The first slice a track must not FETCH: its first live slice (the subscription delivers it and all
   * later ones), or, before any live object, the slice in progress at the edge. Undefined: nothing yet.
   */
  #fetchLimit(entry: Entry, edge: number | undefined): number | undefined {
    if (entry.firstLive !== undefined) return entry.firstLive;
    return edge;
  }

  #enqueue(entry: Entry, slice: number, into: SliceLog): Promise<void> {
    return new Promise((resolve) => {
      this.#queue.push({ entry, slice, into, controller: new AbortController(), running: false, resolve });
    });
  }

  #pump(): void {
    while (!this.#closed) {
      const running = this.#queue.filter((j) => j.running).length;
      const next = this.#queue.find((j) => !j.running);
      if (!next || running >= this.#maxInFlight) break;
      next.running = true;
      void this.#run(next);
    }
    this.#changed();
  }

  async #run(job: Job): Promise<void> {
    const { entry, slice, into } = job;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      job.controller.abort(new NotFound(`slice ${slice}: no answer in ${this.#fetchTimeout} ms`));
    }, this.#fetchTimeout);
    try {
      const objects = await Promise.race([
        this.#source.fetchGroup(entry.path, entry.ref.track, slice, {
          priority: PRIORITY.fetch,
          signal: job.controller.signal,
        }),
        // Whether or not the source honours the signal, a timeout or a cancel ends the wait.
        abortion(job.controller.signal),
      ]);
      if (job.controller.signal.aborted || !entry.enabled) return;
      let carry: { items: Item[]; capped: boolean } | undefined;
      const items: Item[] = [];
      for (const payload of objects) {
        const parsed = parseObject(payload);
        if (!parsed.ok) continue;
        const o = parsed.value;
        entry.meta ??= o.agent;
        if (o.kind === "carry") carry = { items: o.items, capped: o.capped };
        else if (o.kind === "item") items.push(o.item);
      }
      // The slice at the live edge may still be growing: fetch it again once it is over.
      const edge = this.#edgeSlice();
      into.addFetched(slice, carry, items, edge === undefined || slice >= edge);
      entry.missing.delete(slice);
      if (into === entry.log)
        entry.log.trim(this.#maxSlices, this.#position === undefined ? slice : sliceOf(this.#position));
    } catch (e) {
      if (job.controller.signal.aborted && !timedOut) return;
      if (!(e instanceof NotFound)) console.warn(`fetch ${entry.path}/${entry.ref.track} slice ${slice} failed`, e);
      // Not found or no answer: a hole, asked for again later if still wanted.
      entry.missing.set(slice, this.#now());
    } finally {
      clearTimeout(timer);
      this.#remove(job);
      job.resolve();
      this.#pump();
    }
  }

  #cancel(job: Job): void {
    job.controller.abort();
    this.#remove(job);
    job.resolve();
  }

  #remove(job: Job): void {
    const i = this.#queue.indexOf(job);
    if (i >= 0) this.#queue.splice(i, 1);
  }

  /** The newest slice that can exist: the live edge from the media or from live groups. */
  #edgeSlice(): number | undefined {
    const edge = this.#liveEdgeMs();
    return edge === undefined ? undefined : sliceOf(Math.max(0, edge - 1));
  }

  #liveEdgeMs(): number | undefined {
    let edge = this.#externalEdge;
    for (const entry of this.#entries.values()) {
      const k = entry.log.liveEdge();
      if (k !== undefined && (edge === undefined || sliceEnd(k) > edge)) edge = sliceEnd(k);
    }
    return edge;
  }

  // --- view ----------------------------------------------------------------------------------------

  #changed(): void {
    this.#view = undefined;
    if (this.#notifyQueued) return;
    this.#notifyQueued = true;
    queueMicrotask(() => {
      this.#notifyQueued = false;
      for (const fn of [...this.#listeners]) fn();
    });
  }

  #buildView(): AiTracksView {
    const at = this.#mode === "rewound" ? this.#position : undefined;
    const now = this.#externalEdge === undefined ? undefined : sliceOf(this.#externalEdge);
    const tracks = [...this.#entries.values()]
      .map((e): TrackView => {
        const k = at === undefined ? undefined : sliceOf(at);
        const loading = this.#queue.some(
          (j) => j.entry === e && j.into === e.log && (k === undefined || j.slice === k),
        );
        return {
          id: e.id,
          agent: e.ref.agent,
          track: e.ref.track,
          kind: e.ref.kind,
          lang: e.ref.lang,
          label: e.meta?.label ?? defaultLabel(e.ref),
          model: e.meta?.model,
          costUsd: e.meta?.costUsd ?? 0,
          requests: e.meta?.requests ?? 0,
          announced: e.announced,
          enabled: e.enabled,
          sliced: e.ref.sliced && e.enabled ? e.log.view(at) : undefined,
          outline: e.outline?.outline,
          held: e.log.ranges(),
          loading,
          lastLiveAt: e.lastLiveAt,
          stale: isStale(e, this.#mode, now),
        };
      })
      .sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id));
    return { mode: this.#mode, position: this.#position, liveEdgeMs: this.#liveEdgeMs(), tracks };
  }
}

function isStale(e: Entry, mode: Mode, now: number | undefined): boolean {
  if (!e.enabled || !e.ref.sliced || mode !== "live" || now === undefined) return false;
  const latest = e.log.liveEdge();
  return latest !== undefined && latest < now;
}

function abortion(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

const KIND_ORDER: Record<string, number> = { captions: 0, translation: 1, slides: 2, outline: 3 };

function order(t: TrackView): number {
  return t.kind ? (KIND_ORDER[t.kind] ?? 9) : 9;
}

function defaultLabel(ref: TrackRef): string {
  if (ref.kind === "captions") return "Captions";
  if (ref.kind === "translation") return `Translation (${ref.lang})`;
  if (ref.kind === "slides") return "Slide descriptions";
  if (ref.kind === "outline") return "Chapters, glossary and recap";
  return ref.agent;
}
