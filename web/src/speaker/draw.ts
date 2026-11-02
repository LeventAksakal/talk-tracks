// Drawing the deck's state on the console's slide (a 2D canvas over the slide image) and finding what
// the eraser touches. Positions are fractions of the slide; the canvas is in CSS pixels × DPR.

import { rangeBoxes } from "../annotate/geometry";
import { HIGHLIGHT_ALPHA } from "../canvas/ink";
import { drawLaserTrail, type LaserTrail } from "../canvas/laser";
import type { PointerRecord, TextRange, TextRun } from "../contracts/types";
import { laserColor } from "../theme/ink";

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

/**
 * The laser's dot at `p`, and with `trail`, its fading trail behind it (canvas/laser.ts): the position is added to
 * the trail at `now`. True while a trail is still fading, so the caller draws another frame.
 */
export function drawLaser(
  ctx: CanvasRenderingContext2D,
  p: PointerRecord | undefined,
  w: number,
  h: number,
  trail?: LaserTrail,
  now: number = performance.now(),
): boolean {
  const laser = laserColor();
  const on = p?.data.kind === "at" ? p.data : undefined;
  let fading = false;
  if (trail) {
    if (on) trail.add(on.x, on.y, now);
    const points = trail.points(now);
    drawLaserTrail(ctx, points, now, w, h, laser);
    fading = points.length > 1 || (!on && points.length > 0);
  }
  if (!on) return fading;
  const x = on.x * w;
  const y = on.y * h;
  const r = Math.max(5, w * 0.007);
  ctx.save();
  const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
  glow.addColorStop(0, `color-mix(in srgb, ${laser} 55%, transparent)`);
  glow.addColorStop(1, `color-mix(in srgb, ${laser} 0%, transparent)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, r * 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = laser;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  return fading;
}

export { marksAt, strokesAt } from "../annotate/geometry";
