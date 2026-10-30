import { describe, expect, it } from "vitest";
import carryIns from "../../../contracts/examples/carry-ins.json";
import objects from "../../../contracts/examples/objects.json";
import { commentsCarry, currentSlide, inkCarry, lastRecord, upTo } from "./tracks";
import type { CommentRecord, CurrentSlideRecord, InkRecord, RoomCatalog } from "./types";
import {
  parseCommentsObject,
  parseCurrentSlideObject,
  parseDeckObject,
  parseInkObject,
  parsePointerObject,
  parseRoomCatalog,
  parseRoomStateObject,
  type Parsed,
} from "./validate";

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const parsers: Record<string, (payload: Uint8Array) => Parsed<unknown>> = {
  "deck-object.schema.json": parseDeckObject,
  "current-slide-object.schema.json": parseCurrentSlideObject,
  "ink-object.schema.json": parseInkObject,
  "pointer-object.schema.json": parsePointerObject,
  "comments-object.schema.json": parseCommentsObject,
  "room-state-object.schema.json": parseRoomStateObject,
};

describe("speaker and room event track objects", () => {
  it("accepts every example object the agents' models produce, unchanged", () => {
    const examples = objects as Record<string, unknown[]>;
    expect(Object.keys(examples).sort()).toEqual(Object.keys(parsers).sort());
    for (const [name, list] of Object.entries(examples)) {
      for (const o of list) {
        const parsed = parsers[name]!(json(o));
        expect(parsed, `${name} ${JSON.stringify(o)}`).toEqual({ ok: true, value: o });
      }
    }
  });

  const begin = { kind: "begin", stroke: "s", deck: 0, index: 0, tool: "pen", color: "#000000", width: 0.01 };
  const comment = { kind: "comment", id: "c", at: 5, author: "A", text: "x", anchor: { deck: 0, index: 0 } };

  it("rejects objects that break the contract", () => {
    const bad: [(p: Uint8Array) => Parsed<unknown>, unknown][] = [
      [parseInkObject, [{ m: 1, data: { ...begin, points: [] } }]],
      [parseInkObject, [{ m: 1, data: { ...begin, points: [[1.5, 0]] } }]],
      [parseInkObject, [{ m: 1, data: { ...begin, points: [[0.5]] } }]],
      [parseInkObject, [{ m: 1, data: { ...begin, color: "red", points: [[0, 0]] } }]],
      [parseInkObject, [{ m: 1, data: { kind: "erase", strokes: [] } }]],
      [parsePointerObject, [{ m: 1, data: { kind: "at", x: 0.5, y: -0.1 } }]],
      [parseCurrentSlideObject, [{ m: 1, data: { kind: "show", deck: 0 } }]],
      [parseDeckObject, [{ m: 1, data: { kind: "deck", count: 0, aspect: 1.5 } }]],
      [parseRoomStateObject, [{ m: 1, data: { kind: "state", state: "live" } }]],
      [parseCommentsObject, [{ m: 4, data: comment }]],
      [
        parseCommentsObject,
        [{ m: 5, data: { ...comment, anchor: { deck: 0, index: 0, span: { start: 3, end: 2 } } } }],
      ],
      [parseCommentsObject, [{ m: 5, data: { ...comment, author: "" } }]],
    ];
    for (const [parser, value] of bad) expect(parser(json(value)).ok, JSON.stringify(value)).toBe(false);
    expect(parseCommentsObject(json([{ m: 5, data: comment }])).ok).toBe(true);
  });

  it("reads a room catalog that lists the speaker's sources", () => {
    const catalog: RoomCatalog = {
      version: "draft-01",
      tracks: [{ name: "ink", namespace: "talk/r/slides", packaging: "eventtimeline", tt: { cost: "free" } }],
      tt: {
        E: 1_800_000_000_000,
        shift: {},
        sources: [
          { kind: "camera", namespace: "talk/r/teacher", tracks: ["catalog.json"] },
          { kind: "slides", namespace: "talk/r/slides", tracks: ["deck", "slide", "ink", "pointer"] },
        ],
      },
    };
    expect(parseRoomCatalog(json(catalog)).ok).toBe(true);
    const projector = { kind: "projector", namespace: "talk/r/x", tracks: ["a"] };
    expect(parseRoomCatalog(json({ ...catalog, tt: { ...catalog.tt, sources: [projector] } })).ok).toBe(false);
  });
});

interface Cut {
  on: CurrentSlideRecord["data"] | null;
  slide: { records: CurrentSlideRecord[]; carry: CurrentSlideRecord[] };
  ink: { records: InkRecord[]; carry: InkRecord[] };
  pointer: { records: unknown[]; carry: unknown[] };
  comments: { records: CommentRecord[]; carry: CommentRecord[] };
  room: { records: unknown[]; carry: unknown[] };
}

describe("carry-ins", () => {
  const cuts = Object.entries(carryIns as unknown as Record<string, Cut>);

  it("builds the same carry-ins as the agents", () => {
    expect(cuts.length).toBeGreaterThan(0);
    for (const [at, cut] of cuts) {
      const on = currentSlide(cut.slide.records);
      expect(on, at).toEqual(cut.on);
      expect(lastRecord(cut.slide.records), at).toEqual(cut.slide.carry);
      expect(lastRecord(cut.pointer.records), at).toEqual(cut.pointer.carry);
      expect(lastRecord(cut.room.records), at).toEqual(cut.room.carry);
      expect(inkCarry(cut.ink.records, on), at).toEqual(cut.ink.carry);
      expect(commentsCarry(cut.comments.records, on), at).toEqual(cut.comments.carry);
    }
  });

  it("draws the state at a time from one group: its carry-in and records up to then", () => {
    const [, first] = cuts[0]!;
    const [, last] = cuts.at(-1)!;
    const inSlice = last.ink.records.slice(first.ink.records.length);
    const slideChanges = last.slide.records.slice(first.slide.records.length);
    const group = [first.ink.carry, inSlice];
    const slides = [first.slide.carry, slideChanges];
    const end = Number.MAX_SAFE_INTEGER;
    expect(inkCarry(upTo(group, end), currentSlide(upTo(slides, end)))).toEqual(last.ink.carry);
    // Before anything in the slice happened, the carry-in alone is what shows.
    const start = Math.min(...[...inSlice, ...slideChanges].map((r) => r.m)) - 1;
    expect(inkCarry(upTo(group, start), currentSlide(upTo(slides, start)))).toEqual(first.ink.carry);
  });
});
