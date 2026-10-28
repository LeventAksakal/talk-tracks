import { describe, expect, it } from "vitest";
import { demoEvents } from "../demo/script";
import { captions, envelope } from "../test/envelopes";
import { roomMs, wallUnixMs, type CueObject, type OutlineObject, type RoomCatalog, type SlideObject } from "./types";
import {
  isLegacyEnvelope,
  parseCueObject,
  parseLegacyEnvelope,
  parseOutlineObject,
  parseRoomCatalog,
  parseSlideFrame,
  parseSlideObject,
} from "./validate";

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const cue = { start: 12000, end: 13500, id: "12000", text: "Hello", rev: 1, final: true };
const note = { m: 12000, data: { tt: { from: 12400 } } };

describe("event-timeline objects", () => {
  it("accepts carry-ins and incremental records of every track", () => {
    const cues: CueObject[] = [
      [note, { m: 12000, data: cue }],
      [{ m: 12000, data: { tt: { capped: true } } }],
      [{ m: 12000, data: { start: 12000, end: 12000, id: "12000", text: "Hel", final: false } }],
      [],
    ];
    for (const o of cues) expect(parseCueObject(json(o)).ok, JSON.stringify(o)).toBe(true);
    const slides: SlideObject[] = [[{ m: 12500, data: { id: 0, at: 12500, text: "A chart" } }]];
    for (const o of slides) expect(parseSlideObject(json(o)).ok).toBe(true);
    const outline: OutlineObject = [
      { m: 0, data: { kind: "chapter", id: 0, start: 0, title: "Intro", summary: "Hi" } },
      { m: 9000, data: { kind: "term", term: "MoQ", definition: "Media over QUIC" } },
      { m: 9000, data: { kind: "recap", text: "So far" } },
    ];
    expect(parseOutlineObject(json(outline)).ok).toBe(true);
  });

  it("rejects objects that break the contract", () => {
    const bad: unknown[] = [
      { m: 12000, data: cue },
      [{ m: 11000, data: cue }],
      [{ m: 12000, data: { ...cue, end: 11000 } }],
      [{ m: 12000, data: { ...cue, id: 12000 } }],
      [{ m: 12000, data: { ...cue, extra: 1 } }],
      [{ m: 12000, data: { ...cue, final: undefined } }],
      [{ m: 12000, data: cue }, note],
      [{ m: 12000, data: { tt: { from: -1 } } }],
      [{ m: -1, data: cue }],
    ];
    for (const value of bad) expect(parseCueObject(json(value)).ok, JSON.stringify(value)).toBe(false);
    expect(parseSlideObject(json([{ m: 1, data: { id: 0, at: 2, text: "x" } }])).ok).toBe(false);
    expect(
      parseOutlineObject(json([{ m: 1, data: { kind: "chapter", id: 0, start: 0, title: "", summary: "" } }])).ok,
    ).toBe(false);
    expect(parseCueObject(new Uint8Array([0xff, 0x00, 0x7b])).ok).toBe(false);
  });

  it("does not take a v1 envelope for an object", () => {
    expect(parseCueObject(json(envelope())).ok).toBe(false);
  });
});

describe("room catalog and room time", () => {
  const catalog: RoomCatalog = {
    version: "draft-01",
    tracks: [
      {
        name: "items",
        namespace: "talk/r/agents/captions",
        packaging: "eventtimeline",
        mimeType: "application/json",
        eventType: "urn:msf:captions:webvtt",
        role: "caption",
        lang: "en",
        isLive: true,
        template: [0, 4000, [0, 0], [1, 0], 1_800_000_000_000, 4000],
        tt: { dependsOn: [], latenessMs: 4000, cost: "paid" },
      },
    ],
    tt: {
      E: 1_800_000_000_000,
      shift: { "300000000000000": 0 },
      status: {
        captions: { status: "live", producing: true, fetches_served: 0, backfills: 0, spend_usd: 0.1, updated_ms: 1 },
      },
    },
  };

  it("accepts the catalog and rejects a broken one", () => {
    expect(parseRoomCatalog(json(catalog)).ok).toBe(true);
    expect(parseRoomCatalog(json({ ...catalog, tt: { ...catalog.tt, E: 1 } })).ok).toBe(false);
    expect(parseRoomCatalog(json({ ...catalog, tt: { E: 0 } })).ok).toBe(false);
  });

  it("maps a media timestamp to room time", () => {
    const wall = wallUnixMs(300_000_000_000_000, 1_000_000, 1_500);
    expect(wall).toBe(1_577_836_800_000 + 300_000_000_000 + 1_500);
    expect(roomMs(wall, 1_577_836_800_000 + 300_000_000_000, 8000)).toBe(9_500);
  });
});

describe("legacy envelope (v1) validation", () => {
  it("accepts the full-state snapshots the room store and demo script still use", () => {
    expect(parseLegacyEnvelope(json(envelope({ state: captions(["Hello"], "and") }))).ok).toBe(true);
    expect(parseLegacyEnvelope(json({ ...envelope(), seq: -1 })).ok).toBe(false);
  });

  it("accepts every envelope the demo script publishes", () => {
    const { events } = demoEvents("demo");
    const emitted = events.filter((e) => e.type === "emit");
    expect(emitted.length).toBeGreaterThan(50);
    for (const e of emitted) expect(isLegacyEnvelope(e.value), JSON.stringify(e.value)).toBe(true);
  });
});

describe("slide frame validation", () => {
  it("accepts a JPEG frame and rejects other mime types", () => {
    const frame = { id: 0, at_ms: 10, mime: "image/jpeg", data_b64: "AAAA" };
    expect(parseSlideFrame(JSON.stringify(frame)).ok).toBe(true);
    expect(parseSlideFrame(JSON.stringify({ ...frame, mime: "image/gif" })).ok).toBe(false);
    expect(parseSlideFrame(JSON.stringify({ ...frame, data_b64: undefined })).ok).toBe(false);
  });
});
