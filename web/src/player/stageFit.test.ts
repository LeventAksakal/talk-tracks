import { describe, expect, it } from "vitest";
import { type Box, fitStage } from "./stageFit";

const overlap = (a: Box, b: Box) =>
  a.left < b.left + b.width - 0.5 &&
  b.left < a.left + a.width - 0.5 &&
  a.top < b.top + b.height - 0.5 &&
  b.top < a.top + a.height - 0.5;

// The watch page with its side panel, a full-screen 16:9 stage, a wide short window, and the smallest player.
const stages = [
  { width: 1080, height: 900 },
  { width: 1920, height: 1080 },
  { width: 1600, height: 620 },
  { width: 760, height: 420 },
];
const webcam = (16 / 9) * (0.21563 / 0.35417); // the EMF lecture's webcam inset
const base = { main: 16 / 9, dockReach: 112, gap: 12 };

describe("the stage keeps the slides uncovered", () => {
  it("never puts the corner camera over the slides", () => {
    for (const stage of stages)
      for (const aspect of [webcam, 16 / 9, 4 / 3])
        for (const widthFrac of [0.14, 0.24, 0.5]) {
          const fit = fitStage({ ...stage, ...base, corner: { aspect, widthFrac } });
          expect(fit.corner, JSON.stringify({ stage, aspect, widthFrac })).toBeDefined();
          expect(overlap(fit.main, fit.corner!), JSON.stringify({ stage, aspect, widthFrac })).toBe(false);
        }
  });

  it("never puts unmoved subtitles over the slides or the camera", () => {
    for (const stage of stages)
      for (const corner of [undefined, { aspect: webcam, widthFrac: 0.24 }]) {
        const captions = 80;
        const fit = fitStage({ ...stage, ...base, corner, captions });
        const c = fit.captions!;
        const box: Box = { left: c.x - c.maxWidth / 2, top: c.top, width: c.maxWidth, height: captions };
        expect(overlap(fit.main, box), JSON.stringify(stage)).toBe(false);
        if (fit.corner) expect(overlap(fit.corner, box), JSON.stringify(stage)).toBe(false);
        // and they stay above the dock
        expect(c.top + captions).toBeLessThanOrEqual(stage.height - base.dockReach + 0.5);
      }
  });

  it("leaves the slides their full size when the letterbox has room for the camera", () => {
    const fit = fitStage({ width: 1080, height: 900, ...base, corner: { aspect: webcam, widthFrac: 0.24 } });
    expect(fit.main.width).toBeCloseTo(1080, 0);
  });

  it("gives the camera a column of its own where a band would shrink the slides more", () => {
    const fit = fitStage({ width: 1920, height: 1080, ...base, corner: { aspect: webcam, widthFrac: 0.24 } });
    expect(fit.right).toBeGreaterThan(0);
    expect(fit.main.width).toBeGreaterThan(1500);
  });

  it("keeps no room when there is nothing to keep clear", () => {
    const fit = fitStage({ width: 1440, height: 900, ...base });
    expect(fit).toMatchObject({ right: 0, bottom: 0 });
    expect(fit.main.width).toBeCloseTo(1440, 0);
  });
});
