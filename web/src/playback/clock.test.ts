import { afterEach, describe, expect, it } from "vitest";
import { CLOCK_TRACK, slidesPath } from "../contracts/names";
import { FakeTransport } from "../transport/fake";
import {
  CATALOG_TRACK,
  catalogPath,
  chooseOffset,
  type ClockObject,
  parseCatalogClock,
  parseClock,
  RoomClock,
} from "./clock";

const ROOM = "lecture";
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

/** One page: a wall clock and a performance clock that started at `loadedAt` (wall ms). */
function page(loadedAt: number, wallSkewMs = 0) {
  const p = { wall: loadedAt, skew: wallSkewMs };
  return {
    advance: (ms: number) => (p.wall += ms),
    now: () => p.wall + p.skew,
    perf: { timeOrigin: loadedAt + wallSkewMs, now: () => p.wall - loadedAt },
  };
}

function clockObjects(t: FakeTransport): ClockObject[] {
  const out: ClockObject[] = [];
  t.subscribe(slidesPath(ROOM), CLOCK_TRACK, ({ payload }) => out.push(JSON.parse(new TextDecoder().decode(payload))));
  return out;
}

const clocks: RoomClock[] = [];
afterEach(() => clocks.splice(0).forEach((c) => c.stop()));

function newClock(p: ReturnType<typeof page>) {
  const c = new RoomClock(ROOM, { now: p.now, perf: p.perf, catalogWaitMs: 20, repeatMs: 30 });
  clocks.push(c);
  return c;
}

describe("room clock: choosing the offset (design §4.5)", () => {
  it("follows wall time since the room's first broadcast", () => {
    const E = 1_000_000;
    // A page loaded 5 s after E, capturing 2 s later: room time = 7 s.
    const offset = chooseOffset({ epochMs: E, endMs: undefined, timeOrigin: E + 5_000, perfNow: 2_000 });
    expect(2_000 + offset).toBe(7_000);
  });

  it("starts a new broadcast after the last archived slice when this device's clock runs behind", () => {
    const E = 1_000_000;
    const offset = chooseOffset({ epochMs: E, endMs: 600_000, timeOrigin: E + 100_000, perfNow: 50 });
    expect(50 + offset).toBe(604_000);
  });

  it("reads epoch_ms and end_ms from the catalog", () => {
    expect(parseCatalogClock(enc({ epoch_ms: 5, end_ms: 9, tracks: [] }))).toEqual({ epochMs: 5, endMs: 9 });
    expect(parseCatalogClock(enc({ epoch_ms: null, end_ms: null }))).toEqual({ epochMs: undefined, endMs: undefined });
    expect(parseCatalogClock(new TextEncoder().encode("x"))).toBeUndefined();
  });
});

describe("room clock: the speaker console", () => {
  it("the room's first broadcast sets epoch_ms to now, and room time starts near 0", async () => {
    const t = new FakeTransport();
    const p = page(10_000_000);
    p.advance(8_000); // the speaker took 8 s to press "Go on air"
    const seen = clockObjects(t);
    const clock = newClock(p);
    const object = await clock.start(t, t);
    expect(object.epoch_ms).toBe(p.now());
    expect(clock.roomTime()).toBe(0);
    p.advance(1_500);
    expect(clock.stamp()).toBe(1_500);
    expect(seen[0]).toEqual(object);
    expect(parseClock(enc(seen[0]))).toBe(object.offset_ms);
  });

  it("publishes the clock before it resolves, and again every few seconds", async () => {
    const t = new FakeTransport();
    const seen = clockObjects(t);
    const clock = newClock(page(1_000));
    await clock.start(t, t);
    expect(seen).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.length).toBeGreaterThanOrEqual(3);
    clock.stop();
    const n = seen.length;
    await new Promise((r) => setTimeout(r, 70));
    expect(seen).toHaveLength(n);
  });

  it("a reload continues the room clock from the catalog: a real gap, never back", async () => {
    const t = new FakeTransport();
    const first = page(50_000_000);
    const a = newClock(first);
    const { epoch_ms } = await a.start(t, t);
    first.advance(120_000);
    const before = a.stamp();
    a.stop();
    // The archiver's catalog now knows the room's epoch and its latest room time.
    t.announce(catalogPath(ROOM));
    t.emitJson(catalogPath(ROOM), CATALOG_TRACK, { epoch_ms, end_ms: before });
    // The speaker reloads 30 s later.
    const second = page(first.now() + 30_000);
    second.advance(2_000);
    const b = newClock(second);
    const object = await b.start(t, t);
    expect(object.epoch_ms).toBe(epoch_ms);
    expect(b.roomTime()).toBe(before + 32_000);
  });

  it("a reconnect from a device whose clock runs behind still moves room time forward", async () => {
    const t = new FakeTransport();
    const first = page(50_000_000);
    const a = newClock(first);
    const { epoch_ms } = await a.start(t, t);
    first.advance(300_000);
    const before = a.stamp();
    a.stop();
    t.announce(catalogPath(ROOM));
    t.emitJson(catalogPath(ROOM), CATALOG_TRACK, { epoch_ms, end_ms: before });
    // A second laptop, its clock 10 minutes slow.
    const laptop = page(first.now() + 1_000, -600_000);
    const b = newClock(laptop);
    await b.start(t, t);
    expect(b.roomTime()).toBeGreaterThan(before);
    expect(b.roomTime()).toBe(before + 4_000);
  });

  it("restarting on the same page without a readable catalog never goes back", async () => {
    const t = new FakeTransport();
    const p = page(70_000_000);
    const clock = newClock(p);
    const first = await clock.start(t, t);
    p.advance(60_000);
    const before = clock.stamp();
    clock.stop();
    p.advance(5_000);
    const second = await clock.start(t, t); // no catalog: the page remembers the epoch and what it stamped
    expect(second.epoch_ms).toBe(first.epoch_ms);
    expect(clock.roomTime()).toBeGreaterThanOrEqual(before);
    expect(clock.roomTime()).toBe(65_000);
  });
});
