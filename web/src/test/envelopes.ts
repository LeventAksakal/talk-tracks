import type { LegacyEnvelope as Envelope, State } from "../contracts/types";

export function envelope(overrides: Partial<Envelope> & { state?: State } = {}): Envelope {
  return {
    v: 1,
    agent: { name: "captions", label: "Captions", model: "fake" },
    instance: "1000",
    seq: 0,
    at_ms: 1,
    usage: { requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    state: { kind: "captions", lang: "en", lines: [], interim: "" },
    ...overrides,
  };
}

export function captions(texts: string[], interim = ""): State {
  return {
    kind: "captions",
    lang: "en",
    lines: texts.map((text, id) => ({ id, start_ms: id * 1000, end_ms: id * 1000 + 900, text })),
    interim,
  };
}
