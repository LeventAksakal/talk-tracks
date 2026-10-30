// A PDF deck rendered to slide images in the browser with PDF.js (decision 0023): each page becomes
// a WebP for the `deck` track (with its text runs for text marks) and a JPEG for the describe agent's
// `frames`. Loaded on demand: PDF.js is large, and its parser runs in its own worker.

import type { DeckImage, TextRun } from "../contracts/types";
import { textRuns } from "./runs";

/** Slide images are at most this wide (the player shows them up to full screen). */
export const SLIDE_WIDTH = 1600;
/** The describe agent's picture (SlideFrame), as the screen-share frames were. */
export const FRAME_WIDTH = 1280;

export interface RenderedSlide {
  index: number;
  image: DeckImage;
  /** Object URL of the image, for the console's own views. */
  url: string;
  runs: TextRun[];
  /** The SlideFrame picture (JPEG) for the describe agent. */
  frame: { mime: "image/jpeg"; data_b64: string };
}

export interface Deck {
  name: string;
  title: string | null;
  count: number;
  /** Width / height of the first page. */
  aspect: number;
  /** Stable for the same file: keys the speaker's private notes. */
  fingerprint: string;
  render(index: number): Promise<RenderedSlide>;
  close(): void;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("could not read the image"));
    reader.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(",") + 1);
}

function toBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode the slide"))), mime, quality),
  );
}

/** Open a PDF file as a deck. Throws with a message a speaker can act on. */
export async function openPdf(file: File): Promise<Deck> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`This file could not be opened as a PDF (${reason}).`, { cause: e });
  }
  const first = await doc.getPage(1);
  const base = first.getViewport({ scale: 1 });
  const meta = await doc.getMetadata().catch(() => undefined);
  const info = meta?.info as { Title?: unknown } | undefined;
  const title = typeof info?.Title === "string" && info.Title.trim() ? info.Title.trim() : null;
  const rendered = new Map<number, Promise<RenderedSlide>>();

  const renderPage = async (index: number): Promise<RenderedSlide> => {
    const page = await doc.getPage(index + 1);
    const unit = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: SLIDE_WIDTH / unit.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, viewport }).promise;
    let blob = await toBlob(canvas, "image/webp", 0.85);
    // A browser without a WebP encoder hands back PNG.
    if (blob.type !== "image/webp") blob = await toBlob(canvas, "image/jpeg", 0.85);
    const frameCanvas = document.createElement("canvas");
    frameCanvas.width = FRAME_WIDTH;
    frameCanvas.height = Math.round((canvas.height * FRAME_WIDTH) / canvas.width);
    frameCanvas.getContext("2d")?.drawImage(canvas, 0, 0, frameCanvas.width, frameCanvas.height);
    const jpeg = await toBlob(frameCanvas, "image/jpeg", 0.8);
    const content = await page.getTextContent();
    type Item = (typeof content.items)[number];
    const items = content.items.filter((i): i is Extract<Item, { transform: unknown }> => "transform" in i);
    const runs = textRuns(items, viewport);
    page.cleanup();
    return {
      index,
      runs,
      url: URL.createObjectURL(blob),
      image: {
        kind: "image",
        index,
        mime: blob.type === "image/webp" ? "image/webp" : "image/jpeg",
        width: canvas.width,
        height: canvas.height,
        data_b64: await blobToBase64(blob),
        runs,
      },
      frame: { mime: "image/jpeg", data_b64: await blobToBase64(jpeg) },
    };
  };

  return {
    name: file.name,
    title: title ?? file.name.replace(/\.pdf$/i, ""),
    count: doc.numPages,
    aspect: base.width / base.height,
    fingerprint: doc.fingerprints[0] ?? `${file.name}:${file.size}`,
    render(index) {
      let p = rendered.get(index);
      if (!p) rendered.set(index, (p = renderPage(index)));
      return p;
    },
    close() {
      for (const p of rendered.values()) void p.then((s) => URL.revokeObjectURL(s.url)).catch(() => undefined);
      void task.destroy();
    },
  };
}
