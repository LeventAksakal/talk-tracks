// Drawing the ink track's elements (strokes and shapes), shared by the speaker's console and the player
// (decisions 0020, 0021), so live and replay draw the same. A pure function of (context, elements, size)
// that takes an OffscreenCanvas context too. Positions are fractions of the slide; a width is a fraction
// of the slide's width. Pen strokes are smoothed with perfect-freehand (MIT): its output depends only on
// the points, so every reader draws the same outline.

import { getStroke } from "perfect-freehand";
import type { InkElement, InkShape, InkStroke, Point } from "../contracts/types";

/** How opaque a highlighter stroke or a highlight mark is over the slide. */
export const HIGHLIGHT_ALPHA = 0.35;

export type Ctx2D = Pick<
  CanvasRenderingContext2D,
  | "clearRect"
  | "beginPath"
  | "closePath"
  | "moveTo"
  | "lineTo"
  | "quadraticCurveTo"
  | "arc"
  | "ellipse"
  | "rect"
  | "stroke"
  | "fill"
  | "save"
  | "restore"
  | "lineWidth"
  | "lineCap"
  | "lineJoin"
  | "strokeStyle"
  | "fillStyle"
  | "globalAlpha"
>;

/** Draw elements on a canvas of `width` × `height` pixels, clearing it first, oldest first. */
export function drawElements(ctx: Ctx2D, elements: readonly InkElement[], width: number, height: number): void {
  ctx.clearRect(0, 0, width, height);
  for (const el of elements) drawElement(ctx, el, width, height);
}

export function drawElement(ctx: Ctx2D, el: InkElement, width: number, height: number): void {
  ctx.save();
  ctx.strokeStyle = el.color;
  ctx.fillStyle = el.color;
  const lw = Math.max(1, el.width * width);
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (el.kind === "shape") drawShape(ctx, el, width, height, lw);
  else if (el.tool === "highlighter") drawHighlighter(ctx, el, width, height, lw);
  else drawPen(ctx, el, width, height);
  ctx.restore();
}

/**
 * A pen stroke: perfect-freehand's outline, filled; velocity stands in for pressure. Drawn as if finished
 * (`last`), so a stroke being drawn ends under the pen instead of trailing it.
 */
function drawPen(ctx: Ctx2D, s: InkStroke, width: number, height: number): void {
  const first = s.points[0];
  if (!first) return;
  const size = Math.max(1, s.width * width) * 1.4;
  if (s.points.length === 1) {
    ctx.beginPath();
    ctx.arc(first[0] * width, first[1] * height, size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const outline = getStroke(
    s.points.map(([x, y]) => [x * width, y * height]),
    { size, thinning: 0.5, smoothing: 0.5, streamline: 0.4, simulatePressure: true, last: true },
  );
  fillOutline(ctx, outline);
}

/** A closed outline through the midpoints of its points (each point a control point). */
function fillOutline(ctx: Ctx2D, pts: readonly number[][]): void {
  const n = pts.length;
  if (n < 3) return;
  ctx.beginPath();
  const [x0, y0] = pts[0]!;
  const [x1, y1] = pts[1]!;
  ctx.moveTo((x0! + x1!) / 2, (y0! + y1!) / 2);
  for (let i = 1; i <= n; i++) {
    const [x, y] = pts[i % n]!;
    const [nx, ny] = pts[(i + 1) % n]!;
    ctx.quadraticCurveTo(x!, y!, (x! + nx!) / 2, (y! + ny!) / 2);
  }
  ctx.closePath();
  ctx.fill();
}

/** A highlighter stroke: an even, translucent line through the midpoints. */
function drawHighlighter(ctx: Ctx2D, s: InkStroke, width: number, height: number, lw: number): void {
  const pts = s.points;
  const first = pts[0];
  if (!first) return;
  ctx.globalAlpha = HIGHLIGHT_ALPHA;
  ctx.beginPath();
  if (pts.length === 1) {
    ctx.arc(first[0] * width, first[1] * height, lw / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.moveTo(first[0] * width, first[1] * height);
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i]!;
    const [nx, ny] = pts[i + 1]!;
    ctx.quadraticCurveTo(x * width, y * height, ((x + nx) / 2) * width, ((y + ny) / 2) * height);
  }
  const last = pts[pts.length - 1]!;
  ctx.lineTo(last[0] * width, last[1] * height);
  ctx.stroke();
}

function drawShape(ctx: Ctx2D, s: InkShape, width: number, height: number, lw: number): void {
  const [ax, ay] = [s.start[0] * width, s.start[1] * height];
  const [bx, by] = [s.end[0] * width, s.end[1] * height];
  ctx.beginPath();
  if (s.shape === "rect") {
    ctx.rect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
  } else if (s.shape === "ellipse") {
    ctx.ellipse((ax + bx) / 2, (ay + by) / 2, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, Math.PI * 2);
  } else {
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    if (s.shape === "arrow") {
      const [l, r] = arrowHead([ax, ay], [bx, by], lw);
      ctx.moveTo(l[0], l[1]);
      ctx.lineTo(bx, by);
      ctx.lineTo(r[0], r[1]);
    }
  }
  ctx.stroke();
}

/** The two ends of an arrow's head at `to`, in the same units as the points. */
export function arrowHead(from: Point, to: Point, lineWidth: number): [Point, Point] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const head = Math.min(len * 0.4, Math.max(lineWidth * 4, 12));
  const angle = Math.atan2(dy, dx);
  const spread = Math.PI / 7;
  return [
    [to[0] - head * Math.cos(angle - spread), to[1] - head * Math.sin(angle - spread)],
    [to[0] - head * Math.cos(angle + spread), to[1] - head * Math.sin(angle + spread)],
  ];
}

/** What the ink canvas shows: it is redrawn only when this changes (a point, an element, a drag, the size). */
export function inkSignature(elements: readonly { data: InkElement }[], width: number, height: number): string {
  let sig = `${width}x${height}`;
  for (const { data } of elements) {
    sig +=
      data.kind === "shape"
        ? `|${data.stroke}:${data.shape}:${data.start.join(",")}:${data.end.join(",")}:${data.width}:${data.color}`
        : `|${data.stroke}:${data.points.length}:${data.done ? 1 : 0}`;
  }
  return sig;
}

/** A shape dragged from `start` to `end`; with `even` (Shift), a square, a circle or a line at 45° steps. */
export function shapeEnd(kind: InkShape["shape"], start: Point, end: Point, aspect: number, even: boolean): Point {
  if (!even) return end;
  // Work in slide-height units so "square" means square on screen.
  const dx = (end[0] - start[0]) * aspect;
  const dy = end[1] - start[1];
  let ex: number;
  let ey: number;
  if (kind === "rect" || kind === "ellipse") {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    ex = Math.sign(dx || 1) * side;
    ey = Math.sign(dy || 1) * side;
  } else {
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    const len = Math.hypot(dx, dy);
    ex = Math.cos(angle) * len;
    ey = Math.sin(angle) * len;
  }
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [clamp(start[0] + ex / aspect), clamp(start[1] + ey)];
}
