// The speaker's slide broadcast, talk/<room>/slides (decisions 0018, 0021): deck, slide, ink, marks,
// pointer and frames, written as the contracts lane defined them (lane-briefs §Namespaces,
// wiki/design/container-formats.md).
//
// The publisher keeps the deck's state (the slide shown, the strokes and marks on every slide, the
// laser) and projects it onto the wire. The sliced tracks get group k = room slice [4k, 4k+4) s:
// object 0 is the carry-in built by the contract's own reducers (tracks.ts), objects 1.. the records
// as they happen. A slide shown re-sends its strokes and marks (m = that moment), so one group is
// always enough to draw it. Before the room clock is known nothing is written; what the speaker does
// meanwhile is kept and goes out as the first carry-in.

import { DECK_TRACK, FRAMES_TRACK, INK_TRACK, MARKS_TRACK, POINTER_TRACK, SLIDE_TRACK } from "../contracts/names";
import { currentSlide, inkCarry, inkStrokes, marksCarry, textMarks } from "../contracts/tracks";
import type { StrokeRecord, TextMarkRecord } from "../contracts/tracks";
import {
  sliceOf,
  type Author,
  type CurrentSlideRecord,
  type DeckImage,
  type DeckInfo,
  type InkRecord,
  type InkTool,
  type MarkRecord,
  type Point,
  type PointerRecord,
  type ShowSlide,
  type SlideFrame,
  type TextMark,
  type TextRange,
} from "../contracts/types";
import type { BroadcastSink, GroupSink, TrackSink } from "./sink";

/** How long a non-newest slice group stays with the publisher (the relay keeps its own ~30 s). */
export const SLICE_RETAIN_MS = 30_000;
/** A deck group is read by id for the whole talk. */
export const DECK_RETAIN_MS = 12 * 3_600_000;

type Sliced = "slide" | "ink" | "marks" | "pointer";
const SLICED: Record<Sliced, string> = {
  slide: SLIDE_TRACK,
  ink: INK_TRACK,
  marks: MARKS_TRACK,
  pointer: POINTER_TRACK,
};

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const fraction = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000;
const point = ([x, y]: Point): Point => [fraction(x), fraction(y)];

function randomTag(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("");
}

export interface StrokeStyle {
  tool: InkTool;
  color: string;
  /** Fraction of the slide's width. */
  width: number;
}

/** What the console shows of the deck's state. */
export interface SlideState {
  deck: number | undefined;
  shown: ShowSlide | null;
  strokes: StrokeRecord[];
  marks: TextMarkRecord[];
  pointer: PointerRecord | undefined;
}

export class SlidesPublisher {
  /** Stamped on every mutation. */
  #author: Author;
  /** Distinguishes this console's ids (strokes, marks) from an earlier page load's. */
  readonly tag: string;
  #sink: BroadcastSink;
  #seq = 0;
  #now: (() => number) | undefined;
  #lastM = 0;

  #deck: { id: number; info: DeckInfo; images: Map<number, DeckImage> } | undefined;
  #slide: CurrentSlideRecord | undefined;
  #ink = new Map<string, StrokeRecord>();
  #marks = new Map<string, TextMarkRecord>();
  #pointer: PointerRecord | undefined;

  #tracks: (Record<Sliced, TrackSink> & { deck: TrackSink; frames: TrackSink }) | undefined;
  #open: number | undefined;
  #groups: Partial<Record<Sliced, GroupSink>> = {};
  #deckGroup: GroupSink | undefined;
  #lastFrameGroup = -1;
  #listeners = new Set<() => void>();
  #closed = false;

  constructor(sink: BroadcastSink, author: Author, tag = randomTag()) {
    this.#sink = sink;
    this.#author = author;
    this.tag = tag;
  }

  get author(): Author {
    return this.#author;
  }

  /** The speaker's display name on what they draw from now on (same author id). */
  setAuthorName(name: string): void {
    this.#author = { ...this.#author, name };
  }

  get live(): boolean {
    return this.#now !== undefined;
  }

  get deckId(): number | undefined {
    return this.#deck?.id;
  }

  /** Called on every state change (to redraw). */
  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  state(): SlideState {
    const shown = this.#shown();
    return {
      deck: this.#deck?.id,
      shown,
      strokes: inkCarry(this.#ink.values(), shown),
      marks: marksCarry(this.#marks.values(), shown),
      pointer: this.#pointer,
    };
  }

  /** The strokes and marks kept on one slide (for thumbnails and the eraser). */
  slideState(deck: number, index: number): { strokes: StrokeRecord[]; marks: TextMarkRecord[] } {
    const on: ShowSlide = { kind: "show", deck, index };
    return { strokes: inkCarry(this.#ink.values(), on), marks: marksCarry(this.#marks.values(), on) };
  }

  /**
   * Start writing, on this room clock. Whatever the speaker did before goes out as the first slice's
   * carry-in, stamped now; a deck loaded before gets its id now (the slice it went out in).
   */
  goLive(now: () => number): void {
    if (this.#closed || this.#now) return;
    this.#now = now;
    const m = this.#time();
    this.#tracks = {
      deck: this.#sink.track(DECK_TRACK, DECK_RETAIN_MS),
      frames: this.#sink.track(FRAMES_TRACK, SLICE_RETAIN_MS),
      slide: this.#sink.track(SLIDE_TRACK, SLICE_RETAIN_MS),
      ink: this.#sink.track(INK_TRACK, SLICE_RETAIN_MS),
      marks: this.#sink.track(MARKS_TRACK, SLICE_RETAIN_MS),
      pointer: this.#sink.track(POINTER_TRACK, SLICE_RETAIN_MS),
    };
    if (this.#deck) {
      this.#rekey(this.#deck.id, sliceOf(m));
      this.#openDeckGroup(m);
    }
    this.#slide = this.#slide && { ...this.#slide, m };
    this.#ink = new Map([...this.#ink].map(([id, s]) => [id, { ...s, m }]));
    this.#marks = new Map([...this.#marks].map(([id, k]) => [id, { ...k, m }]));
    this.#pointer = undefined;
    this.#roll(m);
  }

  /** Open the next slice when its time has come, so every slice has its object 0 while live. */
  tick(): void {
    if (this.#now && !this.#closed) this.#roll(this.#time());
  }

  close(): void {
    this.stop();
  }

  /** End of every open group and track: the talk ended or the page is going away. */
  stop(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const g of Object.values(this.#groups)) g.close();
    this.#deckGroup?.close();
    if (this.#tracks) for (const t of Object.values(this.#tracks)) t.close();
    this.#sink.close();
  }

  // --- the deck ----------------------------------------------------------------------------------

  /** A new deck: its group (= its id) opens with the DeckInfo; images follow with addImage. */
  loadDeck(info: DeckInfo): number {
    const m = this.#stamp();
    const previous = this.#deck?.id ?? -1;
    if (!this.live) {
      // Nothing of a deck loaded before going on air was published: replace it whole.
      this.#ink.clear();
      this.#marks.clear();
      this.#slide = undefined;
    }
    const id = this.live ? Math.max(sliceOf(m), previous + 1) : previous + 1;
    this.#deck = { id, info, images: new Map() };
    if (this.live) this.#openDeckGroup(m);
    this.#changed();
    return id;
  }

  /** A slide image (with its text runs), published before its slide is first shown. */
  addImage(image: DeckImage): void {
    if (!this.#deck) throw new Error("no deck loaded");
    this.#deck.images.set(image.index, image);
    if (this.live) this.#deckGroup?.write(encode([{ m: this.#stamp(), data: image }]));
  }

  hasImage(index: number): boolean {
    return this.#deck?.images.has(index) ?? false;
  }

  // --- the slide shown ---------------------------------------------------------------------------

  /** Show a slide of the current deck, and re-send the strokes and marks it keeps. */
  show(index: number): void {
    const deck = this.#deck;
    if (!deck || index < 0 || index >= deck.info.count) return;
    const m = this.#stamp();
    const data: ShowSlide = { kind: "show", deck: deck.id, index };
    this.#slide = { m, data };
    this.#write("slide", [this.#slide]);
    const { strokes, marks } = this.slideState(deck.id, index);
    const strokeRecords = strokes.map((s) => ({ m, data: { ...s.data, done: true } }));
    const markRecords = marks.map((k) => ({ m, data: k.data }));
    this.#applyInk(strokeRecords);
    this.#applyMarks(markRecords);
    if (strokeRecords.length) this.#write("ink", strokeRecords);
    if (markRecords.length) this.#write("marks", markRecords);
    this.#changed();
  }

  /** Stop showing slides (a black screen); showing again re-sends as usual. */
  hide(): void {
    if (!this.#shown()) return;
    const m = this.#stamp();
    this.#slide = { m, data: { kind: "hide" } };
    this.#write("slide", [this.#slide]);
    this.#changed();
  }

  /** The picture of the slide on screen for the describe agent (talk/<room>/slides `frames`). */
  publishFrame(frame: Omit<SlideFrame, "id">): void {
    if (!this.#tracks) return;
    const group = Math.max(this.#lastFrameGroup + 1, sliceOf(this.#time()));
    this.#lastFrameGroup = group;
    const g = this.#tracks.frames.group(group);
    g.write(encode({ ...frame, id: group }));
    g.close();
  }

  // --- the pencil (ink) --------------------------------------------------------------------------

  /** Start a stroke on the slide shown; its id, or undefined with no slide on screen. */
  beginStroke(style: StrokeStyle, first: Point): string | undefined {
    const on = this.#shown();
    if (!on) return undefined;
    const stroke = this.#id("s");
    const r: InkRecord = {
      m: this.#stamp(),
      data: {
        kind: "begin",
        stroke,
        deck: on.deck,
        index: on.index,
        tool: style.tool,
        color: style.color,
        width: Math.min(1, Math.max(0.0005, style.width)),
        points: [point(first)],
        by: this.#author,
      },
    };
    this.#applyInk([r]);
    this.#write("ink", [r]);
    this.#changed();
    return stroke;
  }

  addPoints(stroke: string, points: Point[]): void {
    if (!points.length || !this.#ink.has(stroke)) return;
    const r: InkRecord = { m: this.#stamp(), data: { kind: "points", stroke, points: points.map(point) } };
    this.#applyInk([r]);
    this.#write("ink", [r]);
    this.#changed();
  }

  endStroke(stroke: string): void {
    if (!this.#ink.has(stroke)) return;
    const r: InkRecord = { m: this.#stamp(), data: { kind: "end", stroke } };
    this.#applyInk([r]);
    this.#write("ink", [r]);
    this.#changed();
  }

  /** Remove strokes and marks (the eraser). */
  erase(strokes: string[], marks: string[]): void {
    const s = strokes.filter((id) => this.#ink.has(id));
    const k = marks.filter((id) => this.#marks.has(id));
    if (!s.length && !k.length) return;
    const m = this.#stamp();
    if (s.length) {
      const r: InkRecord = { m, data: { kind: "erase", strokes: s, by: this.#author } };
      this.#applyInk([r]);
      this.#write("ink", [r]);
    }
    if (k.length) {
      const r: MarkRecord = { m, data: { kind: "unmark", marks: k, by: this.#author } };
      this.#applyMarks([r]);
      this.#write("marks", [r]);
    }
    this.#changed();
  }

  /** Clear the slide on screen: its strokes and its text marks. */
  clearSlide(): void {
    const on = this.#shown();
    if (!on) return;
    const m = this.#stamp();
    const where = { deck: on.deck, index: on.index, by: this.#author };
    const ink: InkRecord = { m, data: { kind: "clear", ...where } };
    const marks: MarkRecord = { m, data: { kind: "clear", ...where } };
    this.#applyInk([ink]);
    this.#applyMarks([marks]);
    this.#write("ink", [ink]);
    this.#write("marks", [marks]);
    this.#changed();
  }

  // --- text marks --------------------------------------------------------------------------------

  /** Underline or highlight a range of the shown slide's text; the mark's id. */
  mark(style: TextMark["style"], color: string, span: TextRange): string | undefined {
    const on = this.#shown();
    if (!on || !span.length) return undefined;
    const id = this.#id("m");
    const r: MarkRecord = {
      m: this.#stamp(),
      data: { kind: "mark", id, deck: on.deck, index: on.index, style, color, span, by: this.#author },
    };
    this.#applyMarks([r]);
    this.#write("marks", [r]);
    this.#changed();
    return id;
  }

  // --- the laser (pointer) -----------------------------------------------------------------------

  pointerAt(x: number, y: number): void {
    this.#pointer = { m: this.#stamp(), data: { kind: "at", x: fraction(x), y: fraction(y) } };
    this.#write("pointer", [this.#pointer]);
    this.#changed();
  }

  pointerOff(): void {
    if (!this.#pointer || this.#pointer.data.kind === "off") return;
    this.#pointer = { m: this.#stamp(), data: { kind: "off" } };
    this.#write("pointer", [this.#pointer]);
    this.#changed();
  }

  // --- internals ---------------------------------------------------------------------------------

  #shown(): ShowSlide | null {
    return currentSlide(this.#slide ? [this.#slide] : []);
  }

  #id(kind: "s" | "m"): string {
    return `sp-${this.tag}-${kind}${this.#seq++}`;
  }

  #applyInk(records: InkRecord[]): void {
    this.#ink = inkStrokes([...this.#ink.values(), ...records]);
  }

  #applyMarks(records: MarkRecord[]): void {
    this.#marks = textMarks([...this.#marks.values(), ...records]);
  }

  /** Room ms now, never earlier than a record already written. */
  #time(): number {
    if (!this.#now) return 0;
    this.#lastM = Math.max(this.#lastM, Math.trunc(this.#now()));
    return this.#lastM;
  }

  /** The m of a new record, after opening its slice. */
  #stamp(): number {
    const m = this.#time();
    if (this.#now) this.#roll(m);
    return m;
  }

  #roll(m: number): void {
    const k = sliceOf(m);
    if (!this.#tracks || this.#open === k) return;
    for (const g of Object.values(this.#groups)) g.close();
    this.#open = k;
    const shown = this.#shown();
    const carry: Record<Sliced, unknown[]> = {
      slide: this.#slide ? [this.#slide] : [],
      ink: inkCarry(this.#ink.values(), shown),
      marks: marksCarry(this.#marks.values(), shown),
      pointer: this.#pointer ? [this.#pointer] : [],
    };
    for (const name of Object.keys(SLICED) as Sliced[]) {
      const g = this.#tracks[name].group(k);
      g.write(encode(carry[name]));
      this.#groups[name] = g;
    }
  }

  #write(track: Sliced, records: unknown[]): void {
    if (this.live) this.#groups[track]?.write(encode(records));
  }

  #openDeckGroup(m: number): void {
    const deck = this.#deck;
    if (!deck || !this.#tracks) return;
    this.#deckGroup?.close();
    this.#deckGroup = this.#tracks.deck.group(deck.id);
    this.#deckGroup.write(encode([{ m, data: deck.info }]));
    for (const image of [...deck.images.values()].sort((a, b) => a.index - b.index)) {
      this.#deckGroup.write(encode([{ m, data: image }]));
    }
  }

  /** Give the deck loaded before going on air its id, in every record that names it. */
  #rekey(from: number, to: number): void {
    if (!this.#deck || from === to) return;
    this.#deck = { ...this.#deck, id: to };
    if (this.#slide?.data.kind === "show" && this.#slide.data.deck === from) {
      this.#slide = { ...this.#slide, data: { ...this.#slide.data, deck: to } };
    }
    for (const [id, s] of this.#ink)
      if (s.data.deck === from) this.#ink.set(id, { ...s, data: { ...s.data, deck: to } });
    for (const [id, k] of this.#marks)
      if (k.data.deck === from) this.#marks.set(id, { ...k, data: { ...k.data, deck: to } });
  }

  #changed(): void {
    for (const fn of [...this.#listeners]) fn();
  }
}
