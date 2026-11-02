// What the listener is doing on the slides (decision 0024): the annotation tools on the slide tile, a comment's
// anchor waiting in the Discussion composer, and the thread pointed at in the Discussion tab. A small store shared
// by the slide tile and the Discussion tab, which sit in different parts of the player.

import { useSyncExternalStore } from "react";
import { AnnotationWriter } from "../annotate/writer";
import type { RoomService, WriteError } from "../annotate/client";
import { SHAPES, type WidthStep } from "../canvas/tools";
import type { Anchor, InkElement, ShapeKind } from "../contracts/types";
import { type InkName, inkColor } from "../theme/ink";

export type ListenerTool = "pen" | "highlighter" | ShapeKind | "underline" | "highlight" | "eraser" | "comment";

export const isShape = (t: ListenerTool): t is ShapeKind => (SHAPES as readonly ListenerTool[]).includes(t);

/** Tools that change the slide: only on the live slide (a replay's slide is the past). */
export const DRAWING_TOOLS: readonly ListenerTool[] = [
  "pen",
  "highlighter",
  ...SHAPES,
  "underline",
  "highlight",
  "eraser",
];

/** Tools with a colour, and those with a stroke width too: their options open in a popover from the tool. */
export const hasColor = (t: ListenerTool) => t !== "eraser" && t !== "comment";
export const hasWidth = (t: ListenerTool) => t === "pen" || t === "highlighter" || isShape(t);

/** A listener pencil in the chalk box (brand.md §3); the speaker keeps the full box. */
export const LISTENER_INKS: readonly InkName[] = ["sky", "rose", "mint", "sun"];

export interface ListeningState {
  /** The tool bar is open on the slide tile. */
  annotating: boolean;
  tool: ListenerTool;
  color: string;
  /** Thin, medium or bold, for the pen, the marker and shapes (canvas/tools.ts WIDTHS). */
  width: WidthStep;
  /** The active tool's colour and width popover is open; it closes when you draw. */
  optionsOpen: boolean;
  /** A new comment's anchor, made with the comment tool, waiting in the Discussion composer. */
  anchor: Anchor | undefined;
  /** A thread pointed at in the Discussion tab: its anchor is outlined on the slide. */
  focus: string | undefined;
  /** Strokes and shapes drawn here, shown until they come back on the track. */
  drafts: InkElement[];
  /** The last write refused, in words. */
  error: string | undefined;
  /** The name prompt is open (writes need a display name). */
  askName: boolean;
  /** Bumped when what can be undone or redone changes. */
  history: number;
}

const INITIAL: ListeningState = {
  annotating: false,
  tool: "pen",
  color: inkColor(LISTENER_INKS[0]!),
  width: 1,
  optionsOpen: false,
  anchor: undefined,
  focus: undefined,
  drafts: [],
  error: undefined,
  askName: false,
  history: 0,
};

/** Drafts not echoed by then are dropped (a refused or lost write). */
const DRAFT_TTL_MS = 8_000;

const samePoint = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1];

export class Listening {
  readonly service: RoomService;
  readonly writer: AnnotationWriter;
  #state: ListeningState = INITIAL;
  #listeners = new Set<() => void>();
  #draftAt = new Map<string, number>();

  constructor(service: RoomService) {
    this.service = service;
    this.writer = new AnnotationWriter(service, (e) => this.refused(e));
    this.writer.onChange = () => this.set({ history: this.#state.history + 1 });
  }

  get = (): ListeningState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  set(change: Partial<ListeningState>): void {
    this.#state = { ...this.#state, ...change };
    for (const l of [...this.#listeners]) l();
  }

  refused(e: WriteError): void {
    if (e.code === "name") this.set({ askName: true });
    this.set({ error: e.message });
  }

  addDraft(element: InkElement): void {
    this.#draftAt.set(element.stroke, Date.now());
    this.set({ drafts: [...this.#state.drafts.filter((d) => d.stroke !== element.stroke), element] });
  }

  dropDraft(stroke: string): void {
    if (!this.#state.drafts.some((d) => d.stroke === stroke)) return;
    this.#draftAt.delete(stroke);
    this.set({ drafts: this.#state.drafts.filter((d) => d.stroke !== stroke) });
  }

  /**
   * Drop the drafts that came back on the track as drawn here (a stroke done; a shape no longer dragged, where it
   * was left), or waited too long.
   */
  settle(echoed: readonly InkElement[]): void {
    const now = Date.now();
    const back = new Map(echoed.map((e) => [e.stroke, e]));
    const dragged = this.writer.shaping()?.stroke;
    const drawing = this.writer.drawing()?.stroke;
    const keep = this.#state.drafts.filter((d) => {
      const e = back.get(d.stroke);
      const settled =
        e !== undefined &&
        (d.kind === "shape"
          ? e.kind === "shape" && d.stroke !== dragged && samePoint(e.start, d.start) && samePoint(e.end, d.end)
          : e.kind === "stroke" && e.done);
      const held = d.stroke === dragged || d.stroke === drawing;
      return !settled && (held || now - (this.#draftAt.get(d.stroke) ?? now) < DRAFT_TTL_MS);
    });
    if (keep.length === this.#state.drafts.length) return;
    for (const d of this.#state.drafts) if (!keep.includes(d)) this.#draftAt.delete(d.stroke);
    this.set({ drafts: keep });
  }
}

export function useListening(store: Listening | undefined): ListeningState | undefined {
  return useSyncExternalStore(store?.subscribe ?? noop, store ? store.get : none);
}

/** The room service's state for a render (status, me, threads), re-read on each change. */
export function useRoomService(service: RoomService | undefined): number {
  return useSyncExternalStore(service?.subscribe ?? noop, service ? service.version : zero);
}

const noop = () => () => {};
const none = () => undefined;
const zero = () => 0;
