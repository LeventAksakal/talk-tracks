// A recording played to its end really ends (judges' round 2): the element is paused, says ended, fires pause and
// ended, and reports its data as there (no "waiting", so no spinner). Playback used to go live by itself as the
// archive ran out, a little before the last frame, and a recording has no live side: it waited there for ever.
// Replay from the end starts at 0:00 and plays.

import { afterEach, describe, expect, it } from "vitest";
import { FakeHistorySource } from "../playback/fakeSource";
import { ClockMedia } from "../playback/media";
import { Playback } from "../playback/playback";
import "./roomMediaElement";
import type { RoomMediaElement } from "./roomMediaElement";

const END = 120_000;

/** An ended room's media: its edge stands still at the recording's end, and live there is nothing more to load. */
class RecordingMedia extends ClockMedia {
  override liveEdge(): number {
    return END;
  }
  override status() {
    return this.mode() === "live" ? ("loading" as const) : ("playing" as const);
  }
}

let playback: Playback | undefined;
afterEach(() => playback?.close());

function open() {
  let wall = 1_000_000;
  const clock = { now: () => wall, advance: (ms: number) => (wall += ms) };
  const media = new RecordingMedia({ now: clock.now, tickMs: 0 });
  playback = new Playback(new FakeHistorySource(), media, "lecture", { now: clock.now, liveBack: 0 });
  const el = document.createElement("tt-room-media") as RoomMediaElement;
  const events: string[] = [];
  for (const type of ["play", "pause", "ended", "waiting", "playing"])
    el.addEventListener(type, () => events.push(type));
  el.bind(playback);
  el.setSpan({ origin: 0, recording: { start: 0, end: END } });
  // The player opens a recording at 0:00.
  el.currentTime = 0;
  return { el, media, clock, events };
}

describe("A recording played to its end", () => {
  it("is paused and ended, with its data there, once playback runs out of archive", () => {
    const { el, media, clock, events } = open();
    expect(el.paused).toBe(false);
    events.length = 0;
    clock.advance(END - 200);
    media.tick();
    expect(playback!.media.mode()).toBe("rewound"); // a recording stays on its archive, at its last frame
    expect(el.ended).toBe(true);
    expect(el.paused).toBe(true);
    expect(events).toContain("pause");
    expect(events).toContain("ended");
    expect(events).not.toContain("waiting");
    expect(el.readyState).toBe(4);
    expect(el.currentTime).toBeCloseTo(END / 1000, 0);
  });

  it("replays from 0:00 and plays", () => {
    const { el, media, clock } = open();
    clock.advance(END - 200);
    media.tick();
    expect(el.ended).toBe(true);
    void el.play();
    expect(el.ended).toBe(false);
    expect(el.paused).toBe(false);
    expect(playback!.media.mode()).toBe("rewound");
    expect(el.currentTime).toBe(0);
    clock.advance(5_000);
    media.tick();
    expect(el.currentTime).toBeCloseTo(5, 0);
    expect(el.ended).toBe(false);
  });

  it("ends, rather than waits, when something takes it live from a rewind", () => {
    const { el, events } = open();
    events.length = 0;
    playback!.goLive();
    expect(el.ended).toBe(true);
    expect(el.paused).toBe(true);
    expect(el.readyState).toBe(4);
    expect(events).not.toContain("waiting");
  });

  it("a seek to its end plays the last second and ends there", () => {
    const { el, media, clock } = open();
    el.currentTime = END / 1000;
    expect(playback!.media.mode()).toBe("rewound");
    expect(el.ended).toBe(false);
    clock.advance(1_000);
    media.tick();
    expect(el.ended).toBe(true);
  });

  it("does not end on opening, before the playhead has moved to 0:00", () => {
    let wall = 1_000_000;
    const media = new RecordingMedia({ now: () => wall, tickMs: 0 });
    playback = new Playback(new FakeHistorySource(), media, "lecture", { now: () => wall, liveBack: 0 });
    const el = document.createElement("tt-room-media") as RoomMediaElement;
    el.bind(playback);
    el.setSpan({ origin: 0, recording: { start: 0, end: END } });
    wall += 1_000;
    media.tick();
    expect(el.ended).toBe(false);
  });
});
