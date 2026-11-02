import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoPage } from "../pages/DemoPage";
import { readStoredZip } from "./zip";

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** The demo plays a scripted room in this process: a whole package takes a few seconds of real time. */
const SLOW = 30_000;

describe("the lecture package in the offline demo", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it(
    "downloads a .zip with every language, the chapters and the slides, and lets the playhead be",
    async () => {
      const saved: Blob[] = [];
      const create = vi.fn((b: Blob) => (b.type === "application/zip" && saved.push(b), "blob:x"));
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: () => undefined });
      render(<DemoPage />);
      await advance(30_000);
      fireEvent.click(screen.getByRole("button", { name: "Download" }));
      const popover = screen.getByRole("group", { name: "Download the transcript" });
      await act(async () => fireEvent.click(within(popover).getByRole("button", { name: /Lecture package/ })));
      expect(within(popover).getByRole("progressbar")).toBeTruthy();
      await advance(30_000);
      expect(saved).toHaveLength(1);
      expect(within(popover).queryByRole("progressbar")).toBeNull();
      // Still live: building the package moved nothing.
      expect(screen.queryByRole("button", { name: /Go live/ })).toBeNull();

      const files = readStoredZip(new Uint8Array(await saved[0]!.arrayBuffer()));
      const read = (p: string) => new TextDecoder().decode(files.get(p));
      const manifest = JSON.parse(read("manifest.json")) as {
        languages: { lang: string }[];
        files: { path: string }[];
        slides: unknown[];
        descriptions: number | null;
      };
      expect(manifest.files.map((f) => f.path).sort()).toEqual(
        [...files.keys()].filter((p) => p !== "manifest.json").sort(),
      );
      // The demo's agents are free, so every language comes along.
      expect(manifest.languages.length).toBeGreaterThanOrEqual(3);
      expect(manifest.slides.length).toBeGreaterThan(0);
      // The demo's describe agent is free too: the slides come with their descriptions.
      expect(manifest.descriptions).toBeGreaterThan(0);
      const chapters = (JSON.parse(read("chapters.json")) as { chapters: { title: string }[] }).chapters;
      expect(chapters.length).toBeGreaterThan(0);
      const lecture = read("lecture.md");
      for (const [i, c] of chapters.entries()) expect(lecture).toContain(`## ${i + 1}. ${c.title}`);
    },
    SLOW,
  );

  it(
    "stops when cancelled and saves nothing",
    async () => {
      const saved: Blob[] = [];
      Object.assign(URL, {
        createObjectURL: (b: Blob) => (b.type === "application/zip" && saved.push(b), "blob:x"),
        revokeObjectURL: () => undefined,
      });
      render(<DemoPage />);
      await advance(10_000);
      fireEvent.click(screen.getByRole("button", { name: "Download" }));
      const popover = screen.getByRole("group", { name: "Download the transcript" });
      await act(async () => fireEvent.click(within(popover).getByRole("button", { name: /Lecture package/ })));
      fireEvent.click(within(popover).getByRole("button", { name: "Cancel" }));
      await advance(30_000);
      expect(saved).toHaveLength(0);
      expect(within(popover).getByRole("button", { name: /Lecture package/ })).toHaveProperty("disabled", false);
    },
    SLOW,
  );
});
