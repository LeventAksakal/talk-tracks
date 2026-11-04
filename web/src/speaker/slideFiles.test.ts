import { beforeAll, describe, expect, it, vi } from "vitest";
import lockedPdf from "./fixtures/locked.pdf?inline";
import threePages from "./fixtures/three-pages.pdf?inline";
import threeSlides from "./fixtures/three-slides.pptx?inline";
import { MAX_DECK_MB, checkSlideFiles, kindOf, openSlides } from "./slideFiles";

// Generated decks (no real talk's slides): a 3-page PDF, a 3-slide PowerPoint file, a PDF locked with a password.
const FIXTURES = {
  "three-pages.pdf": threePages,
  "three-slides.pptx": threeSlides,
  "locked.pdf": lockedPdf,
};
const fixture = async (name: keyof typeof FIXTURES, type = "") =>
  new File([await (await fetch(FIXTURES[name])).arrayBuffer()], name, { type });

// The test runner's Node lacks JavaScript that PDF.js's modern build uses: the legacy build stands in. No worker
// thread either: PDF.js runs its parser in this thread.
vi.mock("pdfjs-dist", () => import("pdfjs-dist/legacy/build/pdf.mjs"));
beforeAll(async () => {
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
});

describe("opening slide files", () => {
  it("opens a PDF as one slide per page", async () => {
    const deck = await openSlides([await fixture("three-pages.pdf", "application/pdf")]);
    expect(deck.count).toBe(3);
    expect(deck.aspect).toBeCloseTo(16 / 9, 2);
    deck.close();
  });

  // happy-dom's XML parser loses PowerPoint's namespaced elements, so a .pptx opens to no slides here; the
  // real-browser check (headless Chrome, the lane's screenshots) opens fixtures/three-slides.pptx as 3 slides.
  it.skip("opens a PowerPoint file as one slide per slide", async () => {
    const deck = await openSlides([
      await fixture("three-slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    ]);
    expect(deck.count).toBe(3);
    expect(deck.aspect).toBeCloseTo(16 / 9, 2);
    deck.close();
  });

  it("says a password-protected PDF needs a copy without the password", async () => {
    await expect(openSlides([await fixture("locked.pdf", "application/pdf")])).rejects.toThrow(/password-protected/);
  });

  it("says a file that is not a PDF could not be opened", async () => {
    const fake = new File(["not a pdf at all"], "talk.pdf", { type: "application/pdf" });
    await expect(openSlides([fake])).rejects.toThrow(/talk\.pdf could not be opened as a PDF/);
  });

  it("says a damaged PowerPoint file could not be read", async () => {
    const fake = new File(["not a zip"], "talk.pptx");
    await expect(openSlides([fake])).rejects.toThrow(/talk\.pptx could not be read/);
  });
});

describe("checking what the speaker chose", () => {
  const file = (name: string, size = 1000, type = "") => ({ name, size, type });

  it("knows decks and pictures by type or extension", () => {
    expect(kindOf(file("a.PDF"))).toBe("pdf");
    expect(kindOf(file("deck.pptx"))).toBe("pptx");
    expect(kindOf(file("photo", 1, "image/jpeg"))).toBe("image");
    expect(kindOf(file("talk.key"))).toBe("keynote");
    expect(kindOf(file("talk.odp"))).toBe("odp");
    expect(kindOf(file("old.ppt"))).toBe("ppt");
  });

  it("accepts one deck, or several pictures", () => {
    expect(checkSlideFiles([file("a.pdf")])).toBeUndefined();
    expect(checkSlideFiles([file("1.png"), file("2.jpg"), file("3.webp")])).toBeUndefined();
    expect(checkSlideFiles([file("a.pdf"), file("b.pdf")])).toMatch(/one PDF or PowerPoint file at a time/);
  });

  it("guides Keynote, OpenDocument and old PowerPoint files to a PDF export", () => {
    expect(checkSlideFiles([file("talk.key")])).toMatch(/Export To › PDF/);
    expect(checkSlideFiles([file("talk.odp")])).toMatch(/Export as PDF/);
    expect(checkSlideFiles([file("talk.ppt")])).toMatch(/\.pptx or PDF/);
  });

  it("refuses a file over the limit and says the limit", () => {
    const big = file("huge.pdf", (MAX_DECK_MB + 1) * 1024 * 1024);
    expect(checkSlideFiles([big])).toMatch(
      new RegExp(`huge\\.pdf is ${MAX_DECK_MB + 1} MB; the limit is ${MAX_DECK_MB} MB`),
    );
  });

  it("refuses a file that is not slides", () => {
    expect(checkSlideFiles([file("notes.docx")])).toMatch(/isn't a slide file/);
  });
});
