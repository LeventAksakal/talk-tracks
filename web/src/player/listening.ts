// What the listener is doing on the slides (decision 0024): the annotation tools on the slide tile, a comment's
// anchor waiting in the Discussion composer, and the thread pointed at in the Discussion tab. A small store shared
// by the slide tile and the Discussion tab, which sit in different parts of the player.

import { useSyncExternalStore } from "react";
import { AnnotationWriter } from "../annotate/writer";
import type { RoomService, WriteError } from "../annotate/client";
import type { Anchor, InkStroke } from "../contracts/types";

export type ListenerTool = "pen" | "highlighter" | "underline" | "highlight" | "eraser" | "comment";

/** Tools that change the slide: only on the live slide (a replay's slide is the past). */
export const DRAWING_TOOLS: readonly ListenerTool[] = ["pen", "highlighter", "underline", "highlight", "eraser"];

export const LISTENER_COLORS = ["#2f6bff", "#e5383b", "#1f9d55", "#f5b700"] as const;

export interface ListeningState {
  /** The tool bar is open on the slide tile. */
  annotating: boolean;
  tool: ListenerTool;
  color: string;
  /** A new comment's anchor, made with the comment tool, waiting in the Discussion composer. */
  anchor: Anchor | undefined;
  /** A thread pointed at in the Discussion tab: its anchor is outlined on the slide. */
  focus: string | undefined;
  /** Strokes drawn here, shown until they come back on the track. */
  drafts: InkStroke[];
  /** The last write refused, in words. */
  error: string | undefined;
  /** The name prompt is open (writes need a display name). */
  askName: boolean;
}

const INITIAL: ListeningState = {
  annotating: false,
  tool: "pen",
  color: LISTENER_COLORS[0],
  anchor: undefined,
  focus: undefined,
  drafts: [],
  error: undefined,
  askName: false,
};

/** Drafts not echoed by then are dropped (a refused or lost write). */
const DRAFT_TTL_MS = 8_000;

export class Listening {
  readonly service: RoomService;
  readonly writer: AnnotationWriter;
  #state: ListeningState = INITIAL;
  #listeners = new Set<() => void>();
  #draftAt = new Map<string, number>();

  constructor(service: RoomService) {
    this.service = service;
    this.writer = new AnnotationWriter(service, (e) => this.refused(e));
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

  addDraft(stroke: InkStroke): void {
    this.#draftAt.set(stroke.stroke, Date.now());
    this.set({ drafts: [...this.#state.drafts.filter((d) => d.stroke !== stroke.stroke), stroke] });
  }

  /** Drop the drafts that came back on the track (done there), or waited too long. */
  settle(echoed: ReadonlySet<string>): void {
    const now = Date.now();
    const keep = this.#state.drafts.filter(
      (d) => !echoed.has(d.stroke) && now - (this.#draftAt.get(d.stroke) ?? now) < DRAFT_TTL_MS,
    );
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
