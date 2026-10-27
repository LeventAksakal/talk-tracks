import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoEvents } from "../demo/script";
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

  it("renders captions with interim text, translations, a slide note and the outline from the fake transport", async () => {
    render(<DemoPage />);
    await advance(100);

    // Every agent of the script shows up in the track picker; translations start off.
    const picker = screen.getByRole("region", { name: "Tracks" });
    const arabic = within(picker).getByRole("switch", { name: /Arabic/ });
    const turkish = within(picker).getByRole("switch", { name: /Turkish/ });
    expect((arabic as HTMLInputElement).checked).toBe(false);
    fireEvent.click(arabic);
    fireEvent.click(turkish);
    await advance(0);

    // Mid-way through the first line: interim text, shown apart from settled lines.
    await advance(1_500);
    const captionsLog = screen.getByRole("log", { name: /Captions \(English\)/ });
    const interim = captionsLog.querySelector(".interim");
    expect(interim?.textContent).toMatch(/^Welcome, everyone/);
    expect(interim?.getAttribute("aria-hidden")).toBe("true");

    // Far enough for the instance swap, the slide and the recap.
    const { duration } = demoEvents("demo");
    await advance(duration - 3_000);

    expect(within(captionsLog).getByText("That is how deltas and fertile plains are built.")).toBeTruthy();
    const turkishLog = screen.getByRole("log", { name: /Turkish/ });
    expect(within(turkishLog).getByText("Deltalar ve verimli ovalar böyle oluşur.")).toBeTruthy();
    const arabicLog = screen.getByRole("log", { name: /Arabic/ });
    expect(arabicLog.getAttribute("dir")).toBe("rtl");
    expect(arabicLog.getAttribute("lang")).toBe("ar");
    expect(within(arabicLog).getByText("هكذا تتكوّن الدلتاوات والسهول الخصبة.")).toBeTruthy();

    const slides = screen.getByRole("region", { name: "Slide descriptions" });
    expect(
      within(within(slides).getByRole("list")).getByText(/Aerial photograph of a deep, winding canyon/),
    ).toBeTruthy();

    const outline = screen.getByRole("region", { name: /Chapters, glossary and recap/ });
    expect(within(outline).getByText("Rivers carry stone")).toBeTruthy();
    expect(within(outline).getByText("Deltas and plains")).toBeTruthy();
    expect(within(outline).getByText("Erosion")).toBeTruthy();
    expect(within(outline).getByText(/Rivers wear rock away/)).toBeTruthy();

    // The caption agent was replaced mid-talk and the viewer followed the new instance: every line
    // from before the swap is still there, and the track is live.
    expect(within(captionsLog).getByText(/^Welcome, everyone/)).toBeTruthy();
    expect(within(screen.getByRole("region", { name: /Captions \(English\)/ })).getByText("live")).toBeTruthy();
    expect(screen.getByText("● Live")).toBeTruthy();
  });
});
