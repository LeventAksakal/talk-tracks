// The speaker's archived media (design §5.5): HLS with fMP4 segments from the archive over HTTP, played
// by hls.js, or natively on Safari and iPhone. hls.js handles gaps, discontinuities and new init
// segments. The playhead becomes room time only through PROGRAM-DATE-TIME (hls.js playingDate, Safari
// getStartDate() + currentTime), never from currentTime alone: room time = that wall time − E.

import type HlsType from "hls.js";
import { mergeRanges, type Range } from "./slices";

/** The room's playlist. Assumed until the archive lane fixes the layout. */
export const hlsUrl = (room: string, base = "/archive") => `${base.replace(/\/$/, "")}/${room}/index.m3u8`;

/**
 * Wall-time ranges (Unix ms) a media playlist covers: each segment from its PROGRAM-DATE-TIME (carried
 * forward over EXTINF when a segment has none) for its duration, minus EXT-X-GAP segments.
 */
export function playlistWallRanges(text: string): Range[] {
  const out: Range[] = [];
  let pdt: number | undefined;
  let duration: number | undefined;
  let gap = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      const t = Date.parse(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length));
      if (Number.isFinite(t)) pdt = t;
    } else if (line.startsWith("#EXTINF:")) {
      duration = parseFloat(line.slice("#EXTINF:".length)) * 1000;
    } else if (line === "#EXT-X-GAP") {
      gap = true;
    } else if (line && !line.startsWith("#")) {
      if (pdt !== undefined && duration !== undefined) {
        if (!gap) out.push({ start: pdt, end: pdt + duration });
        pdt += duration;
      }
      duration = undefined;
      gap = false;
    }
  }
  return mergeRanges(out);
}

/** The first variant's URI of a multivariant playlist, or undefined for a media playlist. */
export function firstVariant(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const i = lines.findIndex((l) => l.startsWith("#EXT-X-STREAM-INF"));
  if (i < 0) return undefined;
  return lines.slice(i + 1).find((l) => l && !l.startsWith("#"));
}

/** What the archive holds, as wall-time ranges, from the room's playlist. Empty when there is none. */
export async function archivedWallRanges(url: string, fetchFn: typeof fetch = fetch): Promise<Range[]> {
  const get = async (u: string) => {
    const r = await fetchFn(u);
    return r.ok ? r.text() : undefined;
  };
  const top = await get(url);
  if (top === undefined) return [];
  const variant = firstVariant(top);
  if (variant === undefined) return playlistWallRanges(top);
  const media = await get(new URL(variant, new URL(url, location.href)).href);
  return media === undefined ? [] : playlistWallRanges(media);
}

/** One archive playback on a video element, addressed in wall time (Unix ms). */
export interface ArchivePlayback {
  /** Start at wall time `wallMs` (into the next segment when it falls in a hole). */
  open(wallMs: number): Promise<void>;
  seek(wallMs: number): void;
  /** The playhead, wall ms, from PROGRAM-DATE-TIME. */
  position(): number | undefined;
  /** What the element holds, wall ms. */
  buffered(): Range[];
  readonly element: HTMLVideoElement;
  readonly error: string | undefined;
  close(): void;
}

/** hls.js where Media Source Extensions exist, else the browser's own HLS (Safari, iPhone). */
export async function openArchive(video: HTMLVideoElement, url: string): Promise<ArchivePlayback> {
  const { default: Hls } = await import("hls.js");
  if (Hls.isSupported()) return new HlsJsPlayback(Hls, video, url);
  if (video.canPlayType("application/vnd.apple.mpegurl")) return new NativePlayback(video, url);
  throw new Error("this browser cannot play the archived media");
}

class HlsJsPlayback implements ArchivePlayback {
  readonly element: HTMLVideoElement;
  #hls: HlsType;
  #ready: Promise<void>;
  #error: string | undefined;

  constructor(Hls: typeof HlsType, video: HTMLVideoElement, url: string) {
    this.element = video;
    this.#hls = new Hls({ enableWorker: true, lowLatencyMode: false });
    this.#ready = new Promise((resolve, reject) => {
      this.#hls.once(Hls.Events.LEVEL_LOADED, () => resolve());
      this.#hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        this.#error = `${data.type}: ${data.details}`;
        reject(new Error(this.#error));
      });
    });
    this.#hls.attachMedia(video);
    this.#hls.loadSource(url);
  }

  get error(): string | undefined {
    return this.#error;
  }

  async open(wallMs: number): Promise<void> {
    await this.#ready;
    this.seek(wallMs);
  }

  seek(wallMs: number): void {
    const t = this.#timeOf(wallMs);
    if (t !== undefined) this.element.currentTime = t;
  }

  position(): number | undefined {
    return this.#hls.playingDate?.getTime() ?? undefined;
  }

  buffered(): Range[] {
    return mapBuffered(this.element, this.position());
  }

  close(): void {
    this.#hls.destroy();
    this.element.removeAttribute("src");
    this.element.load();
  }

  /** The element time of a wall time: through the fragment whose PROGRAM-DATE-TIME holds it, or the next one. */
  #timeOf(wallMs: number): number | undefined {
    const level = this.#hls.levels[Math.max(0, this.#hls.currentLevel)] ?? this.#hls.levels[0];
    const fragments = level?.details?.fragments ?? [];
    let next: { start: number } | undefined;
    for (const f of fragments) {
      if (f.programDateTime == null || f.gap) continue;
      const end = f.programDateTime + f.duration * 1000;
      if (wallMs >= f.programDateTime && wallMs < end) return f.start + (wallMs - f.programDateTime) / 1000;
      if (f.programDateTime > wallMs && !next) next = f;
    }
    return next?.start;
  }
}

class NativePlayback implements ArchivePlayback {
  readonly element: HTMLVideoElement;
  #error: string | undefined;

  constructor(video: HTMLVideoElement, url: string) {
    this.element = video;
    video.src = url;
    video.addEventListener("error", () => (this.#error = video.error?.message ?? "media error"), { once: true });
  }

  get error(): string | undefined {
    return this.#error;
  }

  async open(wallMs: number): Promise<void> {
    if (this.element.readyState < HTMLMediaElement.HAVE_METADATA)
      await new Promise((r) => this.element.addEventListener("loadedmetadata", r, { once: true }));
    this.seek(wallMs);
  }

  #start(): number | undefined {
    const d = (this.element as HTMLVideoElement & { getStartDate?: () => Date }).getStartDate?.();
    const t = d?.getTime();
    return t !== undefined && Number.isFinite(t) ? t : undefined;
  }

  seek(wallMs: number): void {
    const start = this.#start();
    if (start !== undefined) this.element.currentTime = Math.max(0, (wallMs - start) / 1000);
  }

  position(): number | undefined {
    const start = this.#start();
    return start === undefined ? undefined : start + this.element.currentTime * 1000;
  }

  buffered(): Range[] {
    return mapBuffered(this.element, this.position());
  }

  close(): void {
    this.element.removeAttribute("src");
    this.element.load();
  }
}

/** The element's buffered ranges in wall time, mapped through the playhead's own PROGRAM-DATE-TIME. */
function mapBuffered(element: HTMLMediaElement, positionWall: number | undefined): Range[] {
  if (positionWall === undefined) return [];
  const shift = positionWall - element.currentTime * 1000;
  const b = element.buffered;
  const out: Range[] = [];
  for (let i = 0; i < b.length; i++) out.push({ start: b.start(i) * 1000 + shift, end: b.end(i) * 1000 + shift });
  return mergeRanges(out);
}
