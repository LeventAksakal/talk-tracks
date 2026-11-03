import * as Moq from "@moq/net";
import type {
  AnnounceEvent,
  Closable,
  ConnectionStatus,
  SubscribeOptions,
  TrackObject,
  TrackWriter,
  Transport,
  Wire,
} from "./types";

const RESUBSCRIBE_MS = 1_000;

export interface MoqTransportOptions {
  /** Relay URL. `http://` pins the relay's self-signed certificate (local development). */
  url: URL;
  /** Publish token (decision 0005), sent to the relay as `?jwt=`. Watching needs none. */
  token?: string;
  /**
   * The one prefix this transport reads from the relay, e.g. `talk/<room>`: only its announcements are asked for.
   * Unset, the relay announces every broadcast it holds, hundreds of them, and @moq/net matches each against every
   * reader as it lands (2.8 s of main thread on the watch page, QA 2026-11-03).
   */
  scope?: string;
}

/**
 * The origin handle a connection feeds the relay's announcements into: narrowed to `scope`, the connection asks the
 * relay for that prefix only. Requests outside it still resolve, blind, the way they do without discovery.
 */
export function consumeScope(origin: Moq.Origin.Producer, scope?: string): Moq.Origin.Producer {
  if (!scope) return origin;
  return origin.scope(Moq.Path.empty(), new Moq.Path.Patterns([Moq.Path.Pattern.subtree(Moq.Path.from(scope))]));
}

export function relayUrl(base: string, token?: string): URL {
  const url = new URL(base);
  if (token) url.searchParams.set("jwt", token);
  return url;
}

/**
 * Transport over @moq/net. One reconnecting `Connection` with its own origin: everything the relay
 * announces lands in the origin, and everything published into it is announced to the relay and
 * re-announced after a reconnect. The origin is private to this transport (not the URL-shared pool),
 * so a second transport on the same relay sees this one's broadcasts only through the relay; the
 * speaker console relies on that to confirm its own publish.
 */
export class MoqTransport implements Transport {
  readonly kind = "moq";
  readonly connection: Moq.Connection;
  /** The origin @moq/watch and @moq/publish attach to. */
  readonly origin: Moq.Origin.Producer;
  #broadcasts = new Map<string, { producer: Moq.Broadcast.Producer; tracks: Set<string> }>();
  #closed = false;

  constructor(options: MoqTransportOptions) {
    this.origin = new Moq.Origin.Producer();
    this.connection = new Moq.Connection({
      url: options.url,
      publish: this.origin.consume(),
      consume: consumeScope(this.origin, options.scope),
      websocket: { enabled: true },
      // Retry forever: a talk outlives any relay restart. An auth refusal still stops the loop.
      delay: { timeout: Moq.Time.Milli(0) },
    });
  }

  announced(prefix: string, onEvent: (event: AnnounceEvent) => void): Closable {
    const base = Moq.Path.from(prefix);
    const consumer = this.origin.announced(Moq.Path.Pattern.subtree(base));
    void (async () => {
      try {
        for await (const update of consumer) {
          const rel = Moq.Path.stripPrefix(base, update.prefix);
          if (rel === null) continue;
          onEvent({ path: rel, active: Moq.Announce.isActive(update.kind) });
        }
      } catch (e) {
        if (!this.#closed) console.warn("announcements ended", prefix, e);
      }
    })();
    return { close: () => consumer.close() };
  }

  subscribe(
    path: string,
    track: string,
    onObject: (object: TrackObject) => void,
    options: SubscribeOptions = {},
  ): Closable {
    const requesting = this.origin.request(Moq.Path.from(path), { announced: true });
    const maxAge = Moq.Time.Milli(options.maxAgeMs ?? 0);
    let current: Moq.Track.Subscriber | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const attach = (broadcast: Moq.Broadcast.Consumer | undefined) => {
      clearTimeout(retry);
      current?.close();
      current = undefined;
      if (closed || !broadcast) return;
      const subscriber = broadcast.track(track).subscribe({ maxAge });
      current = subscriber;
      void pump(subscriber, onObject).then(() => {
        // The track ended while the broadcast is still routed (the publisher restarted it, or the
        // relay dropped the subscription): subscribe again unless something newer took over.
        if (closed || current !== subscriber) return;
        retry = setTimeout(() => {
          if (!closed && current === subscriber) attach(requesting.active.peek());
        }, RESUBSCRIBE_MS);
      });
    };

    const dispose = requesting.active.subscribe(attach);
    attach(requesting.active.peek());
    return {
      close: () => {
        closed = true;
        clearTimeout(retry);
        dispose();
        current?.close();
        requesting.close();
      },
    };
  }

  publish(path: string, track: string): TrackWriter {
    let entry = this.#broadcasts.get(path);
    if (!entry) {
      entry = { producer: this.origin.createBroadcast(Moq.Path.from(path)), tracks: new Set() };
      this.#broadcasts.set(path, entry);
    }
    const producer = entry.producer;
    const writer = producer.createTrack(track);
    entry.tracks.add(track);
    if (entry.tracks.size === 1) producer.announce();
    let closed = false;
    return {
      write: (payload) => {
        if (closed) return;
        writer.writeFrame({ payload, timestamp: Moq.Time.Timestamp.now() });
      },
      close: () => {
        if (closed) return;
        closed = true;
        writer.close();
        producer.removeTrack(track);
        const current = this.#broadcasts.get(path);
        current?.tracks.delete(track);
        if (current && current.tracks.size === 0) {
          producer.close();
          this.#broadcasts.delete(path);
        }
      },
    };
  }

  status(): ConnectionStatus {
    if (this.connection.error.peek()) return "failed";
    return this.connection.status.peek();
  }

  /** WebTransport, or the WebSocket fallback @moq/net falls back to when WebTransport is missing or slower. */
  wire(): Wire | undefined {
    return this.connection.transport.peek();
  }

  onStatus(listener: (status: ConnectionStatus, error?: Error) => void): Closable {
    const emit = () => listener(this.status(), this.connection.error.peek());
    const a = this.connection.status.subscribe(emit);
    const b = this.connection.error.subscribe(emit);
    const c = this.connection.transport.subscribe(emit);
    return {
      close: () => {
        a();
        b();
        c();
      },
    };
  }

  close(): void {
    this.#closed = true;
    muteCloseError();
    for (const { producer } of this.#broadcasts.values()) producer.close();
    this.#broadcasts.clear();
    this.connection.close();
    this.origin.close();
  }
}

/** How long after a deliberate close @moq/net's own report of it is dropped, ms. */
const CLOSE_QUIET_MS = 3_000;
const CLOSE_ERROR = "fatal error running connection";
let quietUntil = 0;
let consoleError: typeof console.error | undefined;

/**
 * Leaving a room closes the connection on purpose, yet @moq/net logs "fatal error running connection" when its
 * tasks reject on the way down (Firefox does; QA 2026-11-02). For a few seconds after our own close that one line is
 * dropped; every other error, and that line at any other time, still reaches the console.
 */
function muteCloseError(now = Date.now()): void {
  quietUntil = now + CLOSE_QUIET_MS;
  if (consoleError) return;
  const original = console.error.bind(console);
  consoleError = original;
  console.error = (...args: unknown[]) => {
    if (Date.now() < quietUntil && typeof args[0] === "string" && args[0].startsWith(CLOSE_ERROR)) return;
    original(...args);
  };
}

/** Read groups as they arrive, each in its own task: a broken group is skipped, never the track's end. */
async function pump(subscriber: Moq.Track.Subscriber, onObject: (object: TrackObject) => void): Promise<void> {
  for (;;) {
    let group: Moq.Group.Consumer | undefined;
    try {
      group = await subscriber.recvGroup();
    } catch {
      return;
    }
    if (!group) return;
    void readGroup(group, onObject);
  }
}

async function readGroup(group: Moq.Group.Consumer, onObject: (object: TrackObject) => void): Promise<void> {
  try {
    for (;;) {
      const frame = await group.readFrame();
      if (!frame) return;
      if (frame.payload.byteLength === 0) continue;
      onObject({ group: group.sequence, payload: frame.payload, receivedAt: Date.now() });
    }
  } catch {
    // The relay resets groups it no longer serves (code 52 for early groups): skip this one.
  } finally {
    group.close();
  }
}
