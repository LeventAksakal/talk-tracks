import type { AnnounceEvent, Closable } from "../transport/types";
import { type FetchOptions, type GroupObject, type HistorySource, type LiveOptions, NotFound } from "./source";

interface FakeTrack {
  /** Every group the origin holds: what was published live, plus what was stored for FETCH only. */
  groups: Map<number, Uint8Array[]>;
  latest: number | undefined;
  subscribers: Set<(object: GroupObject) => void>;
}

export interface FetchRecord {
  path: string;
  track: string;
  group: number;
  priority: number;
}

function under(prefix: string, path: string): string | null {
  if (prefix === "") return path;
  if (path === prefix) return "";
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : null;
}

/**
 * An in-memory relay with its agents as origins. A subscriber gets the latest group from its object 0
 * and then everything published live; a FETCH answers any group the origin holds, live or stored
 * (an agent's archive, or a back-filled slice), and NotFound otherwise. It records every
 * subscription and fetch, so tests can check what reached the wire.
 */
export class FakeHistorySource implements HistorySource {
  #active = new Set<string>();
  #listeners = new Set<{ prefix: string; fn: (e: AnnounceEvent) => void }>();
  #tracks = new Map<string, FakeTrack>();
  /** Every FETCH, in order. */
  readonly fetches: FetchRecord[] = [];
  /** Priorities of live subscriptions as they opened. */
  readonly subscriptions: { path: string; track: string; priority: number }[] = [];
  /** Delay before a FETCH answers, ms (0: next microtask). */
  fetchDelayMs = 0;
  #inFlight = 0;
  /** Most FETCHes ever in flight at once. */
  maxInFlight = 0;

  announce(path: string): void {
    if (this.#active.has(path)) return;
    this.#active.add(path);
    this.#notify(path, true);
  }

  withdraw(path: string): void {
    if (!this.#active.delete(path)) return;
    this.#notify(path, false);
  }

  /** Publish one object live into `group` (a new group once `group` passes the latest). */
  publish(path: string, track: string, group: number, payload: Uint8Array): void {
    const t = this.#track(path, track);
    const objects = t.groups.get(group) ?? [];
    t.groups.set(group, objects);
    objects.push(payload);
    if (t.latest === undefined || group > t.latest) t.latest = group;
    const object = { group, index: objects.length - 1, payload };
    for (const fn of [...t.subscribers]) fn(object);
  }

  /** A group only the origin holds: reachable by FETCH, never sent live. */
  store(path: string, track: string, group: number, objects: Uint8Array[]): void {
    this.#track(path, track).groups.set(group, [...objects]);
  }

  /** Forget a group, as if it was never produced. */
  drop(path: string, track: string, group: number): void {
    this.#track(path, track).groups.delete(group);
  }

  subscriberCount(path: string, track: string): number {
    return this.#tracks.get(`${path}#${track}`)?.subscribers.size ?? 0;
  }

  fetchedGroups(path: string, track: string): number[] {
    return this.fetches.filter((f) => f.path === path && f.track === track).map((f) => f.group);
  }

  // --- HistorySource ------------------------------------------------------------------------------

  announced(prefix: string, onEvent: (event: AnnounceEvent) => void): Closable {
    const entry = { prefix, fn: onEvent };
    this.#listeners.add(entry);
    for (const path of [...this.#active]) {
      const rel = under(prefix, path);
      if (rel !== null) onEvent({ path: rel, active: true });
    }
    return { close: () => this.#listeners.delete(entry) };
  }

  subscribe(path: string, track: string, onObject: (object: GroupObject) => void, options: LiveOptions): Closable {
    const t = this.#track(path, track);
    const fn = (o: GroupObject) => onObject(o);
    t.subscribers.add(fn);
    this.subscriptions.push({ path, track, priority: options.priority });
    const latest = t.latest;
    if (latest !== undefined && this.#active.has(path)) {
      const objects = [...(t.groups.get(latest) ?? [])];
      queueMicrotask(() => {
        objects.forEach((payload, index) => t.subscribers.has(fn) && onObject({ group: latest, index, payload }));
      });
    }
    return { close: () => t.subscribers.delete(fn) };
  }

  async fetchGroup(path: string, track: string, group: number, options: FetchOptions): Promise<Uint8Array[]> {
    options.signal?.throwIfAborted();
    this.fetches.push({ path, track, group, priority: options.priority });
    this.#inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.#inFlight);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.fetchDelayMs);
        options.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(options.signal?.reason);
        });
      });
      if (!this.#active.has(path)) throw new NotFound("unroutable");
      const objects = this.#tracks.get(`${path}#${track}`)?.groups.get(group);
      if (!objects) throw new NotFound(`${path}/${track} group ${group}`);
      return [...objects];
    } finally {
      this.#inFlight--;
    }
  }

  #track(path: string, track: string): FakeTrack {
    const key = `${path}#${track}`;
    let t = this.#tracks.get(key);
    if (!t) this.#tracks.set(key, (t = { groups: new Map(), latest: undefined, subscribers: new Set() }));
    return t;
  }

  #notify(path: string, active: boolean): void {
    for (const { prefix, fn } of [...this.#listeners]) {
      const rel = under(prefix, path);
      if (rel !== null) fn({ path: rel, active });
    }
  }
}
