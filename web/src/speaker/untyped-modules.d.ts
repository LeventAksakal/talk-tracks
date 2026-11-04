// Modules that ship plain JavaScript.

// pptx-browser: the part of its API the console uses (slideFiles.ts).
declare module "pptx-browser" {
  export class PptxRenderer {
    slideCount: number;
    load(source: File | Blob | ArrayBuffer | Uint8Array): Promise<void>;
    /** Draws slide `index` (0-based) on `canvas`, `width` pixels wide; the height follows the slide's aspect. */
    renderSlide(index: number, canvas: HTMLCanvasElement, width?: number): Promise<void>;
    getInfo(): { slideCount: number; aspectRatio: number };
    destroy(): void;
  }
}

// PDF.js's parser, run in the test runner's own thread (slideFiles.test.ts).
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";
