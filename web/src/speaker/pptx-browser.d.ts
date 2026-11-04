// pptx-browser ships plain JavaScript; the part of its API the console uses (slideFiles.ts).
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
