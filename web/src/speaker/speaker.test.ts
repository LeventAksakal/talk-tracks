import { describe, expect, it } from "vitest";
import { CONFIRM_TIMEOUT_MS, onAirState } from "./onair";
import { CHANGE_THRESHOLD, fitWidth, frameDifference, MIN_INTERVAL_MS, shouldPublish } from "./slides";

const base = {
  mic: "publishing" as const,
  publisherStatus: "connected" as const,
  teacherLive: false,
  announcedSinceStart: false,
  liveAtStart: false,
  elapsedMs: 1_000,
};

describe("onAirState", () => {
  it("is on air only once the anonymous watcher sees the broadcast announced", () => {
    expect(onAirState(base).kind).toBe("confirming");
    expect(onAirState({ ...base, teacherLive: true }).kind).toBe("confirming");
    expect(onAirState({ ...base, teacherLive: true, announcedSinceStart: true }).kind).toBe("on-air");
  });

  it("calls a silent refusal after the timeout", () => {
    const s = onAirState({ ...base, elapsedMs: CONFIRM_TIMEOUT_MS });
    expect(s.kind).toBe("refused");
    expect(s.kind === "refused" && s.reason).toMatch(/token/);
  });

  it("explains an occupied room", () => {
    expect(onAirState({ ...base, liveAtStart: true, teacherLive: true })).toEqual({
      kind: "confirming",
      occupied: true,
    });
    const s = onAirState({ ...base, liveAtStart: true, teacherLive: true, elapsedMs: CONFIRM_TIMEOUT_MS });
    expect(s.kind === "refused" && s.reason).toMatch(/Another speaker/);
  });

  it("surfaces microphone and connection failures", () => {
    expect(onAirState({ ...base, mic: "error", micError: "denied" })).toEqual({ kind: "error", reason: "denied" });
    expect(onAirState({ ...base, publisherStatus: "failed" }).kind).toBe("error");
    expect(onAirState({ ...base, mic: "off" }).kind).toBe("off");
  });
});

describe("slide sharing decisions", () => {
  it("measures picture change between grey thumbnails", () => {
    const a = new Uint8Array([0, 0, 0, 0]);
    expect(frameDifference(a, a)).toBe(0);
    expect(frameDifference(a, new Uint8Array([255, 255, 255, 255]))).toBe(1);
    expect(frameDifference(undefined, a)).toBe(1);
  });

  it("publishes a visible change, at most one every two seconds", () => {
    expect(shouldPublish(CHANGE_THRESHOLD / 2, 10_000, undefined)).toBe(false);
    expect(shouldPublish(0.5, 10_000, undefined)).toBe(true);
    expect(shouldPublish(0.5, 10_000, 10_000 - MIN_INTERVAL_MS + 1)).toBe(false);
    expect(shouldPublish(0.5, 10_000, 10_000 - MIN_INTERVAL_MS)).toBe(true);
  });

  it("scales frames down to 1280 px wide, never up", () => {
    expect(fitWidth(2560, 1440)).toEqual({ width: 1280, height: 720 });
    expect(fitWidth(800, 600)).toEqual({ width: 800, height: 600 });
  });
});
