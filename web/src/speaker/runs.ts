// A slide's text layer as TextRuns (decision 0021): PDF.js `page.getTextContent()` items placed on
// the rendered page, each run's box in fractions of the slide. Text marks address these runs
// ("underline slide 13, run t23"); a part of a run is placed by character count across its box.

import type { Region, TextRun } from "../contracts/types";

/** The fields of a PDF.js TextItem the layout needs. */
export interface PdfTextItem {
  str: string;
  /** Text space to PDF user space, [a, b, c, d, e, f]. */
  transform: number[];
  /** Advance width in PDF user space. */
  width: number;
}

/** The fields of a PDF.js PageViewport the layout needs. */
export interface PdfViewport {
  width: number;
  height: number;
  scale: number;
  /** PDF user space to viewport pixels. */
  transform: number[];
}

/** Share of the font size above the baseline (PDF.js's text layer default). */
const ASCENT = 0.8;

/** PDF.js Util.transform: m1 · m2 for 2D affine matrices [a, b, c, d, e, f]. */
export function multiply(m1: readonly number[], m2: readonly number[]): number[] {
  const [a1 = 1, b1 = 0, c1 = 0, d1 = 1, e1 = 0, f1 = 0] = m1;
  const [a2 = 1, b2 = 0, c2 = 0, d2 = 1, e2 = 0, f2 = 0] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000;

/**
 * The runs of a page in reading order (content order), ids t0, t1, … in that order. Whitespace-only
 * and zero-width items are skipped; so is rotated text, which a horizontal box cannot place.
 */
export function textRuns(items: readonly PdfTextItem[], viewport: PdfViewport): TextRun[] {
  const runs: TextRun[] = [];
  for (const item of items) {
    if (!item.str.trim() || item.width <= 0) continue;
    const [a = 0, b = 0, c = 0, d = 0, x = 0, baseline = 0] = multiply(viewport.transform, item.transform);
    if (Math.abs(b) > 1e-6 * Math.abs(a) || a <= 0) continue;
    const size = Math.hypot(c, d);
    const width = item.width * viewport.scale;
    if (size <= 0 || width <= 0) continue;
    const box: Region = {
      x: clamp(x / viewport.width),
      y: clamp((baseline - size * ASCENT) / viewport.height),
      w: clamp(width / viewport.width),
      h: clamp(size / viewport.height),
    };
    runs.push({ id: `t${runs.length}`, text: item.str, box });
  }
  return runs;
}

export { DRAG_REACH, hitText, rangeBetween, rangeBoxes, spanBox } from "../annotate/geometry";
