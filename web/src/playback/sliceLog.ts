// One sliced track's slices as this viewer holds them, live or fetched, merged into one timeline.
// Items are keyed by id across slices: a line spoken late in slice k may land in k+1, and its interim
// versions come before the final one (design §4.2).

import { type Range, sliceOf, sliceStart, slicesToRanges } from "./slices";
import type { Item, LineItem, SlideItem } from "./wire";

export type SliceOrigin = "live" | "fetch";

export interface Slice {
  slice: number;
  origin: SliceOrigin;
  /** Object 0, once it arrived. */
  carry: Item[] | undefined;
  capped: boolean;
  /** Items in object order. */
  items: Item[];
  /** Fetched while still being produced: fetch it again once it is over. */
  partial: boolean;
}

/** What a sliced track shows at one media time. */
export interface SlicedView {
  /** Lines up to the time, merged by id, in id order (captions and translations). */
  lines: LineItem[];
  /** The line being spoken at the time, if any. */
  current: LineItem | undefined;
  /** Every slide up to the time, and the one on screen. */
  slides: SlideItem[];
  slide: SlideItem | undefined;
  /** The slice at the time says the room reached its spend cap. */
  capped: boolean;
  /** The slice at the time is held (otherwise it is still loading, or missing). */
  loaded: boolean;
}

const key = (i: Item) => `${i.type}:${i.id}`;

/** How long a line stays current after its last word. */
const LINGER_MS = 2_000;

/** When an item belongs on the media clock. Untimed lines (time 0 past slice 0) take their slice's start. */
export function itemTime(item: Item, slice: number): number {
  if (item.type === "slide") return item.atMs;
  return item.startMs > 0 || slice === 0 ? item.startMs : sliceStart(slice);
}

/** Whether `b` replaces `a` under the same id: a final version wins, then the later one. */
function replaces(a: { item: Item; order: number }, b: { item: Item; order: number }): boolean {
  const fa = a.item.type === "line" ? a.item.final : true;
  const fb = b.item.type === "line" ? b.item.final : true;
  if (fa !== fb) return fb;
  return b.order >= a.order;
}

export class SliceLog {
  #slices = new Map<number, Slice>();

  get size(): number {
    return this.#slices.size;
  }

  has(slice: number): boolean {
    return this.#slices.has(slice);
  }

  /** Whether slice `k` should be fetched: not held, or held partly and over since (`edge` is the newest). */
  needs(k: number, edge: number | undefined): boolean {
    const s = this.#slices.get(k);
    return !s || (s.partial && edge !== undefined && k < edge);
  }

  get(slice: number): Slice | undefined {
    return this.#slices.get(slice);
  }

  slices(): number[] {
    return [...this.#slices.keys()].sort((a, b) => a - b);
  }

  /** The newest slice received live. */
  liveEdge(): number | undefined {
    let edge: number | undefined;
    for (const s of this.#slices.values())
      if (s.origin === "live" && (edge === undefined || s.slice > edge)) edge = s.slice;
    return edge;
  }

  ranges(): Range[] {
    return slicesToRanges(this.#slices.keys());
  }

  /** One live object: the carry-in, or an item. */
  addLive(slice: number, carry: { items: Item[]; capped: boolean } | undefined, item: Item | undefined): void {
    let s = this.#slices.get(slice);
    if (!s || (s.origin === "fetch" && carry)) {
      // A live copy is the same group as a fetched one (objects are immutable): its carry-in starts it over.
      s = { slice, origin: "live", carry: undefined, capped: false, items: [], partial: false };
      this.#slices.set(slice, s);
    } else if (s.origin === "fetch") {
      // The subscription joined a group this viewer fetched the start of: it goes on live from here.
      s.origin = "live";
      s.partial = false;
    }
    if (carry) {
      s.carry = carry.items;
      s.capped = carry.capped;
    }
    if (item) s.items.push(item);
  }

  /**
   * A group from FETCH: whole, or (`partial`) as far as it was produced. A slice already held live is
   * complete or growing there: kept.
   */
  addFetched(
    slice: number,
    carry: { items: Item[]; capped: boolean } | undefined,
    items: Item[],
    partial = false,
  ): void {
    if (this.#slices.get(slice)?.origin === "live") return;
    const capped = carry?.capped ?? false;
    this.#slices.set(slice, { slice, origin: "fetch", carry: carry?.items, capped, items, partial });
  }

  /** Drop fetched slices (Go live), keeping what arrived live. */
  dropFetched(): void {
    for (const [k, s] of this.#slices) if (s.origin === "fetch") this.#slices.delete(k);
  }

  /** Keep at most `max` slices, dropping those farthest from `around`. */
  trim(max: number, around: number): void {
    if (this.#slices.size <= max) return;
    const far = this.slices().sort((a, b) => Math.abs(b - around) - Math.abs(a - around));
    for (const k of far.slice(0, this.#slices.size - max)) this.#slices.delete(k);
  }

  clear(): void {
    this.#slices.clear();
  }

  /**
   * The track at media time `at` (undefined: everything held, as live shows it). Lines and slides are
   * shown from their own media time, so they line up with the media, not with when they were produced.
   */
  view(at: number | undefined): SlicedView {
    const best = new Map<string, { item: Item; order: number; time: number }>();
    const consider = (item: Item, slice: number, order: number) => {
      const time = itemTime(item, slice);
      if (at !== undefined && time > at) return;
      const k = key(item);
      const prev = best.get(k);
      if (!prev || replaces(prev, { item, order })) best.set(k, { item, order, time });
    };
    // Order: slice, then object index; a carry-in repeats final lines from before its slice.
    for (const s of [...this.#slices.values()].sort((a, b) => a.slice - b.slice)) {
      const base = s.slice * 1_000_000;
      s.carry?.forEach((item) => consider(item, s.slice, base));
      s.items.forEach((item, i) => consider(item, s.slice, base + 1 + i));
    }
    const entries = [...best.values()];
    const lines = entries
      .filter((e): e is { item: LineItem; order: number; time: number } => e.item.type === "line")
      .sort((a, b) => a.item.id - b.item.id)
      .map((e) => e.item);
    const slides = entries
      .filter((e): e is { item: SlideItem; order: number; time: number } => e.item.type === "slide")
      .sort((a, b) => a.time - b.time || a.item.id - b.item.id)
      .map((e) => e.item);
    const atSlice = at === undefined ? (this.liveEdge() ?? this.slices().at(-1)) : sliceOf(at);
    const here = atSlice === undefined ? undefined : this.#slices.get(atSlice);
    // Every line here starts at or before `at`; one is current until shortly after it ends.
    const current = at === undefined ? lines.at(-1) : lines.findLast((l) => l.endMs === 0 || at < l.endMs + LINGER_MS);
    return {
      lines,
      current,
      slides,
      slide: slides.at(-1),
      capped: here?.capped ?? false,
      loaded: here !== undefined,
    };
  }
}
