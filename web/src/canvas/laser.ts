// The laser's fading trail (brand.md §3, workstream 04), shared by the console's preview and the player. The trail is
// the laser's recent positions, each fading with its age, so it is a pure function of (samples, now): the player
// reads the samples off the pointer track at the frame's room time, live and rewound alike, and the console keeps
// the ones it drew on its own clock.

import type { PointerRecord } from "../contracts/types";

/** How long a position stays in the trail, in ms. */
export const TRAIL_MS = 350;

/** A laser position (fractions of the slide) and when it was there (ms on any one clock). */
export interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

/**
 * The trail at `now` from pointer records in time order: the `at` samples of the last laser stroke within `span` ms,
 * oldest first, ending at `head` (where the laser is now) while it is on. After `off` the samples left keep fading.
 */
export function laserTrail(
  records: readonly PointerRecord[],
  now: number,
  head: { x: number; y: number } | null,
  span = TRAIL_MS,
): TrailPoint[] {
  const out: TrailPoint[] = [];
  let i = records.length - 1;
  while (i >= 0 && records[i]!.m > now) i--;
  while (i >= 0 && records[i]!.data.kind === "off") i--; // the stroke that just ended still fades
  for (; i >= 0; i--) {
    const r = records[i]!;
    if (r.data.kind !== "at" || now - r.m > span) break;
    out.push({ x: r.data.x, y: r.data.y, t: r.m });
  }
  out.reverse();
  if (head) out.push({ x: head.x, y: head.y, t: now });
  return out;
}

/** The console's own trail: positions as it draws them, on its clock. */
export class LaserTrail {
  #points: TrailPoint[] = [];

  /** The laser is at (x, y) at time t; a position the same as the last one only renews it. */
  add(x: number, y: number, t: number): void {
    const last = this.#points.at(-1);
    if (last && last.x === x && last.y === y) last.t = t;
    else this.#points.push({ x, y, t });
  }

  /** What is left of the trail at `now`, oldest first. */
  points(now: number, span = TRAIL_MS): TrailPoint[] {
    const first = this.#points.findIndex((p) => now - p.t <= span);
    this.#points = first < 0 ? [] : this.#points.slice(first);
    return this.#points;
  }
}

type TrailCtx = Pick<
  CanvasRenderingContext2D,
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "stroke"
  | "save"
  | "restore"
  | "lineWidth"
  | "lineCap"
  | "strokeStyle"
  | "globalAlpha"
>;

/**
 * Draw the trail on a canvas of `width` × `height` pixels: segments from the oldest position to the newest,
 * thinner and fainter with age, so it tapers into the laser's dot. Nothing for fewer than two positions.
 */
export function drawLaserTrail(
  ctx: TrailCtx,
  trail: readonly TrailPoint[],
  now: number,
  width: number,
  height: number,
  color: string,
  span = TRAIL_MS,
): void {
  if (trail.length < 2) return;
  const thick = Math.max(3, width * 0.006);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1]!;
    const b = trail[i]!;
    const fresh = 1 - Math.min(1, Math.max(0, (now - b.t) / span));
    if (fresh <= 0) continue;
    ctx.globalAlpha = 0.85 * fresh;
    ctx.lineWidth = thick * (0.3 + 0.7 * fresh);
    ctx.beginPath();
    ctx.moveTo(a.x * width, a.y * height);
    ctx.lineTo(b.x * width, b.y * height);
    ctx.stroke();
  }
  ctx.restore();
}
