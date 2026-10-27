import { describe, expect, it } from "vitest";
import { demoEvents } from "../demo/script";
import { captions, envelope } from "../test/envelopes";
import { isEnvelope, parseEnvelope, parseSlideFrame } from "./validate";

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("envelope validation", () => {
  it("accepts every kind of state", () => {
    const states = [
      captions(["Hello"], "and"),
      { kind: "translation", lang: "tr", lines: [{ id: 0, text: "Merhaba" }] },
      { kind: "slides", lang: "en", slides: [{ id: 0, at_ms: 5, description: "A chart" }] },
      {
        kind: "outline",
        lang: "en",
        chapters: [{ id: 0, start_ms: 0, title: "Intro", summary: "Hi" }],
        glossary: [{ term: "MoQ", definition: "Media over QUIC" }],
        recap: "So far",
      },
    ];
    for (const state of states) {
      const parsed = parseEnvelope(json(envelope({ state: state as never })));
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    }
  });

  it("accepts the defaults the agents may leave out (kind-less interim, recap, usage fields)", () => {
    const e = envelope();
    const minimal = { ...e, usage: {}, state: { kind: "captions", lang: "en", lines: [] } };
    delete (minimal as { v?: number }).v;
    expect(isEnvelope(minimal)).toBe(true);
  });

  it("rejects objects that break the contract", () => {
    const bad: unknown[] = [
      { ...envelope(), extra: 1 },
      { ...envelope(), seq: -1 },
      { ...envelope(), v: 2 },
      { ...envelope(), instance: 1000 },
      { ...envelope(), agent: { name: "x", label: "y" } },
      { ...envelope(), state: { kind: "captions", lang: "en", lines: [{ id: 0, text: "no times" }] } },
      { ...envelope(), state: { kind: "weather", lang: "en" } },
      { ...envelope(), state: { kind: "translation", lang: "tr", lines: [], extra: true } },
    ];
    for (const value of bad) expect(parseEnvelope(json(value)).ok, JSON.stringify(value)).toBe(false);
  });

  it("rejects payloads that are not JSON", () => {
    const parsed = parseEnvelope(new Uint8Array([0xff, 0x00, 0x7b]));
    expect(parsed.ok).toBe(false);
  });

  it("accepts every envelope the demo script publishes", () => {
    const { events } = demoEvents("demo");
    const emitted = events.filter((e) => e.type === "emit");
    expect(emitted.length).toBeGreaterThan(50);
    for (const e of emitted) expect(isEnvelope(e.value), JSON.stringify(e.value)).toBe(true);
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
