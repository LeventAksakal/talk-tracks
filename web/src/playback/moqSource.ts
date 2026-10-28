import * as Moq from "@moq/net";
import type { MoqTransport } from "../transport/moq";
import type { AnnounceEvent, Closable } from "../transport/types";
import { type FetchOptions, type GroupObject, type HistorySource, type LiveOptions, NotFound } from "./source";

const RESUBSCRIBE_MS = 1_000;
/** How long a FETCH waits for its broadcast to be announced. */
const ROUTE_WAIT_MS = 5_000;
/** moq-lite's code for "the requested broadcast or track does not exist at the peer". */
const NOT_FOUND = Moq.StreamCode.NotFound;

/**
 * HistorySource over @moq/net, on the transport's own connection and origin. Each track gets exactly
 * one subscription, with its options fixed when it opens (design §5.2: a second subscription or a
 * `maxAge` update on the same track ended the live one in spike S3). History goes through
 * `fetchGroup`, one group per call.
 */
export class MoqHistorySource implements HistorySource {
  #transport: MoqTransport;

  constructor(transport: MoqTransport) {
    this.#transport = transport;
  }

  announced(prefix: string, onEvent: (event: AnnounceEvent) => void): Closable {
    return this.#transport.announced(prefix, onEvent);
  }

  subscribe(path: string, track: string, onObject: (object: GroupObject) => void, options: LiveOptions): Closable {
    const requesting = this.#transport.origin.request(Moq.Path.from(path), { announced: true });
    let current: Moq.Track.Subscriber | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const attach = (broadcast: Moq.Broadcast.Consumer | undefined) => {
      clearTimeout(retry);
      current?.close();
      current = undefined;
      if (closed || !broadcast) return;
      // maxAge 0: the latest group only. A slice opens with its carry-in, so that is enough to join.
      const subscriber = broadcast.track(track).subscribe({ priority: options.priority, maxAge: Moq.Time.Milli(0) });
      current = subscriber;
      void pump(subscriber, onObject).then(() => {
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
        if (closed) return;
        closed = true;
        clearTimeout(retry);
        dispose();
        // Closing the last local subscriber makes @moq/net cancel the upstream SUBSCRIBE, and the relay
        // cancels the agent's at once when no one else holds it (decision 0010).
        current?.close();
        current = undefined;
        requesting.close();
      },
    };
  }

  async fetchGroup(path: string, track: string, group: number, options: FetchOptions): Promise<Uint8Array[]> {
    options.signal?.throwIfAborted();
    const requesting = this.#transport.origin.request(Moq.Path.from(path), { announced: true });
    try {
      const broadcast = await routed(requesting, options.signal);
      let consumer: Moq.Group.Consumer;
      try {
        consumer = await broadcast
          .track(track)
          .fetchGroup(group, { priority: options.priority, signal: options.signal });
      } catch (e) {
        throw isNotFound(e) ? new NotFound(`${path}/${track} group ${group}: ${errorText(e)}`) : e;
      }
      const frames: Uint8Array[] = [];
      try {
        for (;;) {
          const frame = await consumer.readFrame();
          if (!frame) break;
          frames.push(frame.payload);
        }
      } finally {
        consumer.close();
      }
      return frames;
    } finally {
      requesting.close();
    }
  }
}

function isNotFound(e: unknown): boolean {
  if (e instanceof Moq.Error.NotFound) return true;
  return e instanceof Moq.Error.Stream && e.code === NOT_FOUND;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The broadcast once it is routed; NotFound if nothing announces it in time (its publisher is gone). */
function routed(requesting: Moq.Origin.Requesting, signal?: AbortSignal): Promise<Moq.Broadcast.Consumer> {
  const now = requesting.active.peek();
  if (now) return Promise.resolve(now);
  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => {
      clearTimeout(timer);
      dispose();
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => done(() => reject(signal?.reason));
    const timer = setTimeout(() => done(() => reject(new NotFound("unroutable: nothing announces it"))), ROUTE_WAIT_MS);
    const dispose = requesting.active.subscribe((b) => {
      if (b) done(() => resolve(b));
    });
    signal?.addEventListener("abort", onAbort);
  });
}

/** Read groups as they arrive, each in its own task: a broken group is skipped, never the track's end. */
async function pump(subscriber: Moq.Track.Subscriber, onObject: (object: GroupObject) => void): Promise<void> {
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

async function readGroup(group: Moq.Group.Consumer, onObject: (object: GroupObject) => void): Promise<void> {
  try {
    for (let index = 0; ; index++) {
      const frame = await group.readFrame();
      if (!frame) return;
      onObject({ group: group.sequence, index, payload: frame.payload });
    }
  } catch {
    // The relay resets groups it no longer serves: keep what arrived.
  } finally {
    group.close();
  }
}
