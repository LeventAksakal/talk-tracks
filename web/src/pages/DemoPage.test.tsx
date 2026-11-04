import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomMediaElement } from "../player/roomMediaElement";
import { DemoPage } from "./DemoPage";

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const subtitles = () => screen.queryByLabelText("Subtitles", { selector: ".tt-subs" });

describe("/demo in the player", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  // Long too: it plays 9 s of the live demo frame by frame (about 3 s on an idle machine, the file's first render
  // included). Past the 5 s default under load it timed out, and its still-running body failed every test after it.
  it(
    "plays live with nothing subscribed until the viewer turns subtitles on, then in Arabic",
    {
      timeout: 30_000,
    },
    async () => {
      render(<DemoPage />);
      await advance(100);
      expect(screen.queryByRole("button", { name: /Go live/ })).toBeNull(); // at the live edge
      expect(subtitles()).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
      const menu = screen.getByRole("dialog", { name: "Subtitles" });
      fireEvent.click(within(menu).getByRole("button", { name: /^Original/ }));
      await advance(3_000);
      expect(subtitles()?.textContent).toMatch(/\(\d+\)/);

      // Every language is in the one list; the demo room has an Arabic translation.
      fireEvent.click(within(menu).getByRole("button", { name: /Arabic/ }));
      await advance(6_000);
      const arabic = subtitles()?.querySelector('[lang="ar"]');
      expect(arabic?.getAttribute("dir")).toBe("rtl");
      expect(arabic?.textContent).toMatch(/\(\d+\)/);
    },
  );

  it("rewinds by keyboard and goes live again, saying what was missed", async () => {
    render(<DemoPage />);
    await advance(100);
    for (let i = 0; i < 6; i++) fireEvent.keyDown(document.body, { key: "j" });
    await advance(500);
    const goLive = screen.getByRole("button", { name: /Go live/ });
    expect(goLive.textContent).toMatch(/−1:0\d/);

    fireEvent.click(goLive);
    await advance(300);
    expect(screen.queryByRole("button", { name: /Go live/ })).toBeNull();
    expect(screen.getByText(/You missed/)).toBeTruthy();
  });

  it("shows the speaker's slide with its marks, the audience's only with Discussion open, and a rewind as it was then", async () => {
    render(<DemoPage />);
    await advance(300);
    const slide = () => document.querySelector<HTMLImageElement>(".tt-slide-image")?.dataset.slide;
    const marks = () => [...document.querySelectorAll(".tt-textmark")].map((m) => m.classList[1]);
    // Live at 2:30: the fifth slide, underlined and highlighted by the speaker.
    expect(slide()).toBe("5");
    expect(marks()).toEqual(["tt-textmark-underline", "tt-textmark-highlight"]);
    // A listener's highlight too, once the listener shows the audience's marks (slide comments are supplementary).
    fireEvent.click(screen.getByRole("tab", { name: "Discussion" }));
    await advance(300);
    expect(marks()).toEqual(["tt-textmark-underline", "tt-textmark-highlight", "tt-textmark-highlight"]);

    // Back 40 s, into the fourth slide's showing: its title underlined by then, from that slice alone.
    for (let i = 0; i < 4; i++) fireEvent.keyDown(document.body, { key: "j" });
    await advance(500);
    expect(slide()).toBe("4");
    expect(marks()).toContain("tt-textmark-underline");
  });

  it("subscribes chapters by opening their tab, puts them on the bar, and seeks from the list", async () => {
    render(<DemoPage />);
    await advance(100);
    const media = () => document.querySelector<RoomMediaElement>("tt-room-media")!;
    const chapters = () => [...media().textTracks].find((t) => t.kind === "chapters")?.cues?.length ?? 0;
    expect(chapters()).toBe(0);
    fireEvent.click(screen.getByRole("tab", { name: "Chapters" }));
    await advance(2_000);
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("Introduction")).toBeTruthy();
    expect(chapters()).toBeGreaterThan(1);
    fireEvent.click(within(panel).getByRole("button", { name: "Play from 1:01" }));
    await advance(300);
    expect(screen.getByRole("button", { name: /Go live/ })).toBeTruthy();
    expect(Math.round(media().currentTime)).toBe(61);
  });

  // Genuinely long: it plays 47 s of the live demo frame by frame (about 4 s on an idle machine), so it gets its own
  // timeout. Past the 5 s default under load it timed out, and its still-running body broke the test after it.
  it("downloads the whole transcript so far, in one language or in all of them", { timeout: 30_000 }, async () => {
    const saved: Blob[] = [];
    // Slide pictures are blobs too; the transcript is the text one.
    const create = vi.fn((b: Blob) => (b.type.startsWith("text/") && saved.push(b), "blob:x"));
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: () => undefined });
    render(<DemoPage />);
    await advance(30_000);
    // The transcript tab is open by default.
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    const popover = screen.getByRole("group", { name: "Download the transcript" });
    await act(async () => fireEvent.click(within(popover).getByRole("button", { name: /\.txt/ })));
    await advance(2_000);
    expect(saved).toHaveLength(1);
    const text = await saved[0]!.text();
    expect(text.match(/\(\d+\)/g)!.length).toBeGreaterThan(3);

    fireEvent.change(within(popover).getByRole("combobox", { name: "Language" }), { target: { value: "all" } });
    await act(async () => fireEvent.click(within(popover).getByRole("button", { name: /\.vtt/ })));
    // Three languages' history, fetched slice by slice.
    await advance(15_000);
    expect(saved).toHaveLength(2);
    const vtt = await saved[1]!.text();
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("<lang ar>");
  });
});
