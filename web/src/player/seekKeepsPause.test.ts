// A seek never changes play or pause (owner QA, 11-04): "I seek then I explicitly play." Paused, a drag, a click on the
// bar, the arrow keys, a chapter or a transcript line all move the playhead and leave it paused there; playing, a
// seek keeps playing. They all land on the media element's currentTime, as Media Chrome and the player set it.

import { afterEach, describe, expect, it } from "vitest";
import { FakeHistorySource } from "../playback/fakeSource";
import { ClockMedia } from "../playback/media";
import { Playback } from "../playback/playback";
import "./roomMediaElement";
import type { RoomMediaElement } from "./roomMediaElement";

let playback: Playback | undefined;
afterEach(() => playback?.close());

/** A live room ten minutes in, playing (the offline demo's media runs on the wall clock). */
function open() {
  let wall = 1_000_000;
  const clock = { now: () => wall, advance: (ms: number) => (wall += ms) };
  const media = new ClockMedia({ now: clock.now, tickMs: 0 });
  media.setLiveEdge(600_000);
  playback = new Playback(new FakeHistorySource(), media, "lecture", { now: clock.now, liveBack: 0 });
  const el = document.createElement("tt-room-media") as RoomMediaElement;
  el.bind(playback);
  el.setSpan({ origin: 0, recording: undefined });
  const later = (ms: number) => {
    clock.advance(ms);
    media.tick();
  };
  return { el, later };
}

describe("A seek", () => {
  it("leaves a paused rewind paused at the new place until play", () => {
    const { el, later } = open();
    el.currentTime = 120;
    el.pause();
    el.currentTime = 300;
    expect(el.paused).toBe(true);
    later(5_000);
    expect(el.currentTime).toBeCloseTo(300, 0);
    void el.play();
    later(5_000);
    expect(el.paused).toBe(false);
    expect(el.currentTime).toBeCloseTo(305, 0);
  });

  it("from a paused live stream moves back and stays paused", () => {
    const { el, later } = open();
    el.pause();
    el.currentTime = 200;
    expect(el.paused).toBe(true);
    later(4_000);
    expect(el.currentTime).toBeCloseTo(200, 0);
  });

  it("to the live edge while paused stays paused", () => {
    const { el, later } = open();
    el.currentTime = 100;
    el.pause();
    el.currentTime = 600;
    expect(el.paused).toBe(true);
    const held = el.currentTime;
    later(3_000);
    expect(el.currentTime).toBeCloseTo(held, 0);
  });

  it("while playing keeps playing", () => {
    const { el, later } = open();
    el.currentTime = 100;
    expect(el.paused).toBe(false);
    later(2_000);
    expect(el.currentTime).toBeCloseTo(102, 0);
  });
});
