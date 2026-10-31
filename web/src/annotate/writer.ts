// A listener's (or the speaker's) annotations as writes to the room service (decisions 0021, 0024): a stroke is a
// begin, points batched about every 50 ms, and an end, in order on one socket; a text mark is made whole; the
// eraser, unmark and clear name what to remove, and the room service keeps what `mayChange` does not allow.
// Every write's `by` is stamped by the service, never sent.

import type { InkStroke, InkTool, Point, ShowSlide, TextMark, TextRange } from "../contracts/types";
import type { Ack, RoomService, WriteError } from "./client";

/** Points of a stroke being drawn go out at most this often. */
export const BATCH_MS = 50;
export const PEN_WIDTH = 0.004;
export const HIGHLIGHTER_WIDTH = 0.022;

const round = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000;
const pt = ([x, y]: Point): Point => [round(x), round(y)];

/** A short random id part; the room service wants a listener's stroke and mark ids to start with `<id>:`. */
export function randomPart(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type OnError = (e: WriteError) => void;

/**
 * Writes the annotations of one person. `draft` strokes are what this browser draws itself until they come back
 * on the track (one round trip later).
 */
export class AnnotationWriter {
  #service: RoomService;
  #onError: OnError;
  #clock: () => number;
  #drawing: { data: InkStroke; pending: Point[]; sentAt: number } | undefined;

  constructor(service: RoomService, onError: OnError, clock: () => number = () => performance.now()) {
    this.#service = service;
    this.#onError = onError;
    this.#clock = clock;
  }

  /** Whether writes can go out now: connected, with a display name. */
  ready(): boolean {
    return this.#service.status() === "open" && Boolean(this.#service.me()?.name);
  }

  /** The stroke being drawn here, as it will look once it comes back. */
  drawing(): InkStroke | undefined {
    return this.#drawing?.data;
  }

  begin(on: ShowSlide, tool: InkTool, color: string, p: Point): InkStroke | undefined {
    const me = this.#service.me();
    if (!me?.name || !this.ready()) return undefined;
    if (this.#drawing) this.end();
    const width = tool === "highlighter" ? HIGHLIGHTER_WIDTH : PEN_WIDTH;
    const first = pt(p);
    const data: InkStroke = {
      kind: "stroke",
      stroke: `${me.id}:${randomPart()}`,
      deck: on.deck,
      index: on.index,
      tool,
      color,
      width,
      points: [first],
      by: { id: me.id, name: me.name, ...(me.speaker ? { speaker: true } : {}) },
      done: false,
    };
    this.#drawing = { data, pending: [], sentAt: this.#clock() };
    const { kind: _kind, done: _done, by: _by, ...style } = data;
    this.#send("ink", { kind: "begin", ...style, points: [first] }); // the draft's points grow as it is drawn
    return data;
  }

  move(p: Point): void {
    const d = this.#drawing;
    if (!d) return;
    const q = pt(p);
    const last = d.data.points.at(-1);
    if (last && last[0] === q[0] && last[1] === q[1]) return;
    d.data.points.push(q);
    d.pending.push(q);
    if (this.#clock() - d.sentAt >= BATCH_MS) this.#flush();
  }

  /** The stroke drawn, done (undefined when none was being drawn). */
  end(): InkStroke | undefined {
    const d = this.#drawing;
    if (!d) return undefined;
    this.#flush();
    this.#send("ink", { kind: "end", stroke: d.data.stroke });
    this.#drawing = undefined;
    d.data.done = true;
    return d.data;
  }

  mark(on: ShowSlide, style: TextMark["style"], color: string, span: TextRange): string | undefined {
    const me = this.#service.me();
    if (!me?.name || !this.ready()) return undefined;
    const id = `${me.id}:${randomPart()}`;
    this.#send("marks", { kind: "mark", id, deck: on.deck, index: on.index, style, color, span });
    return id;
  }

  erase(strokes: readonly string[]): void {
    if (strokes.length) this.#send("ink", { kind: "erase", strokes: [...strokes] });
  }

  unmark(marks: readonly string[]): void {
    if (marks.length) this.#send("marks", { kind: "unmark", marks: [...marks] });
  }

  /** Removes one's own strokes and marks on the slide (the speaker's: everyone's). */
  clear(on: ShowSlide): void {
    this.#send("ink", { kind: "clear", deck: on.deck, index: on.index });
    this.#send("marks", { kind: "clear", deck: on.deck, index: on.index });
  }

  #flush(): void {
    const d = this.#drawing;
    if (!d || d.pending.length === 0) return;
    this.#send("ink", { kind: "points", stroke: d.data.stroke, points: d.pending });
    d.pending = [];
    d.sentAt = this.#clock();
  }

  #send(track: "ink" | "marks", data: object): Promise<Ack | undefined> {
    return this.#service.write(track, data).catch((e: WriteError) => {
      this.#onError(e);
      return undefined;
    });
  }
}
