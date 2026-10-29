import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoPage } from "./DemoPage";

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("/demo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("lists the scripted room's tracks, all off, and shows captions, translations, slides and the outline once chosen", async () => {
    render(<DemoPage />);
    await advance(100);

    // Every agent shows up in the track picker; none is on until chosen (decision 0010).
    const picker = screen.getByRole("region", { name: "Tracks" });
    const switches = within(picker).getAllByRole("switch") as HTMLInputElement[];
    expect(switches.length).toBe(5);
    expect(switches.every((s) => !s.checked)).toBe(true);
    for (const name of [/Captions/, /Arabic/, /Turkish/, /Slide descriptions/, /Chapters/])
      fireEvent.click(within(picker).getByRole("switch", { name }));
    await advance(0);

    // Mid-way through the first line: interim text, shown apart from settled lines.
    await advance(3_000);
    const captionsLog = screen.getByRole("log", { name: /Captions \(English\)/ });
    const interim = captionsLog.querySelector(".interim");
    expect(interim?.textContent).toMatch(/^Welcome, everyone/);
    expect(interim?.getAttribute("aria-hidden")).toBe("true");

    // Far enough for a few lines, their translations, the first slide and the first outline.
    await advance(14_000);
    expect(within(captionsLog).getByText("Water picks up small stones and carries them downstream. (1)")).toBeTruthy();
    const turkishLog = screen.getByRole("log", { name: /Turkish/ });
    expect(within(turkishLog).getByText("Su küçük taşları alır ve akış yönünde taşır. (1)")).toBeTruthy();
    const arabicLog = screen.getByRole("log", { name: /Arabic/ });
    expect(arabicLog.getAttribute("dir")).toBe("rtl");
    expect(arabicLog.getAttribute("lang")).toBe("ar");
    expect(within(arabicLog).getByText("يلتقط الماء الحصى الصغيرة ويحملها مع التيار. (1)")).toBeTruthy();

    const slides = screen.getByRole("region", { name: "Slide descriptions" });
    expect(within(slides).getAllByText(/Slide 1: a diagram of a river/).length).toBeGreaterThan(0);

    const outline = screen.getByRole("region", { name: /Chapters, glossary and recap/ });
    expect(within(outline).getByText("Introduction")).toBeTruthy();
    expect(within(outline).getByText("Sediment")).toBeTruthy();
  });
});
