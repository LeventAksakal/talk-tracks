// Drawing the deck's state on the console's slide (a 2D canvas over the slide image) and finding what
// the eraser touches. Positions are fractions of the slide; the canvas is in CSS pixels × DPR.

import { rangeBoxes } from "../annotate/geometry";
import { HIGHLIGHT_ALPHA } from "../canvas/ink";
import type { PointerRecord, TextRange, TextRun } from "../contracts/types";

/** A stroke or shape, drawn as the player draws it (canvas/ink.ts). */
export { drawElement } from "../canvas/ink";

export function drawRange(
  ctx: CanvasRenderingContext2D,
  runs: readonly TextRun[],
  range: TextRange,
  style: "underline" | "highlight",
  color: string,
  w: number,
  h: number,
): void {
  ctx.save();
  ctx.fillStyle = color;
  for (const b of rangeBoxes(runs, range)) {
    if (style === "highlight") {
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.globalCompositeOperation = "multiply";
      ctx.fillRect(b.x * w, b.y * h, b.w * w, b.h * h);
    } else {
      const thick = Math.max(2, b.h * h * 0.08);
      ctx.fillRect(b.x * w, (b.y + b.h) * h - thick, b.w * w, thick);
    }
  }
  ctx.restore();
}

export function drawLaser(ctx: CanvasRenderingContext2D, p: PointerRecord | undefined, w: number, h: number): void {
  if (!p || p.data.kind !== "at") return;
  const x = p.data.x * w;
  const y = p.data.y * h;
  const r = Math.max(5, w * 0.007);
  ctx.save();
  const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
  glow.addColorStop(0, "rgba(255, 40, 40, 0.55)");
  glow.addColorStop(1, "rgba(255, 40, 40, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, r * 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ff2828";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export { marksAt, strokesAt } from "../annotate/geometry";
