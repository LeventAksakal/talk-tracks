import type { SlideFrame } from "../contracts/types";
import type { TrackWriter } from "../transport/types";

export const MAX_WIDTH = 1280;
export const MIN_INTERVAL_MS = 2_000;
const SAMPLE_MS = 500;
const THUMB_W = 64;
const THUMB_H = 36;
/** Mean absolute grey-level change (0..1) that counts as a new slide rather than noise or a cursor. */
export const CHANGE_THRESHOLD = 0.02;

/** Mean absolute difference of two grey thumbnails, 0 (same) to 1. Different lengths count as changed. */
export function frameDifference(a: Uint8Array | undefined, b: Uint8Array): number {
  if (!a || a.length !== b.length) return 1;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!);
  return total / (a.length * 255);
}

/** Fit width×height into maxWidth, keeping the aspect ratio; never upscale. */
export function fitWidth(width: number, height: number, maxWidth = MAX_WIDTH): { width: number; height: number } {
  if (width <= maxWidth) return { width, height };
  return { width: maxWidth, height: Math.round((height * maxWidth) / width) };
}

/** Decide whether to publish a sample: the picture changed visibly and the last slide is ≥2 s old. */
export function shouldPublish(diff: number, now: number, lastSentAt: number | undefined): boolean {
  if (diff < CHANGE_THRESHOLD) return false;
  return lastSentAt === undefined || now - lastSentAt >= MIN_INTERVAL_MS;
}

function toGrey(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = (rgba[i * 4]! * 299 + rgba[i * 4 + 1]! * 587 + rgba[i * 4 + 2]! * 114) / 1000;
  }
  return out;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export interface SharedSlide {
  id: number;
  url: string;
  bytes: number;
}

/**
 * Screen-share slides: sample the captured screen twice a second and publish a JPEG (≤1280 px
 * wide) as a SlideFrame only when the picture visibly changed, at most one every 2 s. `at_ms` is
 * wall time (design §4.5): `stamp` maps the performance clock to it the way @moq/publish maps media
 * timestamps (performance.timeOrigin + now), so the room service turns both into room time alike.
 */
export class SlideSharer {
  #writer: TrackWriter;
  #stream: MediaStream;
  #video = document.createElement("video");
  #thumb = document.createElement("canvas");
  #full = document.createElement("canvas");
  #timer: ReturnType<typeof setInterval> | undefined;
  #last: Uint8Array | undefined;
  #lastSentAt: number | undefined;
  #nextId = 0;
  #busy = false;
  #stamp: (perfMs: number) => number;
  onSlide?: (slide: SharedSlide) => void;
  onEnded?: () => void;

  constructor(
    stream: MediaStream,
    writer: TrackWriter,
    stamp: (perfMs: number) => number = (perfMs) => Math.round(performance.timeOrigin + perfMs),
  ) {
    this.#stream = stream;
    this.#writer = writer;
    this.#stamp = stamp;
    this.#video.muted = true;
    this.#video.playsInline = true;
    this.#video.srcObject = stream;
    this.#thumb.width = THUMB_W;
    this.#thumb.height = THUMB_H;
    for (const track of stream.getVideoTracks()) track.addEventListener("ended", () => this.#ended());
  }

  async start(): Promise<void> {
    await this.#video.play();
    this.#timer = setInterval(() => void this.#sample(), SAMPLE_MS);
  }

  stop(): void {
    clearInterval(this.#timer);
    for (const track of this.#stream.getTracks()) track.stop();
    this.#writer.close();
    this.#video.srcObject = null;
  }

  #ended(): void {
    this.stop();
    this.onEnded?.();
  }

  async #sample(): Promise<void> {
    if (this.#busy || this.#video.readyState < 2 || !this.#video.videoWidth) return;
    const ctx = this.#thumb.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(this.#video, 0, 0, THUMB_W, THUMB_H);
    const grey = toGrey(ctx.getImageData(0, 0, THUMB_W, THUMB_H).data);
    const now = performance.now();
    if (!shouldPublish(frameDifference(this.#last, grey), now, this.#lastSentAt)) return;
    this.#busy = true;
    try {
      const size = fitWidth(this.#video.videoWidth, this.#video.videoHeight);
      this.#full.width = size.width;
      this.#full.height = size.height;
      this.#full.getContext("2d")?.drawImage(this.#video, 0, 0, size.width, size.height);
      const blob = await new Promise<Blob | null>((resolve) => this.#full.toBlob(resolve, "image/jpeg", 0.8));
      if (!blob) return;
      const frame: SlideFrame = {
        id: this.#nextId++,
        at_ms: this.#stamp(now),
        mime: "image/jpeg",
        data_b64: await blobToBase64(blob),
      };
      this.#writer.write(new TextEncoder().encode(JSON.stringify(frame)));
      this.#last = grey;
      this.#lastSentAt = now;
      this.onSlide?.({ id: frame.id, url: URL.createObjectURL(blob), bytes: blob.size });
    } finally {
      this.#busy = false;
    }
  }
}
