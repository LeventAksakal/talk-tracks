// The speaker's slide tracks, everyone else's annotations and the room's state, as the player draws them at room
// time t (decisions 0017, 0021, 0022; wiki/design/container-formats.md). Live: one SUBSCRIBE per track the
// viewer's layout needs. Rewound: FETCH of the one group ⌊t/4 s⌋ per track, whose object 0 (the carry-in) plus
// its deltas up to t is the whole state; the speaker's past comes from talk/<room>/archive/slides, the room
// service's tracks from their own names. The deck is FETCHed by the group the slide track names.

import {
  annotationsPath,
  catalogPath,
  COMMENTS_TRACK,
  commentsPath,
  DECK_TRACK,
  INK_TRACK,
  MARKS_TRACK,
  POINTER_TRACK,
  ROOM_TRACK,
  ROOT,
  SLIDE_TRACK,
  slidesPath,
} from "../contracts/names";
import {
  commentsCarry,
  currentSlide,
  inkCarry,
  marksCarry,
  type StrokeRecord,
  type TextMarkRecord,
  upTo,
} from "../contracts/tracks";
import type {
  CommentRecord,
  CurrentSlideRecord,
  DeckImage,
  DeckInfo,
  DeckRecord,
  InkRecord,
  MarkRecord,
  PointerRecord,
  RoomCatalog,
  RoomState,
  RoomStateRecord,
  ShowSlide,
} from "../contracts/types";
import {
  type Parsed,
  parseCommentsObject,
  parseCurrentSlideObject,
  parseDeckObject,
  parseInkObject,
  parseMarksObject,
  parsePointerObject,
  parseRoomStateObject,
} from "../contracts/validate";
import type { Mode } from "../playback/aiTracks";
import { SLICE_MS, sliceOf } from "../playback/slices";
import { type HistorySource, NotFound } from "../playback/source";
import type { Closable } from "../transport/types";

export type TrackId =
  | "deck"
  | "slide"
  | "ink"
  | "marks"
  | "pointer"
  | "audience-ink"
  | "audience-marks"
  | "comments"
  | "room";

/** What the slides source needs: the speaker's five tracks. */
export const SPEAKER_TRACKS: readonly TrackId[] = ["deck", "slide", "ink", "marks", "pointer"];
/** Everyone else's ink and text marks, and the comments anchored on the slides, from the room service. */
export const AUDIENCE_TRACKS: readonly TrackId[] = ["audience-ink", "audience-marks", "comments"];

export type RoomStateKind = RoomState["state"];

/**
 * Where the past of a speaker track is fetched: talk/<room>/<rest> becomes talk/<room>/archive/<rest>, same
 * track names and group numbers (decision 0022, `history_path` in agents/src/talk_tracks/archive/events.py).
 */
export function historyPath(namespace: string): string {
  const [root, room, ...rest] = namespace.split("/");
  if (root !== ROOT || !room || rest.length === 0) throw new Error(`not a track namespace of a room: ${namespace}`);
  return [ROOT, room, "archive", ...rest].join("/");
}

type Rec = { m: number; data: unknown };

interface Spec {
  id: TrackId;
  /** Live: SUBSCRIBE here. */
  path: string;
  /** Past groups: FETCH here. */
  history: string;
  track: string;
  /** Cut in 4 s slices on the room clock (all but the deck, which has a group per deck). */
  sliced: boolean;
  /** moq-lite priority of the live subscription; the laser and ink first, the big deck late. */
  priority: number;
  parse: (payload: Uint8Array) => Parsed<readonly Rec[]>;
}

/** History always goes after live (design §5.11). */
const FETCH_PRIORITY = 32;
/** The order a seek fetches in: what is on screen first, the laser last. */
const FETCH_ORDER: readonly TrackId[] = [
  "slide",
  "room",
  "ink",
  "marks",
  "audience-ink",
  "audience-marks",
  "comments",
  "pointer",
];
/** A new subscription's first group is on its way: no FETCH of the slice before this. */
const JOIN_GRACE_MS = 1_500;
/** While rewound, the next slice is fetched this close to the end of the current one. */
const PREFETCH_MS = 1_000;
/** A hovered time's slide group is fetched once the pointer rests this long (seek preview). */
const PREVIEW_DEBOUNCE_MS = 120;

function specs(room: string): Record<TrackId, Spec> {
  const slides = slidesPath(room);
  const speaker = (id: TrackId, track: string, priority: number, parse: Spec["parse"]): Spec => ({
    id,
    path: slides,
    history: historyPath(slides),
    track,
    sliced: track !== DECK_TRACK,
    priority,
    parse,
  });
  const own = (id: TrackId, path: string, track: string, priority: number, parse: Spec["parse"]): Spec => ({
    id,
    path,
    history: path,
    track,
    sliced: true,
    priority,
    parse,
  });
  return {
    deck: speaker("deck", DECK_TRACK, 112, parseDeckObject),
    slide: speaker("slide", SLIDE_TRACK, 176, parseCurrentSlideObject),
    ink: speaker("ink", INK_TRACK, 192, parseInkObject),
    marks: speaker("marks", MARKS_TRACK, 160, parseMarksObject),
    pointer: speaker("pointer", POINTER_TRACK, 200, parsePointerObject),
    "audience-ink": own("audience-ink", annotationsPath(room), INK_TRACK, 150, parseInkObject),
    "audience-marks": own("audience-marks", annotationsPath(room), MARKS_TRACK, 140, parseMarksObject),
    comments: own("comments", commentsPath(room), COMMENTS_TRACK, 130, parseCommentsObject),
    room: own("room", catalogPath(room), ROOM_TRACK, 96, parseRoomStateObject),
  };
}

interface Group {
  /** Objects by index (sparse until they all arrived); object 0 is the carry-in. */
  objects: (readonly Rec[])[];
  origin: "live" | "fetch";
  /** Fetched while still being produced: fetched again once it is over. */
  partial: boolean;
  /** Bumped on every object, for the reducers' memo. */
  version: number;
}

interface Entry {
  spec: Spec;
  /** The viewer's features need it and the room has it. */
  active: boolean;
  sub: Closable | undefined;
  subscribedAt: number | undefined;
  groups: Map<number, Group>;
  newestLive: number | undefined;
  /** Groups not found (never produced, or not archived), with when. */
  missing: Map<number, number>;
  /** Some object of the track arrived: the room has it. */
  seen: boolean;
}

interface Job {
  entry: Entry;
  group: number;
  kind: "play" | "preview" | "deck";
  controller: AbortController;
  running: boolean;
}

/** Records of one sliced track in effect at t; `gap`: its group was never produced (nobody published). */
type AtT = { records: readonly Rec[]; group: Group | undefined; gap: boolean };

export interface SlideTracksOptions {
  now?: () => number;
  /** The newest room catalog: which of these tracks the room has (a looped room has no ink). */
  catalog?: () => RoomCatalog | undefined;
  /** FETCHes in flight at once. */
  maxInFlight?: number;
  /** Groups kept per sliced track, the farthest from the playhead dropped first. */
  maxGroups?: number;
  /** A FETCH with no answer by then is a hole, like not found (moq-relay 0.17.8, wiki/benchmark.md). */
  fetchTimeoutMs?: number;
  /** A group not found is asked for again after this long, if still wanted. */
  retryMissingMs?: number;
}

export interface SlideAt {
  /** The slide on screen; null when none is (hidden, nothing shown yet, or a stretch nobody published). */
  slide: ShowSlide | null;
  /** The speaker's and everyone else's marks on it, oldest first. */
  marks: TextMarkRecord[];
}

export interface DeckPicture {
  image: DeckImage;
  /** An object URL (or data URL) of the image. */
  url: string;
}

/**
 * The slide tracks of one room. `setWanted` says which tracks the viewer's layout needs (decision 0010: none
 * until the slides are shown); `setTime` follows the frame clock and fetches the group the playhead needs.
 * Reading is pure and cheap enough for every animation frame: `slideAt`, `inkAt`, `pointerAt`, `roomAt`.
 */
export class SlideTracks {
  readonly room: string;
  #source: HistorySource;
  #now: () => number;
  #catalog: () => RoomCatalog | undefined;
  #maxInFlight: number;
  #maxGroups: number;
  #fetchTimeout: number;
  #retryMissing: number;
  #entries = new Map<TrackId, Entry>();
  #wanted = new Set<TrackId>();
  #queue: Job[] = [];
  #t: number | undefined;
  #mode: Mode = "live";
  #edge: number | undefined;
  #planKey = "";
  #plannedAt = -Infinity;
  #previewTimer: ReturnType<typeof setTimeout> | undefined;
  /** The group a rested hover is about to fetch. */
  #previewGroup: number | undefined;
  #urls = new Map<string, string>();
  #lastAt: SlideAt | undefined;
  #memo = new Map<string, { group: Group | undefined; version: number; n: number; extra: string; value: unknown }>();
  #listeners = new Set<() => void>();
  #version = 0;
  #notifyQueued = false;
  #closed = false;

  constructor(source: HistorySource, room: string, options: SlideTracksOptions = {}) {
    this.room = room;
    this.#source = source;
    this.#now = options.now ?? Date.now;
    this.#catalog = options.catalog ?? (() => undefined);
    this.#maxInFlight = options.maxInFlight ?? 4;
    this.#maxGroups = options.maxGroups ?? 30;
    this.#fetchTimeout = options.fetchTimeoutMs ?? 2_000;
    this.#retryMissing = options.retryMissingMs ?? 5_000;
    for (const spec of Object.values(specs(room))) {
      this.#entries.set(spec.id, {
        spec,
        active: false,
        sub: undefined,
        subscribedAt: undefined,
        groups: new Map(),
        newestLive: undefined,
        missing: new Map(),
        seen: false,
      });
    }
  }

  // --- React glue: changes that matter to a render (a slide or room group, a deck image, a fetch) ---------------

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getVersion = (): number => this.#version;

  // --- commands -------------------------------------------------------------------------------------------------

  /** The tracks the viewer's features need; each one the room has gets one live subscription, the rest none. */
  setWanted(ids: Iterable<TrackId>): void {
    this.#wanted = new Set(ids);
    this.#sync();
    this.#plan(true);
  }

  /** The room time of the frame on screen (undefined: nothing plays yet), the mode, and the live edge. */
  setTime(t: number | undefined, mode: Mode, liveEdge: number | undefined): void {
    this.#t = t;
    this.#mode = mode;
    this.#edge = liveEdge;
    const k = t === undefined ? "" : String(sliceOf(t));
    const near = mode === "rewound" && t !== undefined && t - sliceOf(t) * SLICE_MS > SLICE_MS - PREFETCH_MS;
    const key = `${mode}:${k}:${near}`;
    if (key !== this.#planKey || this.#now() - this.#plannedAt > 500) this.#plan(key !== this.#planKey);
    this.#planKey = key;
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#previewTimer);
    for (const job of [...this.#queue]) this.#cancel(job);
    for (const e of this.#entries.values()) e.sub?.close();
    for (const url of this.#urls.values()) if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    this.#urls.clear();
    this.#listeners.clear();
  }

  // --- reading the state at t -----------------------------------------------------------------------------------

  /** Whether the track is subscribed (the room has it and the viewer's layout needs it). */
  isActive(id: TrackId): boolean {
    return this.#entries.get(id)?.active ?? false;
  }

  /** A track's group k is being fetched. */
  loading(id: TrackId, t: number | undefined): boolean {
    if (t === undefined) return false;
    const k = sliceOf(t);
    return this.#queue.some((j) => j.entry.spec.id === id && j.group === k && j.kind === "play");
  }

  /**
   * The slide on screen at t and the marks on it; while its group loads, the last one read (undefined before any).
   * With t undefined (live, nothing playing yet), the newest state.
   */
  slideAt(t: number | undefined): SlideAt | undefined {
    const shown = this.#slide(t);
    // While the group at t loads, the last state stays on screen (a seek keeps the old frame until the new one).
    if (shown === undefined) return this.isActive("slide") ? this.#lastAt : undefined;
    const marks = [
      ...this.#reduced("marks", t, shown, (r) => marksCarry(r as readonly MarkRecord[], shown)),
      ...this.#reduced("audience-marks", t, shown, (r) => marksCarry(r as readonly MarkRecord[], shown)),
    ];
    this.#lastAt = { slide: shown, marks };
    return this.#lastAt;
  }

  /** The strokes on the slide on screen at t, everyone else's first and the speaker's on top; undefined: loading. */
  inkAt(t: number | undefined): StrokeRecord[] | undefined {
    const shown = this.#slide(t);
    if (shown === undefined) return undefined;
    if (shown === null) return [];
    return [
      ...this.#reduced("audience-ink", t, shown, (r) => inkCarry(r as readonly InkRecord[], shown)),
      ...this.#reduced("ink", t, shown, (r) => inkCarry(r as readonly InkRecord[], shown)),
    ];
  }

  /**
   * The comments anchored on the slide on screen at t and their replies, edits applied and hidden ones left out,
   * in the order they were made (the comments track's state at t); undefined while the slide loads.
   */
  commentsAt(t: number | undefined): CommentRecord[] | undefined {
    const shown = this.#slide(t);
    if (shown === undefined) return undefined;
    return this.#reduced("comments", t, shown, (r) => commentsCarry(r as readonly CommentRecord[], shown));
  }

  /**
   * Where the laser is at t, in fractions of the slide; null when off or no slide is shown. Between two samples
   * held (rewound), the position is interpolated, so it moves smoothly at any frame rate.
   */
  pointerAt(t: number | undefined): { x: number; y: number } | null {
    const e = this.#entries.get("pointer");
    if (!e?.active || this.#slide(t) === null) return null;
    const at = this.#at(e, t);
    if (!at) return null;
    return laserAt(at.records as PointerRecord[], t, at.group ? dense(at.group) : []);
  }

  /** The room's state now: the newest group's last record (undefined until the room track is read). */
  roomNow(): RoomStateKind | undefined {
    const e = this.#entries.get("room");
    if (!e?.active) return undefined;
    const newest = [...e.groups.entries()]
      .filter(([, g]) => g.objects[0] !== undefined)
      .sort(([a], [b]) => b - a)[0]?.[1];
    if (!newest) return undefined;
    return (dense(newest).flat().at(-1) as RoomStateRecord | undefined)?.data.state;
  }

  /**
   * The room's state at t. A stretch where the room track has no group (nobody published: the room service was
   * not running the room) counts as paused.
   */
  roomAt(t: number | undefined): RoomStateKind | undefined {
    if (t === undefined) return this.roomNow();
    const e = this.#entries.get("room");
    if (!e?.active) return undefined;
    const at = this.#at(e, t);
    if (!at) return undefined;
    if (at.gap) return "paused";
    return (at.records.at(-1) as RoomStateRecord | undefined)?.data.state;
  }

  /** The deck's info (count, aspect), once its object 0 is held; asks for the deck if not. */
  deckInfo(deck: number): DeckInfo | undefined {
    const g = this.#deckGroup(deck);
    return g?.objects[0]?.map((r) => (r as DeckRecord).data).find((d): d is DeckInfo => d.kind === "deck");
  }

  /** The picture of a slide, once the deck holds it; asks for the deck if not. */
  picture(deck: number, index: number): DeckPicture | undefined {
    const g = this.#deckGroup(deck);
    if (!g) return undefined;
    let image: DeckImage | undefined;
    for (const o of g.objects) {
      if (!o) continue;
      for (const r of o) {
        const d = (r as DeckRecord).data;
        if (d.kind === "image" && d.index === index) image = d;
      }
    }
    if (!image) return undefined;
    const key = `${deck}:${index}:${image.data_b64.length}`;
    let url = this.#urls.get(key);
    if (!url) {
      url = imageUrl(image);
      this.#urls.set(key, url);
    }
    return { image, url };
  }

  /**
   * The slide on screen at a hovered time, for the seek preview; undefined while unknown, in which case its group
   * is fetched once the pointer rests (a change is notified).
   */
  previewAt(t: number): ShowSlide | null | undefined {
    const e = this.#entries.get("slide");
    if (!e?.active) return undefined;
    const k = sliceOf(t);
    const g = e.groups.get(k);
    if (g?.objects[0] !== undefined) return currentSlide(upTo(dense(g), t) as CurrentSlideRecord[]);
    if (e.missing.has(k)) return null;
    if (this.#previewGroup === k || this.#queue.some((j) => j.entry === e && j.group === k)) return undefined;
    clearTimeout(this.#previewTimer);
    this.#previewGroup = k;
    this.#previewTimer = setTimeout(() => {
      this.#previewGroup = undefined;
      const edge = this.#edgeSlice();
      if (this.#closed || (edge !== undefined && k > edge) || e.groups.get(k)?.objects[0] !== undefined) return;
      if (this.#queue.some((j) => j.entry === e && j.group === k)) return;
      this.#enqueue(e, k, "preview");
      this.#pump();
    }, PREVIEW_DEBOUNCE_MS);
    return undefined;
  }

  // --- state helpers --------------------------------------------------------------------------------------------

  /** The slide on screen at t: null when none, undefined while loading or with the slide track off. */
  #slide(t: number | undefined): ShowSlide | null | undefined {
    const e = this.#entries.get("slide");
    if (!e?.active) return undefined;
    const at = this.#at(e, t);
    if (!at) return undefined;
    if (at.gap) return null;
    return this.#memoised("slide", at, "", () => currentSlide(at.records as CurrentSlideRecord[]));
  }

  /** A per-slide state (ink, marks) of one track at t, reduced once per change of what is in effect. */
  #reduced<T>(id: TrackId, t: number | undefined, on: ShowSlide | null, reduce: (records: readonly Rec[]) => T[]): T[] {
    const e = this.#entries.get(id);
    if (!e?.active || !on) return [];
    const at = this.#at(e, t);
    if (!at || at.gap) return [];
    return this.#memoised(id, at, `${on.deck}/${on.index}`, () => reduce(at.records));
  }

  #memoised<T>(name: string, at: AtT, extra: string, compute: () => T): T {
    const hit = this.#memo.get(name);
    const version = at.group?.version ?? -1;
    if (hit && hit.group === at.group && hit.version === version && hit.n === at.records.length && hit.extra === extra)
      return hit.value as T;
    const value = compute();
    this.#memo.set(name, { group: at.group, version, n: at.records.length, extra, value });
    return value;
  }

  /**
   * The records of a sliced track in effect at t: its group ⌊t/4 s⌋ (object 0 and the deltas up to t). While that
   * group loads, the previous one held whole (the state at the slice start, if nothing changed since). Undefined:
   * not known yet.
   */
  #at(e: Entry, t: number | undefined): AtT | undefined {
    if (t === undefined) {
      const newest = [...e.groups.entries()]
        .filter(([, g]) => g.objects[0] !== undefined)
        .sort(([a], [b]) => b - a)[0]?.[1];
      return newest ? { records: dense(newest).flat(), group: newest, gap: false } : undefined;
    }
    const k = sliceOf(t);
    const g = e.groups.get(k);
    if (g?.objects[0] !== undefined) return { records: upTo(dense(g), t), group: g, gap: false };
    if (e.missing.has(k) && !this.#queue.some((j) => j.entry === e && j.group === k))
      return { records: [], group: undefined, gap: true };
    const prev = e.groups.get(k - 1);
    if (prev?.objects[0] !== undefined) return { records: dense(prev).flat(), group: prev, gap: false };
    return undefined;
  }

  #deckGroup(deck: number): Group | undefined {
    const e = this.#entries.get("deck");
    if (!e?.active) return undefined;
    const g = e.groups.get(deck);
    if (g?.objects[0] !== undefined) return g;
    this.#needDeck(e, deck);
    return undefined;
  }

  #needDeck(e: Entry, deck: number): void {
    if (this.#queue.some((j) => j.entry === e && j.group === deck)) return;
    // The latest deck comes on the live subscription: give it a moment before fetching.
    if (e.sub && e.newestLive === undefined && this.#now() - (e.subscribedAt ?? 0) < JOIN_GRACE_MS) return;
    if (e.newestLive === deck) return;
    const missedAt = e.missing.get(deck);
    if (missedAt !== undefined && this.#now() - missedAt < this.#retryMissing) return;
    this.#enqueue(e, deck, "deck");
    this.#pump();
  }

  // --- subscriptions --------------------------------------------------------------------------------------------

  /** Which tracks the room has: those its catalog lists, or before a catalog the speaker's and the room's. */
  #listed(spec: Spec): boolean {
    const catalog = this.#catalog();
    const events = catalog?.tracks.filter((t) => this.#isOurs(t.namespace, t.name)) ?? [];
    if (events.length === 0) return spec.path === slidesPath(this.room) || spec.id === "room";
    return events.some((t) => t.namespace === spec.path && t.name === spec.track);
  }

  #isOurs(namespace: string, name: string): boolean {
    for (const e of this.#entries.values()) if (e.spec.path === namespace && e.spec.track === name) return true;
    return false;
  }

  #sync(): void {
    for (const e of this.#entries.values()) {
      const active = this.#wanted.has(e.spec.id) && this.#listed(e.spec);
      if (active === e.active) continue;
      e.active = active;
      if (active) {
        e.subscribedAt = this.#now();
        e.sub = this.#source.subscribe(
          e.spec.path,
          e.spec.track,
          ({ group, index, payload }) => this.#onLive(e, group, index, payload),
          { priority: e.spec.priority },
        );
      } else {
        e.sub?.close();
        e.sub = undefined;
        e.subscribedAt = undefined;
        e.newestLive = undefined;
        e.groups.clear();
        e.missing.clear();
        if (e.spec.id === "slide") this.#lastAt = undefined;
        for (const job of this.#queue.filter((j) => j.entry === e)) this.#cancel(job);
      }
      this.#changed();
    }
  }

  #onLive(e: Entry, group: number, index: number, payload: Uint8Array): void {
    if (!e.active || this.#closed) return;
    const records = this.#parse(e, payload);
    let g = e.groups.get(group);
    if (!g || (g.origin === "fetch" && index === 0)) {
      // A live copy is the same group as a fetched one (objects are immutable): its object 0 starts it over.
      g = { objects: [], origin: "live", partial: false, version: 0 };
      e.groups.set(group, g);
    } else if (g.origin === "fetch") {
      g.origin = "live";
      g.partial = false;
    }
    g.objects[index] = records;
    g.version++;
    e.seen = true;
    e.missing.delete(group);
    if (e.newestLive === undefined || group > e.newestLive) e.newestLive = group;
    this.#trim(e);
    // The frame loop picks up ink, marks and the laser by itself; renders need slide, room and deck changes.
    if (e.spec.id === "slide" || e.spec.id === "room" || e.spec.id === "deck") this.#changed();
  }

  #parse(e: Entry, payload: Uint8Array): readonly Rec[] {
    const parsed = e.spec.parse(payload);
    if (parsed.ok) return parsed.value;
    console.warn(
      `dropping an object of ${e.spec.path}/${e.spec.track} that does not match the contract: ${parsed.error}`,
    );
    return [];
  }

  /** Keep at most `maxGroups` groups of a sliced track, the farthest from the playhead going first; never the newest live one. */
  #trim(e: Entry): void {
    if (!e.spec.sliced || e.groups.size <= this.#maxGroups) return;
    const around = this.#t === undefined ? (e.newestLive ?? 0) : sliceOf(this.#t);
    const far = [...e.groups.keys()]
      .filter((k) => k !== e.newestLive)
      .sort((a, b) => Math.abs(b - around) - Math.abs(a - around));
    for (const k of far.slice(0, e.groups.size - this.#maxGroups)) e.groups.delete(k);
  }

  // --- fetching -------------------------------------------------------------------------------------------------

  #edgeSlice(): number | undefined {
    return this.#edge === undefined ? undefined : sliceOf(Math.max(0, this.#edge - 1));
  }

  /** Queue the groups the playhead needs that are neither held, coming live, nor in flight; cancel the rest. */
  #plan(moved = false): void {
    if (this.#closed) return;
    this.#plannedAt = this.#now();
    this.#sync();
    const t = this.#t;
    const edge = this.#edgeSlice();
    const wanted: [Entry, number][] = [];
    for (const id of FETCH_ORDER) {
      const e = this.#entries.get(id);
      if (!e?.active || !e.spec.sliced) continue;
      let ks: number[];
      if (t === undefined) ks = edge === undefined ? [] : [edge];
      else {
        const k = sliceOf(t);
        ks = [k];
        if (this.#mode === "rewound" && t - k * SLICE_MS > SLICE_MS - PREFETCH_MS) ks.push(k + 1);
      }
      for (const k of ks) if (k >= 0 && (edge === undefined || k <= edge)) wanted.push([e, k]);
    }
    // A seek cancels what the playhead no longer needs; previews and decks finish.
    if (moved)
      for (const job of [...this.#queue])
        if (job.kind === "play" && !wanted.some(([e, k]) => e === job.entry && k === job.group)) this.#cancel(job);
    for (const [e, k] of wanted) if (this.#needs(e, k, edge)) this.#enqueue(e, k, "play");
    this.#pump();
  }

  #needs(e: Entry, k: number, edge: number | undefined): boolean {
    const g = e.groups.get(k);
    const whole = g?.objects[0] !== undefined && !(g.partial && edge !== undefined && k < edge);
    if (whole) return false;
    if (this.#queue.some((j) => j.entry === e && j.group === k)) return false;
    if (e.sub && g?.origin !== "live") {
      // The subscription delivers its first group and every later one: only what came before it is fetched. A
      // new subscription's first group (the one at the edge) is on its way for a moment.
      if (e.newestLive !== undefined) {
        if (k > e.newestLive) return false;
      } else if ((edge === undefined || k >= edge) && this.#now() - (e.subscribedAt ?? 0) < JOIN_GRACE_MS) return false;
    }
    const missedAt = e.missing.get(k);
    return missedAt === undefined || this.#now() - missedAt >= this.#retryMissing;
  }

  #enqueue(entry: Entry, group: number, kind: Job["kind"]): void {
    this.#queue.push({ entry, group, kind, controller: new AbortController(), running: false });
  }

  #pump(): void {
    while (!this.#closed) {
      const running = this.#queue.filter((j) => j.running).length;
      const next = this.#queue.find((j) => !j.running);
      if (!next || running >= this.#maxInFlight) return;
      next.running = true;
      void this.#run(next);
    }
  }

  async #run(job: Job): Promise<void> {
    const { entry: e, group } = job;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      job.controller.abort(new NotFound(`${e.spec.track} group ${group}: no answer in ${this.#fetchTimeout} ms`));
    }, this.#fetchTimeout);
    try {
      const fetch = (path: string) =>
        Promise.race([
          this.#source.fetchGroup(path, e.spec.track, group, {
            priority: FETCH_PRIORITY,
            signal: job.controller.signal,
          }),
          abortion(job.controller.signal),
        ]);
      let objects: Uint8Array[];
      try {
        objects = await fetch(e.spec.history);
      } catch (err) {
        // A deck may be reachable on the live name too (a looped room publishes both; the relay caches).
        if (!(err instanceof NotFound) || e.spec.history === e.spec.path || job.kind !== "deck") throw err;
        objects = await fetch(e.spec.path);
      }
      if (job.controller.signal.aborted || !e.active) return;
      const edge = this.#edgeSlice();
      const parsed = objects.map((p) => this.#parse(e, p));
      const held = e.groups.get(group);
      if (held?.origin === "live") {
        parsed.forEach((o, i) => {
          if (held.objects[i] === undefined) held.objects[i] = o;
        });
        held.version++;
      } else {
        const partial = e.spec.sliced && (edge === undefined || group >= edge);
        e.groups.set(group, { objects: parsed, origin: "fetch", partial, version: (held?.version ?? 0) + 1 });
      }
      e.seen = true;
      e.missing.delete(group);
      this.#trim(e);
    } catch (err) {
      if (job.controller.signal.aborted && !timedOut) return;
      if (!(err instanceof NotFound))
        console.warn(`fetch ${e.spec.history}/${e.spec.track} group ${group} failed`, err);
      e.missing.set(group, this.#now());
    } finally {
      clearTimeout(timer);
      this.#remove(job);
      this.#changed();
      this.#pump();
    }
  }

  #cancel(job: Job): void {
    job.controller.abort();
    this.#remove(job);
  }

  #remove(job: Job): void {
    const i = this.#queue.indexOf(job);
    if (i >= 0) this.#queue.splice(i, 1);
  }

  #changed(): void {
    this.#version++;
    if (this.#notifyQueued) return;
    this.#notifyQueued = true;
    queueMicrotask(() => {
      this.#notifyQueued = false;
      for (const fn of [...this.#listeners]) fn();
    });
  }
}

/** A group's objects in order, without the holes of objects not arrived yet. */
function dense(g: Group): (readonly Rec[])[] {
  return g.objects.filter((o): o is readonly Rec[] => o !== undefined);
}

/**
 * The laser at t from the pointer records in effect (`upTo`): the last `at`, or null after `off`. With the next
 * sample of the same group known (rewound), the position is interpolated between the two when they are close.
 */
export function laserAt(
  records: readonly PointerRecord[],
  t: number | undefined,
  objects: readonly (readonly Rec[])[] = [],
): { x: number; y: number } | null {
  const last = records.at(-1);
  if (!last || last.data.kind !== "at") return null;
  const here = { x: last.data.x, y: last.data.y };
  if (t === undefined) return here;
  const next = (objects.flat() as PointerRecord[]).find((r) => r.m > t);
  if (!next || next.data.kind !== "at" || next.m - last.m > 200 || next.m <= last.m) return here;
  const f = (t - last.m) / (next.m - last.m);
  return { x: here.x + (next.data.x - here.x) * f, y: here.y + (next.data.y - here.y) * f };
}

function imageUrl(image: DeckImage): string {
  try {
    const binary = atob(image.data_b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: image.mime }));
  } catch {
    return `data:${image.mime};base64,${image.data_b64}`;
  }
}

function abortion(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
