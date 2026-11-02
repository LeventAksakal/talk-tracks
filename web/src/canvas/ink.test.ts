import { describe, expect, it } from "vitest";
import type { InkElement } from "../contracts/types";
import { type Casing, type Ctx2D, drawElements } from "./ink";

/** A context that records what is painted: each stroke() and fill() with the colour and width it was given. */
function recorder() {
  const paints: { op: "stroke" | "fill"; color: string; width: number; alpha: number }[] = [];
  const state = { strokeStyle: "", fillStyle: "", lineWidth: 1, globalAlpha: 1 };
  const ctx = new Proxy(state, {
    get: (target, name: string) => {
      if (name in target) return target[name as keyof typeof target];
      if (name === "stroke")
        return () =>
          paints.push({ op: "stroke", color: target.strokeStyle, width: target.lineWidth, alpha: target.globalAlpha });
      if (name === "fill")
        return () =>
          paints.push({ op: "fill", color: target.fillStyle, width: target.lineWidth, alpha: target.globalAlpha });
      return () => undefined;
    },
  }) as unknown as Ctx2D;
  return { ctx, paints };
}

const by = { id: "a", name: "A" };
const chalk = "#f7f4ea";
const casing: Casing = { color: "#000000", alpha: 0.7, px: 2 };
const pen: InkElement = {
  kind: "stroke",
  stroke: "s1",
  deck: 0,
  index: 0,
  tool: "pen",
  color: chalk,
  width: 0.004,
  done: true,
  by,
  points: [
    [0.1, 0.1],
    [0.2, 0.15],
    [0.3, 0.3],
  ],
};

describe("the ink casing (brand.md §3)", () => {
  it("outlines a pen stroke and every shape in the casing colour before the chalk goes on top", () => {
    const shape = (kind: "rect" | "arrow"): InkElement => ({
      kind: "shape",
      stroke: kind,
      deck: 0,
      index: 0,
      shape: kind,
      start: [0.1, 0.1],
      end: [0.4, 0.4],
      color: chalk,
      width: 0.004,
      by,
    });
    for (const el of [pen, shape("rect"), shape("arrow")]) {
      const { ctx, paints } = recorder();
      drawElements(ctx, [el], 1000, 500, casing);
      const under = paints.findIndex((p) => p.color === casing.color);
      const over = paints.findIndex((p) => p.color === chalk);
      expect(under).toBeGreaterThanOrEqual(0);
      expect(over).toBeGreaterThan(under);
      // The outline reaches past the chalk on both sides.
      if (el.kind === "shape") expect(paints[under]!.width).toBeGreaterThan(paints[over]!.width);
    }
  });

  it("draws a diamond with its corners at the middles of its box's sides", () => {
    const path: number[][] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (_, name: string) =>
        name === "moveTo" || name === "lineTo" ? (x: number, y: number) => path.push([x, y]) : () => undefined,
      set: () => true,
    }) as unknown as Ctx2D;
    const diamond: InkElement = {
      kind: "shape",
      stroke: "d",
      deck: 0,
      index: 0,
      shape: "diamond",
      start: [0.2, 0.2],
      end: [0.6, 0.6],
      color: chalk,
      width: 0.004,
      by,
    };
    drawElements(ctx, [diamond], 1000, 500, null);
    expect(path).toEqual([
      [400, 100],
      [600, 200],
      [400, 300],
      [200, 200],
    ]);
  });

  it("leaves the marker without one, and draws none when asked for none", () => {
    const marker: InkElement = { ...pen, tool: "highlighter", width: 0.022 };
    const a = recorder();
    drawElements(a.ctx, [marker], 1000, 500, casing);
    expect(a.paints.some((p) => p.color === casing.color)).toBe(false);
    const b = recorder();
    drawElements(b.ctx, [pen], 1000, 500, null);
    expect(b.paints.map((p) => p.color)).toEqual([chalk]);
  });
});
