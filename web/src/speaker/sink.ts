// Where the console writes its event tracks. The transport's TrackWriter makes every write a group
// of its own; the sliced tracks need groups numbered by room slice holding several objects (object 0
// the carry-in, then the deltas: wiki/design/container-formats.md). So the console publishes its
// slides broadcast through this seam: over @moq/net on the page's MoqTransport origin, or into memory
// (tests, and the offline console).

import * as Moq from "@moq/net";

/** One group of a track: objects in order, then close (End of Group). */
export interface GroupSink {
  write(payload: Uint8Array): void;
  close(): void;
}

/** One track of the broadcast. Group sequences only go up. */
export interface TrackSink {
  group(sequence: number): GroupSink;
  close(): void;
}

/** A broadcast (one path) this page publishes. */
export interface BroadcastSink {
  /** `maxAgeMs`: how long the publisher keeps a group that is no longer the newest. */
  track(name: string, maxAgeMs: number): TrackSink;
  close(): void;
}

/** Publish `path` into a @moq/net origin (the MoqTransport's), announced with its first track. */
export function moqBroadcast(origin: Moq.Origin.Producer, path: string): BroadcastSink {
  const producer = origin.createBroadcast(Moq.Path.from(path));
  let announced = false;
  let closed = false;
  return {
    track(name, maxAgeMs) {
      const track = producer.createTrack(name, { maxAge: Moq.Time.Milli(maxAgeMs) });
      if (!announced) {
        producer.announce();
        announced = true;
      }
      let trackClosed = false;
      return {
        group(sequence) {
          const group = new Moq.Group.Producer(sequence);
          track.writeGroup(group);
          return {
            write: (payload) => {
              if (!group.isClosed) group.writeFrame({ payload, timestamp: Moq.Time.Timestamp.now() });
            },
            close: () => {
              if (!group.isClosed) group.close();
            },
          };
        },
        close() {
          if (closed || trackClosed) return;
          trackClosed = true;
          track.close();
          producer.removeTrack(name);
        },
      };
    },
    close() {
      if (closed) return;
      closed = true;
      producer.close();
    },
  };
}

/** One published object as the memory sink keeps it. */
export interface WrittenObject {
  track: string;
  group: number;
  object: number;
  payload: Uint8Array;
}

/** Keeps every object written, by track and group: what a relay would hold. */
export class MemoryBroadcast implements BroadcastSink {
  readonly written: WrittenObject[] = [];
  readonly closedGroups = new Set<string>();
  readonly maxAge = new Map<string, number>();
  closed = false;
  #listeners = new Set<(o: WrittenObject) => void>();

  track(name: string, maxAgeMs: number): TrackSink {
    this.maxAge.set(name, maxAgeMs);
    let last = -1;
    return {
      group: (sequence) => {
        if (sequence <= last) throw new Error(`group ${sequence} of ${name} after ${last}`);
        last = sequence;
        let object = 0;
        return {
          write: (payload) => {
            if (this.closedGroups.has(`${name}#${sequence}`)) throw new Error(`write to closed group ${sequence}`);
            const o = { track: name, group: sequence, object: object++, payload };
            this.written.push(o);
            for (const fn of [...this.#listeners]) fn(o);
          },
          close: () => void this.closedGroups.add(`${name}#${sequence}`),
        };
      },
      close: () => undefined,
    };
  }

  close(): void {
    this.closed = true;
  }

  onWrite(fn: (o: WrittenObject) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** The objects of one group, in order, decoded as JSON. */
  objects(track: string, group: number): unknown[] {
    return this.written
      .filter((o) => o.track === track && o.group === group)
      .map((o) => JSON.parse(new TextDecoder().decode(o.payload)) as unknown);
  }

  groups(track: string): number[] {
    return [...new Set(this.written.filter((o) => o.track === track).map((o) => o.group))];
  }
}
