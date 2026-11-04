import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_ROOM, DEMO_START_MS } from "../pages/DemoPage";
import { createDemoPlayback } from "../playback/usePlayback";
import { FakeTransport } from "../transport/fake";
import { goTo, navRange, step, stepKey } from "./deckNav";
import { DemoSlides } from "./demoSlides";
import { Player } from "./Player";
import { SlideTracks } from "./slideTracks";

describe("paging the deck", () => {
  it("reaches the whole deck in a recording, and live only the slides shown so far", () => {
    expect(navRange({ count: 12, whole: true, shown: 3, at: 2 })).toEqual({ first: 0, last: 11 });
    expect(navRange({ count: 12, whole: false, shown: 5, at: 2 })).toEqual({ first: 0, last: 5 });
    expect(navRange({ count: 12, whole: false, shown: undefined, at: 4 })).toEqual({ first: 0, last: 4 });
    expect(navRange({ count: undefined, whole: true, shown: undefined, at: undefined })).toBeUndefined();
  });

  it("pins the slide a step lands on, follows again on the followed one, and does nothing at the ends", () => {
    const range = { first: 0, last: 5 };
    const speaker = { deck: 0, index: 4 };
    expect(step(speaker, -1, range, speaker)).toEqual({ deck: 0, index: 3 });
    expect(step({ deck: 0, index: 3 }, 1, range, speaker)).toBeNull();
    expect(step({ deck: 0, index: 0 }, -1, range, speaker)).toBeUndefined();
    expect(step({ deck: 0, index: 5 }, 1, range, speaker)).toBeUndefined();
    expect(goTo(speaker, 1, range, speaker)).toEqual({ deck: 0, index: 1 });
    expect(goTo({ deck: 0, index: 1 }, 4, range, speaker)).toBeNull();
    expect(stepKey("ArrowLeft")).toBe(-1);
    expect(stepKey("PageDown")).toBe(1);
    expect(stepKey("k")).toBeUndefined();
  });
});

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** The slide in the slide panel (1-based), as its picture says. */
const shown = () => Number(document.querySelector("img.tt-slide-image")?.getAttribute("data-slide"));

describe("the slide panel as a deck", { timeout: 30_000 }, () => {
  let close: (() => void) | undefined;
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T10:00:00Z"));
  });
  afterEach(() => {
    close?.();
    close = undefined;
    vi.useRealTimers();
  });

  function setup() {
    const playback = createDemoPlayback(DEMO_ROOM, DEMO_START_MS);
    const script = new DemoSlides(DEMO_ROOM, 3_600_000);
    script.start(DEMO_START_MS);
    const slides = new SlideTracks(script.source, DEMO_ROOM, { catalog: () => script.catalog });
    const timer = setInterval(() => script.advanceTo(playback.liveEdge() ?? DEMO_START_MS), 50);
    const view = render(
      <Player
        playback={playback}
        slides={slides}
        room={DEMO_ROOM}
        transport={new FakeTransport()}
        sources={["slides"]}
      />,
    );
    close = () => {
      view.unmount();
      clearInterval(timer);
      slides.close();
      playback.close();
    };
    return { playback };
  }

  it("live: steps back through the slides shown, never past the speaker, and follows the speaker again", async () => {
    setup();
    await advance(3_000);
    const speaker = shown();
    expect(speaker).toBeGreaterThan(2);
    expect(screen.queryByRole("button", { name: "Follow the speaker" })).toBeNull();
    // Following, the speaker's slide is the newest one shown: nothing ahead of it.
    expect(screen.getByRole("button", { name: "Next slide" })).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "Previous slide" }));
    expect(shown()).toBe(speaker - 1);
    // The keys page the deck while focus is in its controls.
    const back = screen.getByRole("button", { name: "Previous slide" });
    back.focus();
    fireEvent.keyDown(back, { key: "ArrowLeft" });
    fireEvent.keyDown(back, { key: "PageUp" });
    expect(shown()).toBe(speaker - 3);
    fireEvent.keyDown(back, { key: "ArrowRight" });
    expect(shown()).toBe(speaker - 2);

    fireEvent.click(screen.getByRole("button", { name: "Follow the speaker" }));
    expect(shown()).toBe(speaker);
    expect(screen.queryByRole("button", { name: "Follow the speaker" })).toBeNull();
  });

  it("live: stays on the slide stepped to while the speaker moves on", async () => {
    setup();
    await advance(3_000);
    const speaker = shown();
    fireEvent.click(screen.getByRole("button", { name: "Previous slide" }));
    await advance(31_000);
    expect(shown()).toBe(speaker - 1);
    fireEvent.click(screen.getByRole("button", { name: "Follow the speaker" }));
    expect(shown()).toBe(speaker + 1);
  });

  it("rewound: goes ahead of the playhead through the whole deck and matches the playhead again", async () => {
    const { playback } = setup();
    await advance(3_000);
    act(() => playback.seek(DEMO_START_MS - 100_000));
    await advance(3_000);
    const playhead = shown();
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    expect(shown()).toBe(playhead + 2);
    fireEvent.click(screen.getByRole("button", { name: "Match the playhead" }));
    expect(shown()).toBe(playhead);
  });
});
