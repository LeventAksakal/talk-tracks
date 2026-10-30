// Drawing the slide's annotations (decisions 0020, 0021): where a text mark sits from the slide's text runs, and
// the ink drawer, a pure function of (context, strokes, size) that takes an OffscreenCanvas context too, so it can
// move into a worker if profiling ever asks for it.

import type { InkStroke, Region, TextRange, TextRun } from "../contracts/types";

/** How opaque a highlighter stroke or a highlight mark is over the slide. */
export const HIGHLIGHT_ALPHA = 0.35;

/**
 * The boxes a text range covers, in fractions of the slide: one per run span, a part of a run placed by character
 * count across its box (container-formats §3), and neighbours on the same line joined so an underline across
 * words is one line. Spans naming a run the slide does not have are skipped.
 */
export function markBoxes(span: TextRange, runs: readonly TextRun[]): Region[] {
  const boxes: Region[] = [];
  for (const s of span) {
    const run = runs.find((r) => r.id === s.run);
    if (!run) continue;
    const len = Math.max(1, run.text.length);
    const start = Math.min(len, Math.max(0, s.start ?? 0));
    const end = Math.min(len, Math.max(start, s.end ?? len));
    if (end <= start) continue;
    const { x, y, w, h } = run.box;
    boxes.push({ x: x + (w * start) / len, y, w: (w * (end - start)) / len, h });
  }
  const out: Region[] = [];
  for (const b of boxes) {
    const last = out.at(-1);
    const sameLine = last && Math.abs(last.y + last.h / 2 - (b.y + b.h / 2)) < Math.min(last.h, b.h) / 2;
    const gap = last ? b.x - (last.x + last.w) : Infinity;
    if (last && sameLine && gap >= -0.001 && gap < Math.max(last.h, b.h)) {
      const top = Math.min(last.y, b.y);
      last.h = Math.max(last.y + last.h, b.y + b.h) - top;
      last.y = top;
      last.w = b.x + b.w - last.x;
    } else out.push({ ...b });
  }
  return out;
}

type Ctx2D = Pick<
  CanvasRenderingContext2D,
  | "clearRect"
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "quadraticCurveTo"
  | "arc"
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

/**
 * Draw strokes on a canvas of `width` × `height` device pixels, clearing it first. Points are fractions of the
 * slide; a stroke's width is a fraction of the slide's width. A pen draws solid, a highlighter translucent. A
 * stroke still being drawn shows the points so far.
 */
export function drawInk(ctx: Ctx2D, strokes: readonly InkStroke[], width: number, height: number): void {
  ctx.clearRect(0, 0, width, height);
  for (const s of strokes) {
    const pts = s.points;
    const first = pts[0];
    if (!first) continue;
    const lw = Math.max(1, s.width * width);
    ctx.save();
    ctx.globalAlpha = s.tool === "highlighter" ? HIGHLIGHT_ALPHA : 1;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (pts.length === 1) {
      ctx.arc(first[0] * width, first[1] * height, lw / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(first[0] * width, first[1] * height);
      // Through the midpoints, each point a control point: a smooth line that still passes near every sample.
      for (let i = 1; i < pts.length - 1; i++) {
        const [x, y] = pts[i]!;
        const [nx, ny] = pts[i + 1]!;
        ctx.quadraticCurveTo(x * width, y * height, ((x + nx) / 2) * width, ((y + ny) / 2) * height);
      }
      const last = pts[pts.length - 1]!;
      ctx.lineTo(last[0] * width, last[1] * height);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** What the ink canvas shows: it is redrawn only when this changes (a point, a stroke, the size). */
export function inkSignature(strokes: readonly { data: InkStroke }[], width: number, height: number): string {
  let sig = `${width}x${height}`;
  for (const { data } of strokes) sig += `|${data.stroke}:${data.points.length}:${data.done ? 1 : 0}`;
  return sig;
}
