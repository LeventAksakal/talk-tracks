// Drawing the deck's state on the console's slide (a 2D canvas over the slide image) and finding what
// the eraser touches. Positions are fractions of the slide; the canvas is in CSS pixels × DPR.

import type { StrokeRecord, TextMarkRecord } from "../contracts/tracks";
import type { Point, PointerRecord, TextRange, TextRun } from "../contracts/types";
import { rangeBoxes } from "./runs";

export const HIGHLIGHTER_ALPHA = 0.35;

export function drawStroke(ctx: CanvasRenderingContext2D, s: StrokeRecord["data"], w: number, h: number): void {
  const pts = s.points;
  if (!pts.length) return;
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = Math.max(1, s.width * w);
  ctx.lineCap = s.tool === "highlighter" ? "butt" : "round";
  ctx.lineJoin = "round";
  if (s.tool === "highlighter") {
    ctx.globalAlpha = HIGHLIGHTER_ALPHA;
    ctx.globalCompositeOperation = "multiply";
  }
  if (pts.length === 1) {
    const [x, y] = pts[0]!;
    ctx.beginPath();
    ctx.arc(x * w, y * h, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(pts[0]![0] * w, pts[0]![1] * h);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0] * w, pts[i]![1] * h);
    ctx.stroke();
  }
  ctx.restore();
}

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
      ctx.globalAlpha = HIGHLIGHTER_ALPHA;
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

/** Distance from p to the segment ab, in slide fractions scaled by the aspect (x by `aspect`). */
function segmentDistance(p: Point, a: Point, b: Point, aspect: number): number {
  const [px, py] = [p[0] * aspect, p[1]];
  const [ax, ay] = [a[0] * aspect, a[1]];
  const [bx, by] = [b[0] * aspect, b[1]];
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Strokes within `radius` (a fraction of the slide's height) of p. */
export function strokesAt(strokes: readonly StrokeRecord[], p: Point, aspect: number, radius = 0.015): string[] {
  return strokes
    .filter(({ data: s }) => {
      const reach = radius + (s.width * aspect) / 2;
      const pts = s.points;
      if (pts.length === 1) return segmentDistance(p, pts[0]!, pts[0]!, aspect) <= reach;
      for (let i = 1; i < pts.length; i++) if (segmentDistance(p, pts[i - 1]!, pts[i]!, aspect) <= reach) return true;
      return false;
    })
    .map((s) => s.data.stroke);
}

/** Marks whose text boxes contain p. */
export function marksAt(marks: readonly TextMarkRecord[], runs: readonly TextRun[], [x, y]: Point): string[] {
  return marks
    .filter((k) => rangeBoxes(runs, k.data.span).some((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h))
    .map((k) => k.data.id);
}
