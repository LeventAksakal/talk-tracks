// The whole talk's slides for the lecture package: which slide was on screen when, each slide's picture and text
// from the deck, and the ink and text marks on it when it was last shown (its final state). Read by FETCH over the
// player's history source, never through the player's slide store, so the playhead and what is on screen stay put.
//
// Container formats §1: a sliced track's group k holds room time [4k, 4k+4) s, object 0 the carry-in. The carry-in
// of ink and marks holds only the slide on screen, so a slide's final ink is the state of the ink track at the end
// of the last span it was shown: one group per slide. The slide track is read whole, one group per slice.

import { annotationsPath, DECK_TRACK, INK_TRACK, MARKS_TRACK, SLIDE_TRACK, slidesPath } from "../contracts/names";
import { inkCarry, marksCarry, upTo } from "../contracts/tracks";
import type {
  CurrentSlideRecord,
  DeckImage,
  DeckInfo,
  DeckRecord,
  InkElement,
  InkRecord,
  MarkRecord,
  ShowSlide,
  TextMark,
} from "../contracts/types";
import {
  type Parsed,
  parseCurrentSlideObject,
  parseDeckObject,
  parseInkObject,
  parseMarksObject,
} from "../contracts/validate";
import { sliceOf } from "../playback/slices";
import { type HistorySource, NotFound } from "../playback/source";
import { historyPath } from "../player/slideTracks";

/** History goes after anything live (design §5.11). */
const FETCH_PRIORITY = 32;
/** A FETCH with no answer by then is a hole (moq-relay 0.17.8 never answers some, wiki/benchmark.md). */
const FETCH_TIMEOUT_MS = 2_500;
/** FETCHes in flight at once. */
const CONCURRENCY = 6;
/** The slide track is read over at most this many slices, the newest (3 h): a looped room's clock runs for days. */
export const MAX_SLIDE_SLICES = 2_700;

export interface ShownSpan {
  /** Room ms. */
  fromMs: number;
  toMs: number;
}

export interface GatheredSlide {
  /** The deck track's group holding the deck. */
  deck: number;
  /** 0-based position in the deck. */
  index: number;
  image: DeckImage | undefined;
  /** When it was on screen, in order; empty for a slide of the deck never shown. */
  shown: ShownSpan[];
  /** The speaker's strokes and shapes on it at the end of its last span, oldest first. */
  ink: InkElement[];
  /** The speaker's text marks on it then. */
  marks: TextMark[];
  /** The listener's own strokes, shapes and text marks on it then, from the audience track (when `mine` is given). */
  mine: { ink: InkElement[]; marks: TextMark[] };
}

export interface GatheredDeck {
  deck: number;
  info: DeckInfo | undefined;
}

export interface SlidesGathered {
  decks: GatheredDeck[];
  slides: GatheredSlide[];
  /** Slide groups that could not be read (never produced, not archived, or no answer). */
  missingGroups: number;
}

export interface GatherProgress {
  done: number;
  total: number;
}

export interface GatherSlidesOptions {
  source: HistorySource;
  room: string;
  /** Room ms: the talk so far, [fromMs, toMs). */
  fromMs: number;
  toMs: number;
  signal?: AbortSignal;
  onProgress?: (p: GatherProgress) => void;
  fetchTimeoutMs?: number;
  concurrency?: number;
  /**
   * The listener's author id: their own ink and text marks are read from the audience track too, everyone else's
   * left out. Undefined: the audience track is not read.
   */
  mine?: string;
}

type Rec = { m: number; data: unknown };

/**
 * FETCH one group, from the archive name first and the live name second (a looped room's origin answers on the
 * live name; the newest slices are not archived yet). The name that answered is tried first next time.
 */
class Fetcher {
  #source: HistorySource;
  #signal: AbortSignal | undefined;
  #timeout: number;
  #order = new Map<string, string[]>();

  constructor(source: HistorySource, signal: AbortSignal | undefined, timeoutMs: number) {
    this.#source = source;
    this.#signal = signal;
    this.#timeout = timeoutMs;
  }

  async group<R>(
    paths: readonly string[],
    track: string,
    group: number,
    parse: (p: Uint8Array) => Parsed<readonly R[]>,
  ): Promise<(readonly R[])[] | undefined> {
    const order = this.#order.get(track) ?? [...paths];
    for (const path of order) {
      this.#signal?.throwIfAborted();
      const objects = await this.#one(path, track, group);
      if (!objects) continue;
      if (order[0] !== path) this.#order.set(track, [path, ...order.filter((p) => p !== path)]);
      return objects.map((payload) => {
        const parsed = parse(payload);
        return parsed.ok ? parsed.value : [];
      });
    }
    return undefined;
  }

  async #one(path: string, track: string, group: number): Promise<Uint8Array[] | undefined> {
    const controller = new AbortController();
    const outer = this.#signal;
    const stop = () => controller.abort(outer?.reason);
    outer?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => controller.abort(new NotFound("no answer")), this.#timeout);
    try {
      return await Promise.race([
        this.#source.fetchGroup(path, track, group, { priority: FETCH_PRIORITY, signal: controller.signal }),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }),
        ),
      ]);
    } catch (err) {
      outer?.throwIfAborted();
      if (!(err instanceof NotFound)) console.warn(`lecture package: fetch ${path}/${track} group ${group}`, err);
      return undefined;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", stop);
    }
  }
}

/** Run `fn` over `items`, `n` at a time, in order of the results. */
async function mapLimit<T, U>(items: readonly T[], n: number, fn: (item: T, i: number) => Promise<U>): Promise<U[]> {
  const out = new Array<U>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const key = (s: { deck: number; index: number }) => `${s.deck}/${s.index}`;

/**
 * The spans each slide was on screen, from the slide track's records in time order (carry-ins repeat a record
 * already seen, which changes nothing). A span still open ends at `toMs`.
 */
export function shownSpans(
  records: readonly CurrentSlideRecord[],
  toMs: number,
): Map<string, { show: ShowSlide; spans: ShownSpan[] }> {
  const out = new Map<string, { show: ShowSlide; spans: ShownSpan[] }>();
  let on: { show: ShowSlide; from: number } | undefined;
  const close = (at: number) => {
    if (!on) return;
    const k = key(on.show);
    const entry = out.get(k) ?? { show: on.show, spans: [] };
    if (at > on.from) entry.spans.push({ fromMs: on.from, toMs: at });
    out.set(k, entry);
    on = undefined;
  };
  const sorted = [...records].sort((a, b) => a.m - b.m);
  for (const r of sorted) {
    if (r.m >= toMs) break;
    const d = r.data;
    if (d.kind === "show") {
      if (on && on.show.deck === d.deck && on.show.index === d.index) continue;
      close(r.m);
      on = { show: d, from: r.m };
    } else close(r.m);
  }
  close(toMs);
  return out;
}

/** Gather the talk's slides, their pictures and their final ink and marks. */
export async function gatherSlides(options: GatherSlidesOptions): Promise<SlidesGathered> {
  const { source, room, fromMs, toMs, signal, onProgress, mine } = options;
  const fetcher = new Fetcher(source, signal, options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS);
  const n = options.concurrency ?? CONCURRENCY;
  const live = slidesPath(room);
  const paths = [historyPath(live), live];
  // The room service's annotations are fetched where they are published (as slideTracks reads them).
  const audience = [annotationsPath(room)];

  const last = sliceOf(Math.max(fromMs, toMs - 1));
  const first = Math.max(sliceOf(fromMs), last - MAX_SLIDE_SLICES + 1);
  const ks = Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i);

  // 1. The slide track, whole: every group of the talk. Then the decks and the ink and marks groups (estimated).
  let done = 0;
  let total = ks.length;
  const tick = () => onProgress?.({ done: ++done, total });
  onProgress?.({ done, total });
  let missingGroups = 0;
  const slideGroups = await mapLimit(ks, n, async (k) => {
    const g = await fetcher.group<CurrentSlideRecord>(paths, SLIDE_TRACK, k, parseCurrentSlideObject);
    if (!g) missingGroups++;
    tick();
    return g ?? [];
  });
  const records = slideGroups.flatMap((objects) => objects.flat());
  const spans = shownSpans(records, toMs);

  // 2. The decks named by the slides shown.
  const deckIds = [...new Set([...spans.values()].map((s) => s.show.deck))].sort((a, b) => a - b);
  const shownList = [...spans.values()].filter((s) => s.spans.length);
  total += deckIds.length + shownList.length;
  const decks = await mapLimit(deckIds, n, async (deck) => {
    const g = await fetcher.group<DeckRecord>(paths, DECK_TRACK, deck, parseDeckObject);
    tick();
    const data = (g ?? []).flat().map((r) => r.data);
    const info = data.find((d): d is DeckInfo => d.kind === "deck");
    const images = new Map<number, DeckImage>();
    for (const d of data) if (d.kind === "image") images.set(d.index, d);
    return { deck, info, images };
  });

  // 3. Each shown slide's ink and marks at the end of its last span. Groups are shared between slides.
  const groups = new Map<string, Promise<(readonly Rec[])[] | undefined>>();
  type Parse = (p: Uint8Array) => Parsed<readonly Rec[]>;
  const read = (from: readonly string[], track: string, k: number, parse: Parse) => {
    const id = `${from[0]}/${track}:${k}`;
    let p = groups.get(id);
    if (!p) {
      p = fetcher.group<Rec>(from, track, k, parse);
      groups.set(id, p);
    }
    return p;
  };
  /** The track's records in effect at t: its group at t up to t, or the whole group before it if that is a hole. */
  const at = async (from: readonly string[], track: string, t: number, parse: Parse) => {
    const k = sliceOf(t);
    const g = await read(from, track, k, parse);
    if (g) return upTo(g, t);
    const prev = k > 0 ? await read(from, track, k - 1, parse) : undefined;
    return prev ? prev.flat() : [];
  };
  const inkParse = parseInkObject as Parse;
  const marksParse = parseMarksObject as Parse;
  const nothing = Promise.resolve<Rec[]>([]);
  const own = (x: { by: { id: string } }) => x.by.id === mine;
  const finals = new Map<string, Pick<GatheredSlide, "ink" | "marks" | "mine">>();
  await mapLimit(shownList, Math.max(1, Math.floor(n / 2)), async ({ show, spans: s }) => {
    const end = s.at(-1)!.toMs - 1;
    const [ink, marks, audienceInk, audienceMarks] = await Promise.all([
      at(paths, INK_TRACK, end, inkParse),
      at(paths, MARKS_TRACK, end, marksParse),
      mine === undefined ? nothing : at(audience, INK_TRACK, end, inkParse),
      mine === undefined ? nothing : at(audience, MARKS_TRACK, end, marksParse),
    ]);
    finals.set(key(show), {
      ink: inkCarry(ink as InkRecord[], show).map((r) => r.data),
      marks: marksCarry(marks as MarkRecord[], show).map((r) => r.data),
      mine: {
        ink: inkCarry(audienceInk as InkRecord[], show)
          .map((r) => r.data)
          .filter(own),
        marks: marksCarry(audienceMarks as MarkRecord[], show)
          .map((r) => r.data)
          .filter(own),
      },
    });
    tick();
  });

  // Every slide of each deck shown, in deck order; slides shown from a deck that was not read still count.
  const slides: GatheredSlide[] = [];
  for (const d of decks) {
    const count = Math.max(d.info?.count ?? 0, ...[...d.images.keys()].map((i) => i + 1));
    const indexes = new Set<number>(Array.from({ length: count }, (_, i) => i));
    for (const s of spans.values()) if (s.show.deck === d.deck) indexes.add(s.show.index);
    for (const index of [...indexes].sort((a, b) => a - b)) {
      const k = key({ deck: d.deck, index });
      slides.push({
        deck: d.deck,
        index,
        image: d.images.get(index),
        shown: spans.get(k)?.spans ?? [],
        ink: finals.get(k)?.ink ?? [],
        marks: finals.get(k)?.marks ?? [],
        mine: finals.get(k)?.mine ?? { ink: [], marks: [] },
      });
    }
  }
  return { decks: decks.map((d) => ({ deck: d.deck, info: d.info })), slides, missingGroups };
}
