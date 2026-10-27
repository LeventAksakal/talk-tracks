import type {
  AnnounceEvent,
  Closable,
  ConnectionStatus,
  SubscribeOptions,
  TrackObject,
  TrackWriter,
  Transport,
} from "./types";

type Listener<T> = (value: T) => void;

function under(prefix: string, path: string): string | null {
  if (prefix === "") return path;
  if (path === prefix) return "";
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : null;
}

/**
 * An in-memory relay: what is announced, who subscribes, and the latest group per track (handed to
 * a late subscriber the way a relay serves its newest group). Drives tests and the offline /demo.
 */
export class FakeTransport implements Transport {
  readonly kind = "fake";
  #active = new Set<string>();
  #announceListeners = new Set<{ prefix: string; fn: Listener<AnnounceEvent> }>();
  #subscribers = new Map<string, Set<Listener<TrackObject>>>();
  #latest = new Map<string, TrackObject>();
  #groups = new Map<string, number>();
  #status: ConnectionStatus = "connected";
  #statusListeners = new Set<(status: ConnectionStatus, error?: Error) => void>();
  #now: () => number;
  #cleanups: (() => void)[] = [];

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  // --- driving the fake ---------------------------------------------------------------------------

  announce(path: string): void {
    if (this.#active.has(path)) return;
    this.#active.add(path);
    this.#notify(path, true);
  }

  withdraw(path: string): void {
    if (!this.#active.delete(path)) return;
    this.#notify(path, false);
  }

  isAnnounced(path: string): boolean {
    return this.#active.has(path);
  }

  /** Deliver one object (one group) on a track, as its publisher would. */
  emit(path: string, track: string, payload: Uint8Array | string): void {
    const key = `${path}#${track}`;
    const group = (this.#groups.get(key) ?? -1) + 1;
    this.#groups.set(key, group);
    const object: TrackObject = {
      group,
      payload: typeof payload === "string" ? new TextEncoder().encode(payload) : payload,
      receivedAt: this.#now(),
    };
    this.#latest.set(key, object);
    for (const fn of [...(this.#subscribers.get(key) ?? [])]) fn(object);
  }

  emitJson(path: string, track: string, value: unknown): void {
    this.emit(path, track, JSON.stringify(value));
  }

  setStatus(status: ConnectionStatus, error?: Error): void {
    this.#status = status;
    for (const fn of [...this.#statusListeners]) fn(status, error);
  }

  subscriberCount(path: string, track: string): number {
    return this.#subscribers.get(`${path}#${track}`)?.size ?? 0;
  }

  // --- Transport ----------------------------------------------------------------------------------

  announced(prefix: string, onEvent: Listener<AnnounceEvent>): Closable {
    const entry = { prefix, fn: onEvent };
    this.#announceListeners.add(entry);
    for (const path of [...this.#active]) {
      const rel = under(prefix, path);
      if (rel !== null) onEvent({ path: rel, active: true });
    }
    return { close: () => this.#announceListeners.delete(entry) };
  }

  subscribe(path: string, track: string, onObject: Listener<TrackObject>, _options?: SubscribeOptions): Closable {
    const key = `${path}#${track}`;
    let set = this.#subscribers.get(key);
    if (!set) this.#subscribers.set(key, (set = new Set()));
    const fn: Listener<TrackObject> = (o) => onObject(o);
    set.add(fn);
    const latest = this.#latest.get(key);
    if (latest && this.#active.has(path)) queueMicrotask(() => set.has(fn) && onObject(latest));
    return { close: () => set.delete(fn) };
  }

  publish(path: string, track: string): TrackWriter {
    let closed = false;
    this.announce(path);
    return {
      write: (payload) => {
        if (!closed) this.emit(path, track, payload);
      },
      close: () => {
        closed = true;
      },
    };
  }

  status(): ConnectionStatus {
    return this.#status;
  }

  onStatus(listener: (status: ConnectionStatus, error?: Error) => void): Closable {
    this.#statusListeners.add(listener);
    return { close: () => this.#statusListeners.delete(listener) };
  }

  /** Run `fn` when the transport closes (e.g. stop a script driving it). */
  onClose(fn: () => void): void {
    this.#cleanups.push(fn);
  }

  close(): void {
    for (const fn of this.#cleanups.splice(0)) fn();
    this.#announceListeners.clear();
    this.#subscribers.clear();
    this.#statusListeners.clear();
  }

  #notify(path: string, active: boolean): void {
    for (const { prefix, fn } of [...this.#announceListeners]) {
      const rel = under(prefix, path);
      if (rel !== null) fn({ path: rel, active });
    }
  }
}
