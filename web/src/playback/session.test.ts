// Demo sessions (decision 0032; wiki/howto/demo-rooms.md): each session is a new room epoch E and a teacher hang
// catalog with `talk_tracks: {session, duration_ms, session_ms}`. The player ends the old session and joins the new
// one at 00:00; the lecture's file plays once, session time t at lecture time t.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOQ_EPOCH_UNIX_MS } from "../contracts/types";
import { loopInfo, loopOf, loopPlace, loopWall } from "./loopArchive";
import { sessionOf, type SessionSource, watchSessions } from "./session";

const E = Date.parse("2026-11-03T09:00:00Z");
const hang = (session: number, clock = E) => ({
  clock: { wall: (clock - MOQ_EPOCH_UNIX_MS) * 1000, timescale: 1_000_000 },
  talk_tracks: { session, duration_ms: 600_000, session_ms: 620_000 },
});

function source(key: { epoch?: number; session?: string }) {
  const listeners = new Set<() => void>();
  const s: SessionSource & { set(next: { epoch?: number; session?: string }): void } = {
    sessionKey: () => key,
    onChange: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set(next) {
      key = next;
      listeners.forEach((l) => l());
    },
  };
  return s;
}

describe("demo sessions", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads a session from the teacher's hang catalog, and none from a room without one", () => {
    expect(sessionOf(hang(3))?.id).toBe("3");
    expect(sessionOf({ clock: { wall: (E - MOQ_EPOCH_UNIX_MS) * 1000, timescale: 1_000_000 } })).toBeUndefined();
  });

  it("ends the session when the room's E changes, then joins the new one shortly after", () => {
    const s = source({ epoch: E, session: "1" });
    const ended = vi.fn();
    const restart = vi.fn();
    watchSessions(s, { ended, restart }, { endCardMs: 2_000 });
    s.set({ epoch: E, session: "1" });
    expect(ended).not.toHaveBeenCalled();
    s.set({ epoch: E + 640_000, session: "2" });
    expect(ended).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("takes a session id arriving after E as this session's, not a new one", () => {
    const s = source({ epoch: E });
    const ended = vi.fn();
    watchSessions(s, { ended, restart: () => {} });
    s.set({ epoch: E, session: "4" });
    expect(ended).not.toHaveBeenCalled();
  });

  it("plays a session's lecture once: time t is lecture time t, with no wrap at the lecture's length", () => {
    const loop = loopOf(hang(1));
    expect(loop).toBeDefined();
    const info = loopInfo(loop!);
    expect(loopPlace(info, E + 125_000)).toEqual({ loop: 0, fileMs: 125_000 });
    // Past the lecture's end (the recording's tail) it does not start over.
    expect(loopPlace(info, E + 700_000)).toEqual({ loop: 0, fileMs: 700_000 });
    expect(loopWall(info, 0, 125_000)).toBe(E + 125_000);
  });

  it("still loops a looped room (a period in its hang catalog)", () => {
    const loop = loopOf({
      clock: { wall: (E - MOQ_EPOCH_UNIX_MS) * 1000, timescale: 1_000_000 },
      talk_tracks: { period_ms: 1_024_000, duration_ms: 1_020_200 },
    });
    expect(loopPlace(loopInfo(loop!), E + 1_024_000 + 5_000)).toEqual({ loop: 1, fileMs: 5_000 });
  });
});
