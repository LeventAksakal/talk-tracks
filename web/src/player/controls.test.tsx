// What a viewer can do with the player's controls (decision 0031): play and pause by click or key, seek with J and
// L, mute, go full screen with a double-click, open Stats for nerds, and reach every button by its name.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_ROOM, DEMO_START_MS } from "../pages/DemoPage";
import { createDemoPlayback } from "../playback/usePlayback";
import { FakeTransport } from "../transport/fake";
import { DemoSlides } from "./demoSlides";
import { Player } from "./Player";
import type { RoomMediaElement } from "./roomMediaElement";
import { SlideTracks } from "./slideTracks";

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

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
  return () => {
    view.unmount();
    clearInterval(timer);
    slides.close();
    playback.close();
  };
}

const media = () => document.querySelector<RoomMediaElement>("tt-room-media")!;
const press = (key: string) => fireEvent.keyDown(document.body, { key });

/** What a screen reader would call the element: its label, the element it points at, or its text. */
function nameOf(el: Element): string {
  const label = el.getAttribute("aria-label");
  if (label) return label.trim();
  const by = el.getAttribute("aria-labelledby");
  if (by)
    return by
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  return (el.textContent ?? "").trim();
}

describe("the player's controls", () => {
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

  it("plays the running demo, and pauses and plays again with a click on the stage", async () => {
    close = setup();
    await advance(300);
    expect(media().paused).toBe(false);
    fireEvent.click(document.querySelector(".tt-stage")!);
    await advance(400);
    expect(media().paused).toBe(true);
    fireEvent.click(document.querySelector(".tt-stage")!);
    await advance(400);
    expect(media().paused).toBe(false);
  });

  it("pauses and plays with K and Space anywhere on the page", async () => {
    close = setup();
    await advance(300);
    press("k");
    await advance(50);
    expect(media().paused).toBe(true);
    press(" ");
    await advance(50);
    expect(media().paused).toBe(false);
  });

  it("goes back ten seconds with J and forward again with L", async () => {
    close = setup();
    await advance(300);
    const before = media().currentTime;
    press("j");
    await advance(300);
    const back = media().currentTime;
    expect(before - back).toBeGreaterThan(8);
    expect(before - back).toBeLessThan(12);
    press("l");
    await advance(300);
    expect(media().currentTime).toBeGreaterThan(back + 8);
  });

  it("finds a subtitle language by typing its name in the open menu, and leaves playback alone", async () => {
    close = setup();
    await advance(300);
    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    await advance(50);
    const menu = screen.getByRole("dialog", { name: "Subtitles" });
    // Off, the original, then the languages: no search field, no other sections.
    expect(menu.querySelector("input")).toBeNull();
    const rows = [...menu.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(rows[0]).toBe("Off");
    expect(rows[1]).toMatch(/^Original/);
    expect(rows.length).toBeGreaterThan(20);
    const before = media().currentTime;
    const type = async (keys: string, gap = 0) => {
      for (const key of keys) {
        const at = document.activeElement ?? menu;
        fireEvent.keyDown(at, { key });
        fireEvent.keyUp(at, { key });
        if (gap) await advance(gap);
      }
      await advance(50);
    };
    // K and J are a pause and a rewind elsewhere on the page; here they are letters.
    await type("kj", 1_000);
    expect(media().paused).toBe(false);
    expect(media().currentTime).toBeGreaterThanOrEqual(before);
    await type("tu");
    expect((document.activeElement as HTMLElement).dataset.lang).toBe("tr");
    fireEvent.click(document.activeElement!);
    await advance(50);
    expect(document.activeElement?.getAttribute("aria-pressed")).toBe("true");
  });

  it("mutes and unmutes with M", async () => {
    close = setup();
    await advance(300);
    expect(media().muted).toBe(false);
    press("m");
    await advance(50);
    expect(media().muted).toBe(true);
    press("m");
    await advance(50);
    expect(media().muted).toBe(false);
  });

  it("asks for full screen on a double-click on the stage, for the whole player", async () => {
    const request = vi.fn(() => Promise.resolve());
    const original = HTMLElement.prototype.requestFullscreen;
    HTMLElement.prototype.requestFullscreen = request;
    try {
      close = setup();
      await advance(300);
      fireEvent.dblClick(document.querySelector(".tt-stage")!);
      await advance(50);
      expect(request).toHaveBeenCalled();
      expect(request.mock.contexts[0]).toBe(document.querySelector(".tt-player"));
    } finally {
      HTMLElement.prototype.requestFullscreen = original;
    }
  });

  it("opens Stats for nerds with I and closes it from its own button", async () => {
    close = setup();
    await advance(300);
    press("i");
    await advance(50);
    fireEvent.click(screen.getByRole("button", { name: "Close stats" }));
    await advance(50);
    expect(screen.queryByRole("button", { name: "Close stats" })).toBeNull();
  });

  it("gives every button in the player a name", async () => {
    close = setup();
    await advance(300);
    const player = document.querySelector(".tt-player")!;
    const buttons = [...player.querySelectorAll("button, [role='button']")].filter((b) => !b.closest("[hidden]"));
    expect(buttons.length).toBeGreaterThan(8);
    expect(buttons.filter((b) => nameOf(b) === "").map((b) => b.outerHTML.slice(0, 80))).toEqual([]);
    for (const name of ["Subtitles", "Side panel (S)"]) expect(screen.getByRole("button", { name })).toBeTruthy();
  });
});
