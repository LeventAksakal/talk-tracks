// The room clock (design §4.5, addendum to decision 0012). @moq/publish stamps the speaker's media from
// performance.now() at capture, so its timestamps restart near 0 on every page load. Room time is that
// timestamp plus an offset the speaker console chooses once per broadcast and publishes on track
// `clock` of talk/<room>/slides, before any audio:
//
//   offset_ms = max(performance.timeOrigin − epoch_ms, end_ms + 4000 − performance.now())
//
// `epoch_ms` is the wall time of the room's first broadcast and `end_ms` the latest archived room time,
// both from the room catalog. Room time then follows wall time since the first broadcast, so a reload
// shows as a gap, and the `max` keeps it from going back when this device's clock runs behind.

import { CLOCK_TRACK, ROOT, slidesPath } from "../contracts/names";
import { SLICE_MS } from "../contracts/types";
import type { Closable, Transport, TrackWriter } from "../transport/types";

/** The room service's catalog, published by the archiver: one JSON snapshot per group. */
export const catalogPath = (room: string) => `${ROOT}/${room}/catalog`;
export const CATALOG_TRACK = "catalog";

/** A `clock` object: `{"epoch_ms","offset_ms","session"}`. */
export interface ClockObject {
  epoch_ms: number;
  offset_ms: number;
  /** The broadcast's start, wall ms, as a string. */
  session: string;
}

/** The room clock fields of the catalog; either may be missing (a new room, or no archiver). */
export interface CatalogClock {
  epochMs: number | undefined;
  endMs: number | undefined;
}

/** How often the clock object is published again, so a late joiner finds it within the relay's max age. */
export const CLOCK_REPEAT_MS = 4_000;
/** How long the console waits for the catalog before taking this broadcast as the room's first. */
export const CATALOG_WAIT_MS = 3_000;

export function parseClock(payload: Uint8Array): number | undefined {
  try {
    const v = JSON.parse(new TextDecoder().decode(payload)) as { offset_ms?: unknown };
    return typeof v.offset_ms === "number" && Number.isFinite(v.offset_ms) ? v.offset_ms : undefined;
  } catch {
    return undefined;
  }
}

export function parseCatalogClock(payload: Uint8Array): CatalogClock | undefined {
  try {
    const v = JSON.parse(new TextDecoder().decode(payload)) as { epoch_ms?: unknown; end_ms?: unknown };
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined);
    return { epochMs: num(v.epoch_ms), endMs: num(v.end_ms) };
  } catch {
    return undefined;
  }
}

/** The offset for a new broadcast, design §4.5. `endMs` and `afterMs` are room times nothing may precede. */
export function chooseOffset(input: {
  epochMs: number;
  endMs: number | undefined;
  /** performance.timeOrigin and performance.now() of this page. */
  timeOrigin: number;
  perfNow: number;
}): number {
  const wall = input.timeOrigin - input.epochMs;
  const after = input.endMs === undefined ? -Infinity : input.endMs + SLICE_MS - input.perfNow;
  return Math.round(Math.max(wall, after));
}

export interface RoomClockOptions {
  /** Wall clock. */
  now?: () => number;
  /** This page's performance clock (the one @moq/publish stamps media with). */
  perf?: { timeOrigin: number; now(): number };
  catalogWaitMs?: number;
  repeatMs?: number;
}

/**
 * The speaker console's side of the room clock, for one page. `start()` begins a broadcast: it reads the
 * catalog, chooses the offset and publishes the clock track; call it before publishing audio. A restart
 * on the same page (the microphone stopped and started, or the connection replaced) keeps room time
 * moving forward even when the catalog is not readable, because the page remembers the room's epoch and
 * the latest room time it handed out.
 */
export class RoomClock {
  readonly room: string;
  #now: () => number;
  #perf: { timeOrigin: number; now(): number };
  #catalogWait: number;
  #repeat: number;
  #epochMs: number | undefined;
  /** The latest room time this page stamped or published. */
  #highMs: number | undefined;
  #current: { object: ClockObject; writer: TrackWriter; timer: ReturnType<typeof setInterval> } | undefined;

  constructor(room: string, options: RoomClockOptions = {}) {
    this.room = room;
    this.#now = options.now ?? Date.now;
    this.#perf = options.perf ?? performance;
    this.#catalogWait = options.catalogWaitMs ?? CATALOG_WAIT_MS;
    this.#repeat = options.repeatMs ?? CLOCK_REPEAT_MS;
  }

  /** The offset of the current broadcast, or undefined between broadcasts. */
  get offsetMs(): number | undefined {
    return this.#current?.object.offset_ms;
  }

  get clock(): ClockObject | undefined {
    return this.#current?.object;
  }

  /**
   * Start a broadcast: read the room clock from the catalog on `reader` (an anonymous connection is
   * enough), choose the offset, and publish the clock track on `publisher`. Resolves with the clock
   * object once it is published.
   */
  async start(publisher: Transport, reader: Transport): Promise<ClockObject> {
    this.stop();
    const catalog = await readCatalogClock(reader, this.room, this.#catalogWait);
    const epochMs = catalog?.epochMs ?? this.#epochMs ?? this.#now();
    const endMs = maxDefined(catalog?.endMs, this.#highMs);
    const offset = chooseOffset({ epochMs, endMs, timeOrigin: this.#perf.timeOrigin, perfNow: this.#perf.now() });
    const object: ClockObject = { epoch_ms: epochMs, offset_ms: offset, session: String(this.#now()) };
    this.#epochMs = epochMs;
    const writer = publisher.publish(slidesPath(this.room), CLOCK_TRACK);
    const write = () => {
      writer.write(new TextEncoder().encode(JSON.stringify(object)));
      this.#note(Math.round(this.#perf.now() + offset));
    };
    write();
    this.#current = { object, writer, timer: setInterval(write, this.#repeat) };
    return object;
  }

  /** Room time of a moment on this page's performance clock (default: now). */
  roomTime(perfMs: number = this.#perf.now()): number {
    const offset = this.#current?.object.offset_ms;
    if (offset === undefined) throw new Error("the room clock is not running");
    return Math.round(perfMs + offset);
  }

  /** Stamp something (a slide) in room time, and remember it so a restart never goes behind it. */
  stamp(perfMs: number = this.#perf.now()): number {
    const t = this.roomTime(perfMs);
    this.#note(t);
    return t;
  }

  /** End the broadcast's clock track. */
  stop(): void {
    if (!this.#current) return;
    this.#note(this.roomTime());
    clearInterval(this.#current.timer);
    this.#current.writer.close();
    this.#current = undefined;
  }

  #note(t: number): void {
    if (this.#highMs === undefined || t > this.#highMs) this.#highMs = t;
  }
}

/** The newest catalog snapshot's clock fields, or undefined if none arrives in `waitMs`. */
export function readCatalogClock(reader: Transport, room: string, waitMs: number): Promise<CatalogClock | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: CatalogClock | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // After the current delivery: a transport may call back before subscribe() has returned.
      queueMicrotask(() => sub.close());
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), waitMs);
    const sub: Closable = reader.subscribe(catalogPath(room), CATALOG_TRACK, ({ payload }) => {
      const clock = parseCatalogClock(payload);
      if (clock) finish(clock);
    });
  });
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}
