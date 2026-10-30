import { describe, expect, it } from "vitest";
import { CONFIRM_TIMEOUT_MS, FRESH_AUDIO_MS, isOwnAudio, onAirState, readVarint } from "./onair";

const base = {
  mic: "publishing" as const,
  publisherStatus: "connected" as const,
  ownAudioAgoMs: undefined,
  otherSpeaker: false,
  elapsedMs: 1_000,
};

/** A legacy-container audio frame: QUIC varint media time in µs (8-byte form), then the codec bytes. */
function legacyFrame(us: number): Uint8Array {
  const out = new Uint8Array(8 + 3);
  let v = us;
  for (let i = 7; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] = (out[0]! & 0x3f) | 0xc0;
  return out;
}

describe("onAirState", () => {
  it("is on air only while the anonymous watcher gets this page's own audio back", () => {
    expect(onAirState(base).kind).toBe("confirming");
    expect(onAirState({ ...base, ownAudioAgoMs: 200 }).kind).toBe("on-air");
    expect(onAirState({ ...base, ownAudioAgoMs: FRESH_AUDIO_MS }).kind).toBe("confirming");
  });

  it("calls a silent refusal after the timeout", () => {
    const s = onAirState({ ...base, elapsedMs: CONFIRM_TIMEOUT_MS });
    expect(s.kind).toBe("refused");
    expect(s.kind === "refused" && s.reason).toMatch(/token/);
  });

  it("explains an occupied room", () => {
    expect(onAirState({ ...base, otherSpeaker: true })).toEqual({ kind: "confirming", occupied: true });
    const s = onAirState({ ...base, otherSpeaker: true, elapsedMs: CONFIRM_TIMEOUT_MS });
    expect(s.kind === "refused" && s.reason).toMatch(/Another speaker/);
  });

  it("notices when the relay stops carrying the microphone", () => {
    const s = onAirState({ ...base, ownAudioAgoMs: 8_000, elapsedMs: 60_000 });
    expect(s.kind === "refused" && s.reason).toMatch(/stopped/);
  });

  it("surfaces microphone and connection failures", () => {
    expect(onAirState({ ...base, mic: "error", micError: "denied" })).toEqual({ kind: "error", reason: "denied" });
    expect(onAirState({ ...base, publisherStatus: "failed" }).kind).toBe("error");
    expect(onAirState({ ...base, mic: "off" }).kind).toBe("off");
  });
});

describe("own audio recognition", () => {
  it("reads QUIC varints of every length", () => {
    expect(readVarint(new Uint8Array([0x25]))).toEqual([37, 1]);
    expect(readVarint(new Uint8Array([0x7b, 0xbd]))).toEqual([15_293, 2]);
    expect(readVarint(new Uint8Array([0x9d, 0x7f, 0x3e, 0x7d]))).toEqual([494_878_333, 4]);
    expect(readVarint(legacyFrame(123_456_789_000))).toEqual([123_456_789_000, 8]);
    expect(() => readVarint(new Uint8Array([0x80, 1]))).toThrow();
  });

  it("takes frames stamped near this page's clock as its own", () => {
    expect(isOwnAudio(legacyFrame(60_000_000), 60_400)).toBe(true);
    expect(isOwnAudio(legacyFrame(60_000_000), 900_000)).toBe(false);
    expect(isOwnAudio(new Uint8Array(), 0)).toBe(false);
  });
});
