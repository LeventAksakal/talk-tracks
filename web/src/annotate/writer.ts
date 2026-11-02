// A listener's (or the speaker's) annotations as writes to the room service (decisions 0021, 0024): a stroke is a
// begin, points batched about every 50 ms, and an end, in order on one socket; a shape is sent whole, again with the
// same id while it is dragged (at most every 50 ms); a text mark is made whole; the eraser, unmark and clear name
// what to remove, and the room service keeps what `mayChange` does not allow. Every write's `by` is stamped by the
// service, never sent.
//
// Undo and redo (per slide, one's own work only) keep a history here, but what they do goes out as ordinary records,
// as the console's do (container-formats §3): undoing a new element erases it, redoing it or undoing an erase or a
// clear re-sends the elements whole, so a replay or a late joiner sees exactly what the room saw.

import type {
  InkElement,
  InkShape,
  InkStroke,
  InkTool,
  Point,
  ShapeKind,
  ShowSlide,
  TextMark,
  TextRange,
} from "../contracts/types";
import type { Ack, RoomService, WriteError } from "./client";

/** Points of a stroke being drawn, and a shape being dragged, go out at most this often. */
export const BATCH_MS = 50;
export const PEN_WIDTH = 0.004;
export const HIGHLIGHTER_WIDTH = 0.022;
/** A shape needs a drag this long (a fraction of the slide) to be drawn at all: a click draws nothing. */
export const MIN_SHAPE_DRAG = 0.004;
/** Undo steps kept per slide. */
const UNDO_DEPTH = 100;

const round = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000;
const pt = ([x, y]: Point): Point => [round(x), round(y)];

/** A short random id part; the room service wants a listener's stroke and mark ids to start with `<id>:`. */
export function randomPart(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type OnError = (e: WriteError) => void;

export interface ShapeStyle {
  shape: ShapeKind;
  color: string;
  width: number;
}

/** What one step added and removed on a slide: elements and marks, whole. */
interface Work {
  elements: InkElement[];
  marks: TextMark[];
}
interface Edit {
  added: Work;
  removed: Work;
}
const noWork = (): Work => ({ elements: [], marks: [] });
const emptyEdit = (): Edit => ({ added: noWork(), removed: noWork() });
const isEmpty = (e: Edit) =>
  !e.added.elements.length && !e.added.marks.length && !e.removed.elements.length && !e.removed.marks.length;
const slideKey = (on: { deck: number; index: number }) => `${on.deck}:${on.index}`;

/** An element as it goes out again: whole (a stroke done), without `by`, which the service stamps. */
function wireElement(el: InkElement): object {
  const { by: _by, ...rest } = el;
  return rest.kind === "stroke" ? { ...rest, done: true } : { ...rest };
}
function wireMark(k: TextMark): object {
  const { by: _by, ...rest } = k;
  return rest;
}

/**
 * Writes the annotations of one person. `draft` strokes are what this browser draws itself until they come back
 * on the track (one round trip later).
 */
export class AnnotationWriter {
  #service: RoomService;
  #onError: OnError;
  #clock: () => number;
  #drawing: { data: InkStroke; pending: Point[]; sentAt: number } | undefined;
  #shaping: { data: InkShape; sentAt: number; sent: Point | undefined } | undefined;
  #history = new Map<string, { undo: Edit[]; redo: Edit[] }>();
  #pending: Edit | undefined;
  /** Called when what can be undone or redone changes. */
  onChange: (() => void) | undefined;

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

  /** The shape being dragged here, if any. */
  shaping(): InkShape | undefined {
    return this.#shaping?.data;
  }

  #author() {
    const me = this.#service.me();
    if (!me?.name || !this.ready()) return undefined;
    return { id: me.id, by: { id: me.id, name: me.name, ...(me.speaker ? { speaker: true } : {}) } };
  }

  begin(on: ShowSlide, tool: InkTool, color: string, p: Point, width?: number): InkStroke | undefined {
    const me = this.#author();
    if (!me) return undefined;
    if (this.#drawing) this.end();
    const first = pt(p);
    const data: InkStroke = {
      kind: "stroke",
      stroke: `${me.id}:${randomPart()}`,
      deck: on.deck,
      index: on.index,
      tool,
      color,
      width: width ?? (tool === "highlighter" ? HIGHLIGHTER_WIDTH : PEN_WIDTH),
      points: [first],
      by: me.by,
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
    this.#record({ ...emptyEdit(), added: { elements: [{ ...d.data, points: [...d.data.points] }], marks: [] } });
    return d.data;
  }

  /**
   * Start dragging a shape from `start`. Nothing goes out until the drag is long enough; the draft's `end`
   * follows `shapeTo`.
   */
  beginShape(on: ShowSlide, style: ShapeStyle, start: Point): InkShape | undefined {
    const me = this.#author();
    if (!me) return undefined;
    if (this.#shaping) this.endShape();
    const from = pt(start);
    const data: InkShape = {
      kind: "shape",
      stroke: `${me.id}:${randomPart()}`,
      deck: on.deck,
      index: on.index,
      shape: style.shape,
      start: from,
      end: from,
      color: style.color,
      width: style.width,
      by: me.by,
    };
    this.#shaping = { data, sentAt: -Infinity, sent: undefined };
    return data;
  }

  /** Move the dragged shape's end: sent whole when the drag is long enough, at most every BATCH_MS. */
  shapeTo(end: Point): void {
    const s = this.#shaping;
    if (!s) return;
    s.data.end = pt(end);
    if (this.#clock() - s.sentAt >= BATCH_MS) this.#sendShape();
  }

  /** The drag is over: the shape as it went out last, or undefined when it was too short to draw. */
  endShape(end?: Point): InkShape | undefined {
    const s = this.#shaping;
    if (!s) return undefined;
    if (end) s.data.end = pt(end);
    this.#sendShape();
    this.#shaping = undefined;
    if (!s.sent) return undefined;
    this.#record({ ...emptyEdit(), added: { elements: [{ ...s.data }], marks: [] } });
    return s.data;
  }

  #sendShape(): void {
    const s = this.#shaping;
    if (!s) return;
    const { start, end } = s.data;
    if (!s.sent && Math.hypot(end[0] - start[0], end[1] - start[1]) < MIN_SHAPE_DRAG) return;
    if (s.sent && s.sent[0] === end[0] && s.sent[1] === end[1]) return;
    this.#send("ink", wireElement(s.data));
    s.sent = end;
    s.sentAt = this.#clock();
  }

  mark(on: ShowSlide, style: TextMark["style"], color: string, span: TextRange): string | undefined {
    const me = this.#author();
    if (!me) return undefined;
    const data: TextMark = {
      kind: "mark",
      id: `${me.id}:${randomPart()}`,
      deck: on.deck,
      index: on.index,
      style,
      color,
      span,
      by: me.by,
    };
    this.#send("marks", wireMark(data));
    this.#record({ ...emptyEdit(), added: { elements: [], marks: [data] } });
    return data.id;
  }

  /** Erase strokes and shapes by id; `removed`, their elements whole, lets undo bring them back. */
  erase(strokes: readonly string[], removed: readonly InkElement[] = []): void {
    if (!strokes.length) return;
    this.#send("ink", { kind: "erase", strokes: [...strokes] });
    this.#record({
      ...emptyEdit(),
      removed: { elements: removed.filter((e) => strokes.includes(e.stroke)), marks: [] },
    });
  }

  /** Remove text marks by id; `removed`, the marks whole, lets undo bring them back. */
  unmark(marks: readonly string[], removed: readonly TextMark[] = []): void {
    if (!marks.length) return;
    this.#send("marks", { kind: "unmark", marks: [...marks] });
    this.#record({ ...emptyEdit(), removed: { elements: [], marks: removed.filter((k) => marks.includes(k.id)) } });
  }

  /**
   * Removes one's own strokes and marks on the slide (the speaker's: everyone's); `removed`, what that takes away,
   * lets undo bring it back.
   */
  clear(on: ShowSlide, removed: { elements?: readonly InkElement[]; marks?: readonly TextMark[] } = {}): void {
    this.#send("ink", { kind: "clear", deck: on.deck, index: on.index });
    this.#send("marks", { kind: "clear", deck: on.deck, index: on.index });
    this.#record(
      { ...emptyEdit(), removed: { elements: [...(removed.elements ?? [])], marks: [...(removed.marks ?? [])] } },
      on,
    );
  }

  // --- undo and redo -------------------------------------------------------------------------------------------

  /** Collect what follows into one undo step (an eraser drag), until endEdit. */
  startEdit(): void {
    this.#pending ??= emptyEdit();
  }

  endEdit(): void {
    const edit = this.#pending;
    this.#pending = undefined;
    if (edit && !isEmpty(edit)) this.#push(edit);
  }

  canUndo(on: { deck: number; index: number } | null | undefined): boolean {
    return !!on && !!this.#history.get(slideKey(on))?.undo.length;
  }

  canRedo(on: { deck: number; index: number } | null | undefined): boolean {
    return !!on && !!this.#history.get(slideKey(on))?.redo.length;
  }

  /** Undo one's newest step on this slide: erase what it added, re-send what it removed. */
  undo(on: ShowSlide): void {
    const stacks = this.#history.get(slideKey(on));
    const edit = stacks?.undo.pop();
    if (!stacks || !edit || !this.ready()) {
      if (edit) stacks?.undo.push(edit);
      return;
    }
    this.#apply(edit.removed, edit.added);
    stacks.redo.push(edit);
    this.onChange?.();
  }

  /** Redo the step undone last on this slide. */
  redo(on: ShowSlide): void {
    const stacks = this.#history.get(slideKey(on));
    const edit = stacks?.redo.pop();
    if (!stacks || !edit || !this.ready()) {
      if (edit) stacks?.redo.push(edit);
      return;
    }
    this.#apply(edit.added, edit.removed);
    stacks.undo.push(edit);
    this.onChange?.();
  }

  /** The writes an undo or a redo makes: erase and unmark `drop`, re-send `restore` whole. */
  #apply(restore: Work, drop: Work): void {
    const strokes = drop.elements.map((e) => e.stroke);
    const marks = drop.marks.map((k) => k.id);
    if (strokes.length) this.#send("ink", { kind: "erase", strokes });
    if (marks.length) this.#send("marks", { kind: "unmark", marks });
    for (const el of restore.elements) this.#send("ink", wireElement(el));
    for (const k of restore.marks) this.#send("marks", wireMark(k));
  }

  /** A new step: into the gesture's edit, or onto its slide's stack (which drops that slide's redo). */
  #record(edit: Edit, on?: { deck: number; index: number }): void {
    if (isEmpty(edit)) return;
    if (!this.#pending) return this.#push(edit, on);
    this.#pending.added.elements.push(...edit.added.elements);
    this.#pending.added.marks.push(...edit.added.marks);
    this.#pending.removed.elements.push(...edit.removed.elements);
    this.#pending.removed.marks.push(...edit.removed.marks);
  }

  #push(edit: Edit, on?: { deck: number; index: number }): void {
    const where =
      on ?? edit.added.elements[0] ?? edit.added.marks[0] ?? edit.removed.elements[0] ?? edit.removed.marks[0];
    if (!where) return;
    const key = slideKey(where);
    let stacks = this.#history.get(key);
    if (!stacks) this.#history.set(key, (stacks = { undo: [], redo: [] }));
    stacks.undo.push(edit);
    if (stacks.undo.length > UNDO_DEPTH) stacks.undo.shift();
    stacks.redo = [];
    this.onChange?.();
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
