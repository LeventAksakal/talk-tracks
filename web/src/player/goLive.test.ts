// Seek back, then Go live, in a looped demo room (QA P0): the room goes back to LIVE, never "Talk ended".
// The live player is @moq/watch, faked here: its clock tells the playhead it plays, or nothing before its first
// frame (a fresh player after Go live, or a browser that cannot decode the broadcast).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOG_TRACK, catalogPath, teacherPath } from "../contracts/names";
import { MOQ_EPOCH_UNIX_MS } from "../contracts/types";
import { RoomMedia, type RoomMediaElements } from "../playback/media";
import { HANG_CATALOG_TRACK } from "../playback/roomClock";
import { FakeTransport } from "../transport/fake";
import type { MoqTransport } from "../transport/moq";
import { playerState } from "./state";

const fake = vi.hoisted(() => ({
  /** What each new live player's clock says: a function of nothing, read every poll. */
  clocks: [] as (() => number | undefined)[],
  catalog: undefined as unknown,
}));

vi.mock("@moq/watch", () => {
  class Signal<T> {
    constructor(public value: T) {}
    set(v: T) {
      this.value = v;
    }
    peek() {
      return this.value;
    }
  }
  const once = <T>(value: () => T) => ({
    subscribe: (fn: (v: T) => void) => {
      fn(value());
      return () => {};
    },
    peek: value,
  });
  class Player {
    #now: () => number | undefined;
    constructor() {
      this.#now = fake.clocks.shift() ?? (() => undefined);
    }
    broadcast = { out: { status: once(() => "live"), catalog: once(() => fake.catalog) } };
    sync = { now: () => this.#now() };
    renderer = { out: { timestamp: { peek: () => this.#now() } } };
    close() {}
  }
  return { Signals: { Signal }, Net: { Path: { from: (s: string) => s }, Time: { Milli: (n: number) => n } }, Player };
});

// The virus room as the looper publishes it: media time 0 at 2026-10-01, a 1024 s loop of a 1020.2 s lecture.
const EPOCH = Date.parse("2026-10-01T00:00:00Z");
const teacherCatalog = {
  clock: { wall: (EPOCH - MOQ_EPOCH_UNIX_MS) * 1000, timescale: 1_000_000 },
  audio: {},
  talk_tracks: { loop: 2392, loop_start_ms: 2_449_408_000, duration_ms: 1_020_200, period_ms: 1_024_000 },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH + 2_449_502_000); // mid-slice: live media 500 ms behind is in the slice of now
  fake.catalog = teacherCatalog;
  fake.clocks = [];
});
afterEach(() => {
  vi.useRealTimers();
});

/** Live, a minute back watched for a minute, then Go live with a new player that has no frame yet. */
async function seekBackThenGoLive(room: string, looped: boolean) {
  const transport = new FakeTransport();
  const media = new RoomMedia(transport as unknown as MoqTransport, room, {
    fetchFn: vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch,
    loopWaitMs: 500,
  });
  const hang = looped ? teacherCatalog : { clock: teacherCatalog.clock, audio: {} };
  fake.catalog = hang;
  const speaker = () => transport.emitJson(teacherPath(room), HANG_CATALOG_TRACK, hang);
  /** Let time pass while the looper (or the speaker) repeats its catalog every 2 s. */
  const pass = async (ms: number) => {
    for (let t = 0; t < ms; t += 2_000) {
      speaker();
      await vi.advanceTimersByTimeAsync(Math.min(2_000, ms - t));
    }
  };
  transport.emitJson(catalogPath(room), CATALOG_TRACK, {
    tracks: [],
    tt: { E: EPOCH, shift: { [String(teacherCatalog.clock.wall)]: 0 } },
  });
  speaker();
  const states: string[] = [];
  const look = () =>
    states.push(
      playerState({
        connection: "connected",
        everConnected: true,
        onAir: media.onAir(),
        mode: media.mode(),
        liveEdge: media.liveEdge(),
        behindMs: 0,
        looped,
      }).kind,
    );

  // Live: the first player plays half a second behind now.
  fake.clocks.push(() => Date.now() - EPOCH - 500);
  // No video element: a seek plays on the room clock alone, which is all this needs.
  media.attach({ canvas: {} as HTMLCanvasElement } as RoomMediaElements);
  media.play();
  await pass(4_000);
  look();
  media.seek(media.liveEdge()! - 60_000);
  await pass(60_000);
  look();
  fake.clocks.push(() => undefined);
  media.goLive();
  for (let i = 0; i < 4; i++) {
    await pass(1_000);
    look();
  }
  media.close();
  return states;
}

describe("Go live after a seek back", () => {
  it("returns a looped room to LIVE, even before the new live player shows a frame", async () => {
    expect(await seekBackThenGoLive("virus", true)).toEqual(["live", "behind", "live", "live", "live", "live"]);
  });

  it("never takes a live room's Go live for the speaker leaving", async () => {
    const states = await seekBackThenGoLive("lecture", false);
    expect(states.slice(0, 2)).toEqual(["live", "behind"]);
    expect(states.slice(2)).not.toContain("ended");
  });
});
