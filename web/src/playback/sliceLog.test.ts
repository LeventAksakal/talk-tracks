import { describe, expect, it } from "vitest";
import { SliceLog } from "./sliceLog";
import { mergeRanges, sliceOf } from "./slices";
import { encodeCarry, encodeItem, encodeOutline, type LineItem, parseObject } from "./wire";

const line = (id: number, startMs: number, text: string, final = true): LineItem => ({
  type: "line",
  id,
  startMs,
  endMs: startMs + 2_000,
  text,
  final,
});

describe("wire adapter", () => {
  const o = { agent: { name: "captions", label: "Captions", model: "fake" }, lang: "en", kind: "captions" as const };

  it("round-trips a carry-in, an item and an outline", () => {
    const carry = parseObject(encodeCarry(o, 7, [line(1, 26_000, "a")], true));
    expect(carry).toMatchObject({
      ok: true,
      value: { kind: "carry", slice: 7, capped: true, items: [{ id: 1, text: "a" }] },
    });
    const item = parseObject(encodeItem(o, 7, line(2, 28_000, "b", false)));
    expect(item).toMatchObject({ ok: true, value: { kind: "item", item: { id: 2, final: false } } });
    const outline = parseObject(
      encodeOutline({ ...o, kind: "outline" }, 3, { lang: "en", chapters: [], glossary: [], recap: "r" }),
    );
    expect(outline).toMatchObject({ ok: true, value: { kind: "snapshot", outline: { recap: "r" } } });
  });

  it("refuses what is not the contract", () => {
    expect(parseObject(new TextEncoder().encode("{}"))).toMatchObject({ ok: false });
    expect(parseObject(new TextEncoder().encode("nope"))).toMatchObject({ ok: false });
    const v1 = { v: 1, agent: o.agent, instance: "1", seq: 1, at_ms: 1, usage: {}, state: { kind: "captions" } };
    expect(parseObject(new TextEncoder().encode(JSON.stringify(v1)))).toMatchObject({ ok: false });
  });
});

describe("SliceLog", () => {
  it("merges by id across slices: final beats interim, wherever it landed", () => {
    const log = new SliceLog();
    log.addLive(2, { items: [], capped: false }, undefined);
    log.addLive(2, undefined, line(5, 9_000, "half", false));
    log.addLive(3, { items: [], capped: false }, undefined);
    log.addLive(3, undefined, line(5, 9_000, "half then whole"));
    log.addLive(3, undefined, line(6, 13_000, "next", false));
    expect(log.view(undefined).lines.map((l) => [l.id, l.text, l.final])).toEqual([
      [5, "half then whole", true],
      [6, "next", false],
    ]);
  });

  it("a carry-in gives the state at a slice start; items show from their own media time", () => {
    const log = new SliceLog();
    log.addFetched(10, { items: [line(8, 36_000, "eight"), line(9, 38_000, "nine")], capped: false }, [
      line(10, 40_500, "ten"),
      line(11, 42_500, "eleven"),
    ]);
    expect(log.view(41_000).lines.map((l) => l.id)).toEqual([8, 9, 10]);
    expect(log.view(41_000).current?.id).toBe(10);
    expect(log.view(40_100).lines.map((l) => l.id)).toEqual([8, 9]);
  });

  it("a live copy of a group replaces a fetched one, never the reverse", () => {
    const log = new SliceLog();
    log.addLive(4, { items: [], capped: false }, undefined);
    log.addFetched(4, { items: [], capped: true }, []);
    expect(log.get(4)).toMatchObject({ origin: "live", capped: false });
    log.addFetched(5, undefined, [line(1, 20_000, "x")]);
    log.addLive(5, { items: [], capped: false }, undefined);
    expect(log.get(5)).toMatchObject({ origin: "live", items: [] });
    log.dropFetched();
    expect(log.slices()).toEqual([4, 5]);
  });

  it("trims the slices farthest from the playhead", () => {
    const log = new SliceLog();
    for (let k = 0; k < 10; k++) log.addFetched(k, undefined, []);
    log.trim(4, 6);
    expect(log.slices()).toEqual([5, 6, 7, 8]);
    expect(log.ranges()).toEqual([{ start: 20_000, end: 36_000 }]);
  });
});

describe("slices", () => {
  it("time to slice is arithmetic", () => {
    expect([0, 3_999, 4_000, 61_000].map(sliceOf)).toEqual([0, 0, 1, 15]);
  });

  it("merges touching ranges", () => {
    expect(
      mergeRanges([
        { start: 8, end: 12 },
        { start: 0, end: 4 },
        { start: 4, end: 6 },
      ]),
    ).toEqual([
      { start: 0, end: 6 },
      { start: 8, end: 12 },
    ]);
  });
});
