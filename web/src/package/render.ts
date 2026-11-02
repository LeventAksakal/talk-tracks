// A slide as a PNG with its final ink and text marks baked in: the deck's picture at its own size, the marks as the
// player draws them (overlays.markBoxes), and the ink through the shared drawer (canvas/ink.ts), which takes an
// OffscreenCanvas context. Where OffscreenCanvas is missing, a detached <canvas> does the same.

import { type Ctx2D, drawElements } from "../canvas/ink";
import type { DeckImage, InkElement, TextMark } from "../contracts/types";
import { markBoxes } from "../player/overlays";

export interface SlideToRender {
  image: DeckImage | undefined;
  /** Width / height, for a slide with no picture. */
  aspect: number;
  ink: readonly InkElement[];
  marks: readonly TextMark[];
}

/** Draws one slide to PNG bytes; injected in tests (no canvas in the test DOM). */
export type SlideRenderer = (slide: SlideToRender) => Promise<Uint8Array | undefined>;

/** Width of a slide drawn with no picture (ink on a blank page). */
const BLANK_WIDTH = 1600;
/** How opaque a highlight is (player.css .tt-textmark-highlight). */
const HIGHLIGHT_OPACITY = 0.4;

function bytesOf(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type Surface = {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: Ctx2D & Pick<CanvasRenderingContext2D, "drawImage" | "fillRect" | "globalCompositeOperation">;
  toPng: () => Promise<Blob>;
};

function surface(width: number, height: number): Surface | undefined {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(width, height);
    const ctx = c.getContext("2d");
    if (!ctx) return undefined;
    return { canvas: c, ctx, toPng: () => c.convertToBlob({ type: "image/png" }) };
  }
  if (typeof document === "undefined") return undefined;
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
  if (!ctx) return undefined;
  return {
    canvas: c,
    ctx,
    toPng: () =>
      new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("no PNG"))), "image/png")),
  };
}

/** The browser's renderer: undefined when this browser cannot draw (the slide then ships as text only). */
export const renderSlidePng: SlideRenderer = async ({ image, aspect, ink, marks }) => {
  const width = image?.width ?? BLANK_WIDTH;
  const height = image?.height ?? Math.round(BLANK_WIDTH / (aspect || 16 / 9));
  const s = surface(width, height);
  if (!s) return undefined;
  const { ctx } = s;
  if (image) {
    const bitmap = await createImageBitmap(new Blob([bytesOf(image.data_b64) as BlobPart], { type: image.mime }));
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }
  for (const mark of marks) {
    for (const box of markBoxes(mark.span, image?.runs ?? [])) {
      const [x, y, w, h] = [box.x * width, box.y * height, box.w * width, box.h * height];
      ctx.save();
      ctx.fillStyle = mark.color;
      if (mark.style === "highlight") {
        ctx.globalAlpha = HIGHLIGHT_OPACITY;
        ctx.globalCompositeOperation = "multiply";
        ctx.fillRect(x, y, w, h);
      } else {
        const thick = Math.max(2, h * 0.09);
        ctx.fillRect(x, y + h + h * 0.04 - thick, w, thick);
      }
      ctx.restore();
    }
  }
  // drawElements clears first: draw the ink on its own layer, then lay it over the slide.
  const layer = ink.length ? surface(width, height) : undefined;
  if (layer) {
    drawElements(layer.ctx, ink, width, height);
    ctx.drawImage(layer.canvas, 0, 0);
  }
  return new Uint8Array(await (await s.toPng()).arrayBuffer());
};
