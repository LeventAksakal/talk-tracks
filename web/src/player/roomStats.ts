// Stats for nerds' view of the room (ticket 0022): talk/<room>/stats `stats`, published by the room service. Each group
// is one snapshot (RoomStats): every track of the room, running or on demand, and the sessions subscribed to its
// broadcast at the relay. Opening the panel subscribes and closing it unsubscribes (decision 0026: a panel is a
// subscription); the room service builds snapshots only while someone reads them.

import { STATS_TRACK, statsPath } from "../contracts/names";
import type { RoomStats, TrackStats } from "../contracts/types";
import { parseRoomStats } from "../contracts/validate";
import type { HistorySource } from "../playback/source";
import type { Closable } from "../transport/types";

/** The room service sends the first snapshot at once; without one by then, it sends none for this room. */
const WAIT_MS = 8_000;
const PRIORITY = 20;

export type StatsPhase = "loading" | "ready" | "none";

export interface StatsView {
  phase: StatsPhase;
  stats: RoomStats | undefined;
}

export interface StatsGroup {
  namespace: string;
  /** Sessions subscribed to the broadcast; undefined when the relay's counts are unknown. */
  subscribers: number | undefined;
  tracks: TrackStats[];
}

/** The snapshot's tracks by broadcast, in the order the room service lists them. */
export function byNamespace(stats: RoomStats): StatsGroup[] {
  const groups = new Map<string, StatsGroup>();
  for (const t of stats.tracks) {
    let g = groups.get(t.namespace);
    if (!g) {
      g = { namespace: t.namespace, subscribers: t.subscribers ?? undefined, tracks: [] };
      groups.set(t.namespace, g);
    }
    g.tracks.push(t);
  }
  return [...groups.values()];
}

export class StatsFeed {
  readonly room: string;
  #source: HistorySource;
  #sub: Closable | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #view: StatsView = { phase: "loading", stats: undefined };
  #listeners = new Set<() => void>();
  #version = 0;
  #waitMs: number;

  constructor(source: HistorySource, room: string, options: { waitMs?: number } = {}) {
    this.room = room;
    this.#source = source;
    this.#waitMs = options.waitMs ?? WAIT_MS;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getVersion = (): number => this.#version;

  view(): StatsView {
    return this.#view;
  }

  start(): void {
    if (this.#sub) return;
    this.#set({ phase: "loading", stats: undefined });
    this.#sub = this.#source.subscribe(statsPath(this.room), STATS_TRACK, (o) => this.#onObject(o.payload), {
      priority: PRIORITY,
    });
    this.#timer = setTimeout(() => {
      if (this.#view.phase === "loading") this.#set({ phase: "none", stats: undefined });
    }, this.#waitMs);
  }

  stop(): void {
    this.#sub?.close();
    this.#sub = undefined;
    clearTimeout(this.#timer);
  }

  #onObject(payload: Uint8Array): void {
    const parsed = parseRoomStats(payload);
    if (!parsed.ok) return;
    this.#set({ phase: "ready", stats: parsed.value });
  }

  #set(view: StatsView): void {
    this.#view = view;
    this.#version++;
    for (const l of this.#listeners) l();
  }
}
