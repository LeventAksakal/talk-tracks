// What the speaker's console and the listener's toolbar share about their drawing tools: the stroke widths, so a
// listener's Medium is the speaker's Medium, and the shapes they both draw.

import type { ShapeKind } from "../contracts/types";

/** Stroke widths (fractions of the slide's width): thin, medium, bold, as Excalidraw offers three. */
export type WidthStep = 0 | 1 | 2;
export const WIDTHS: Record<"pen" | "highlighter" | "shape", readonly [number, number, number]> = {
  pen: [0.0025, 0.004, 0.008],
  highlighter: [0.014, 0.022, 0.036],
  shape: [0.0025, 0.004, 0.008],
};
export const WIDTH_NAMES: Record<WidthStep, string> = { 0: "Thin", 1: "Medium", 2: "Bold" };

/** The shapes in toolbar order. */
export const SHAPES: readonly ShapeKind[] = ["rect", "ellipse", "arrow", "line"];
export const SHAPE_LABELS: Record<ShapeKind, string> = {
  rect: "Rectangle",
  ellipse: "Ellipse",
  arrow: "Arrow",
  line: "Line",
};
