// The files a speaker can add as slides, all read in the browser (nothing goes to a server to convert):
// PDF through PDF.js (deck.ts), PowerPoint through pptx-browser (drawn on a canvas), and pictures as one slide
// each. Keynote, OpenDocument and old binary PowerPoint have no browser reader: the speaker is told how to
// export a PDF instead. Each loader is its own lazy chunk.

import { type Deck, type RenderedSlide, SLIDE_WIDTH, THUMB_WIDTH, openPdf, slideFromCanvas, toBlob } from "./deck";

/** The largest deck a speaker can add (one file, or all the pictures together). */
export const MAX_DECK_MB = 100;

export type SlideFileKind = "pdf" | "pptx" | "image" | "keynote" | "odp" | "ppt" | "other";

const EXT = /\.([a-z0-9]+)$/i;

/** What a file is, by its type or, where the browser gives none, its extension. */
export function kindOf(file: Pick<File, "name" | "type">): SlideFileKind {
  const ext = EXT.exec(file.name)?.[1]?.toLowerCase() ?? "";
  const type = file.type.toLowerCase();
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (type.includes("presentationml") || ext === "pptx" || ext === "ppsx") return "pptx";
  if (/^image\/(png|jpeg|webp|gif|avif)$/.test(type) || /^(png|jpe?g|webp|gif|avif)$/.test(ext)) return "image";
  if (ext === "key" || type.includes("keynote")) return "keynote";
  if (ext === "odp" || type.includes("opendocument.presentation")) return "odp";
  if (ext === "ppt" || ext === "pps" || type === "application/vnd.ms-powerpoint") return "ppt";
  return "other";
}

/** The `accept` list for a file picker. */
export const SLIDE_ACCEPT = [
  "application/pdf",
  ".pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pptx",
  ".ppsx",
  "image/png",
  "image/jpeg",
  "image/webp",
  ".key",
  ".odp",
  ".ppt",
].join(",");

const EXPORT_PDF: Partial<Record<SlideFileKind, string>> = {
  keynote: "Keynote files can't be read in the browser. In Keynote choose File › Export To › PDF, then add the PDF.",
  odp: "OpenDocument slides can't be read in the browser. In LibreOffice Impress choose File › Export as PDF, then add the PDF.",
  ppt: "Old .ppt files can't be read in the browser. Open it in PowerPoint and save it as .pptx or PDF, then add that.",
};

/**
 * Check what the speaker chose before reading it: one PDF or PowerPoint file, or one or more pictures, within the
 * size limit. Returns the message to show, or undefined when the files can be opened.
 */
export function checkSlideFiles(files: readonly Pick<File, "name" | "type" | "size">[]): string | undefined {
  if (!files.length) return "No file was chosen.";
  const kinds = files.map(kindOf);
  for (const k of kinds) if (EXPORT_PDF[k]) return EXPORT_PDF[k];
  const images = kinds.every((k) => k === "image");
  if (!images && files.length > 1)
    return "Add one PDF or PowerPoint file at a time, or several pictures (PNG, JPG, WebP) together.";
  if (kinds[0] === "other")
    return `${files[0].name} isn't a slide file. Add a PDF, a PowerPoint (.pptx) file, or pictures (PNG, JPG, WebP).`;
  const bytes = files.reduce((n, f) => n + f.size, 0);
  if (bytes > MAX_DECK_MB * 1024 * 1024) {
    const mb = Math.ceil(bytes / (1024 * 1024));
    const what = files.length > 1 ? "These pictures are" : `${files[0].name} is`;
    return `${what} ${mb} MB; the limit is ${MAX_DECK_MB} MB. Export a smaller file (compress the pictures) and add it again.`;
  }
  return undefined;
}

/** Open what the speaker chose as a deck. Throws with a message a speaker can act on. */
export async function openSlides(input: File | readonly File[]): Promise<Deck> {
  const files = Array.isArray(input) ? [...(input as readonly File[])] : [input as File];
  const problem = checkSlideFiles(files);
  if (problem) throw new Error(problem);
  const kind = kindOf(files[0]);
  if (kind === "pdf") return openPdf(files[0]);
  if (kind === "pptx") return openPptx(files[0]);
  return openImages(files);
}

/** A deck of `count` slides drawn by `draw(index, canvas, width)`, rendered once per size and cached. */
function canvasDeck(
  meta: Omit<Deck, "render" | "thumbnail" | "close">,
  draw: (index: number, canvas: HTMLCanvasElement, width: number) => Promise<void>,
  dispose: () => void,
): Deck {
  const rendered = new Map<number, Promise<RenderedSlide>>();
  const thumbs = new Map<number, Promise<string>>();
  return {
    ...meta,
    render(index) {
      let p = rendered.get(index);
      if (!p) {
        const canvas = document.createElement("canvas");
        p = draw(index, canvas, SLIDE_WIDTH).then(() => slideFromCanvas(index, canvas, []));
        rendered.set(index, p);
      }
      return p;
    },
    thumbnail(index) {
      let p = thumbs.get(index);
      if (!p) {
        const canvas = document.createElement("canvas");
        p = draw(index, canvas, THUMB_WIDTH)
          .then(() => toBlob(canvas, "image/jpeg", 0.8))
          .then((b) => URL.createObjectURL(b));
        thumbs.set(index, p);
      }
      return p;
    },
    close() {
      for (const p of rendered.values()) void p.then((s) => URL.revokeObjectURL(s.url)).catch(() => undefined);
      for (const p of thumbs.values()) void p.then((u) => URL.revokeObjectURL(u)).catch(() => undefined);
      dispose();
    },
  };
}

const stem = (name: string) => name.replace(EXT, "");

/** A PowerPoint file, drawn on a canvas by pptx-browser (MIT, no dependencies; loaded on demand). */
export async function openPptx(file: File): Promise<Deck> {
  const { PptxRenderer } = await import("pptx-browser");
  const pptx = new PptxRenderer();
  try {
    await pptx.load(file);
  } catch (e) {
    pptx.destroy();
    const reason = e instanceof Error ? e.message : String(e);
    // A password-protected PowerPoint file is an encrypted container, not a zip.
    const locked = /zip|signature|central directory/i.test(reason);
    throw new Error(
      locked
        ? `${file.name} could not be read: it may be password-protected or damaged. Save a copy without a password (or as PDF), then add that.`
        : `${file.name} could not be opened as a PowerPoint file (${reason}).`,
      { cause: e },
    );
  }
  if (!pptx.slideCount) {
    pptx.destroy();
    throw new Error(`${file.name} has no slides.`);
  }
  return canvasDeck(
    {
      name: file.name,
      title: stem(file.name),
      count: pptx.slideCount,
      aspect: pptx.getInfo().aspectRatio,
      fingerprint: `pptx:${file.name}:${file.size}:${file.lastModified}`,
    },
    (index, canvas, width) => pptx.renderSlide(index, canvas, width),
    () => pptx.destroy(),
  );
}

/** Pictures, one slide each, in name order (a picker hands them over in any order). */
export async function openImages(input: readonly File[]): Promise<Deck> {
  const files = [...input].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const decode = async (file: File) => {
    try {
      return await createImageBitmap(file);
    } catch (e) {
      throw new Error(`${file.name} could not be read as a picture.`, { cause: e });
    }
  };
  const first = await decode(files[0]);
  const aspect = first.width / first.height;
  first.close();
  return canvasDeck(
    {
      name: files.length === 1 ? files[0].name : `${files.length} pictures`,
      title: files.length === 1 ? stem(files[0].name) : null,
      count: files.length,
      aspect,
      fingerprint: `images:${files.map((f) => `${f.name}:${f.size}`).join("|")}`,
    },
    async (index, canvas, width) => {
      const bitmap = await decode(files[index]);
      // Never larger than the picture itself.
      const w = Math.min(width, bitmap.width);
      canvas.width = w;
      canvas.height = Math.round((bitmap.height * w) / bitmap.width);
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
    },
    () => undefined,
  );
}
