import { describe, expect, it } from "vitest";
import { demoEvents } from "../demo/script";
import { captions, envelope } from "../test/envelopes";
import type { Envelope } from "./types";
import {
  isEnvelope,
  isLegacyEnvelope,
  parseEnvelope,
  parseLegacyEnvelope,
  parseRoomClock,
  parseSlideFrame,
} from "./validate";

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const base = {
  v: 2,
  agent: { name: "captions", label: "Captions", model: "fake" },
  slice: 3,
  at_ms: 1,
  usage: { requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
} as const;

const line = { id: 12000, start_ms: 12000, end_ms: 13500, text: "Hello" };

describe("envelope v2 validation", () => {
  it("accepts every kind of body", () => {
    const envelopes: Envelope[] = [
      { ...base, kind: "carry", body: { type: "captions-carry", lang: "en", lines: [line] } },
      { ...base, kind: "carry", capped: true, body: { type: "captions-carry", lang: "en", lines: [] } },
      { ...base, kind: "item", body: { type: "caption", lang: "en", line, final: true } },
      {
        ...base,
        kind: "carry",
        body: { type: "translation-carry", lang: "tr", lines: [{ id: 12000, text: "Merhaba" }] },
      },
      {
        ...base,
        kind: "item",
        body: { type: "translation", lang: "tr", line: { id: 12000, start_ms: 12000, end_ms: 13500, text: "Merhaba" } },
      },
      { ...base, kind: "carry", body: { type: "slides-carry", lang: "en", slide: null } },
      {
        ...base,
        kind: "item",
        body: { type: "slide", lang: "en", slide: { id: 0, at_ms: 12500, description: "A chart" } },
      },
      {
        ...base,
        kind: "snapshot",
        body: {
          type: "outline",
          lang: "en",
          chapters: [{ id: 0, start_ms: 0, title: "Intro", summary: "Hi" }],
          glossary: [{ term: "MoQ", definition: "Media over QUIC" }],
          recap: "So far",
        },
      },
    ];
    for (const e of envelopes) {
      const parsed = parseEnvelope(json(e));
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    }
  });

  it("accepts the defaults the agents may leave out (v, capped, usage fields)", () => {
    const minimal = { ...base, usage: {}, kind: "item", body: { type: "caption", lang: "en", line, final: false } };
    delete (minimal as { v?: number }).v;
    expect(isEnvelope(minimal)).toBe(true);
  });

  it("rejects objects that break the contract", () => {
    const item = { ...base, kind: "item", body: { type: "caption", lang: "en", line, final: true } };
    const bad: unknown[] = [
      { ...item, extra: 1 },
      { ...item, v: 1 },
      { ...item, slice: -1 },
      { ...item, seq: 0 },
      { ...item, instance: "1000" },
      { ...item, kind: "carry" },
      { ...item, kind: "snapshot" },
      { ...item, capped: true },
      { ...item, body: { type: "caption", lang: "en", line: { id: 0, text: "no times" }, final: true } },
      { ...item, body: { type: "weather", lang: "en" } },
      { ...base, kind: "carry", body: { type: "captions-carry", lang: "en", lines: [line, line, line] } },
      { ...base, kind: "carry", body: { type: "translation-carry", lang: "tr", lines: [], extra: true } },
    ];
    for (const value of bad) expect(parseEnvelope(json(value)).ok, JSON.stringify(value)).toBe(false);
  });

  it("rejects payloads that are not JSON", () => {
    const parsed = parseEnvelope(new Uint8Array([0xff, 0x00, 0x7b]));
    expect(parsed.ok).toBe(false);
  });

  it("does not take a v1 envelope for a v2 one", () => {
    expect(isEnvelope(envelope())).toBe(false);
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

describe("room clock validation", () => {
  it("accepts the clock object and rejects a broken one", () => {
    const clock = { epoch_ms: 1_793_000_000_000, offset_ms: 86_400, session: "1793000086400" };
    expect(parseRoomClock(JSON.stringify(clock)).ok).toBe(true);
    expect(parseRoomClock(JSON.stringify({ ...clock, session: "" })).ok).toBe(false);
    expect(parseRoomClock(JSON.stringify({ ...clock, offset_ms: "1" })).ok).toBe(false);
    expect(parseRoomClock(JSON.stringify({ epoch_ms: 1, offset_ms: 0 })).ok).toBe(false);
  });
});
