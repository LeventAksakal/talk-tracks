// A looped demo room's archive is its recording (wiki/howto/archive.md: the archiver skips these rooms).
// The looper plays one lecture file over and over on the room clock: loop k starts at media time
// k × period (the lecture rounded up to whole 4 s slices) and file time f plays at media time
// k × period + f, with the media clock anchored at the hang catalog's root `clock` (agents/replay.py).
// So any room time maps to a place in the one file, and seeking plays that file from there, mapped back
// to wall time through the same arithmetic. The teacher's hang catalog says a room loops: its
// `talk_tracks` section carries `period_ms` and `duration_ms`.

import type { ArchivePlayback } from "./hlsArchive";
import { mapBuffered } from "./hlsArchive";
import { type HangClock, hangClockOf, wallClockMs } from "./roomClock";
import type { Range } from "./slices";

/** HTMLMediaElement.HAVE_METADATA (not every DOM implementation defines the constant). */
const HAVE_METADATA = 1;

/** The recording a looped room plays, served beside the archive (one copy per demo room). */
export const loopUrl = (room: string, base = "/archive") => `${base.replace(/\/$/, "")}/${room}/lecture.mp4`;

/** How a looped room's media sits on the wall clock. */
export interface LoopInfo {
  /** Wall time (Unix ms) of media time 0, the broadcast's shift included: room time = wall − E. */
  wallZeroMs: number;
  /** One loop on the room clock, ms. */
  periodMs: number;
  /** The lecture file, ms; the rest of the period is silence. */
  durationMs: number;
}

/** The loop of a teacher hang catalog (parsed JSON), or undefined when the room does not loop. */
export function loopOf(catalog: unknown): { clock: HangClock; periodMs: number; durationMs: number } | undefined {
  const clock = hangClockOf(catalog);
  const tt = (catalog as { talk_tracks?: unknown } | undefined)?.talk_tracks;
  if (!clock || !tt || typeof tt !== "object") return undefined;
  const { period_ms: period, duration_ms: duration } = tt as { period_ms?: unknown; duration_ms?: unknown };
  if (typeof period !== "number" || !Number.isFinite(period) || period <= 0) return undefined;
  const durationMs = typeof duration === "number" && duration > 0 ? Math.min(duration, period) : period;
  return { clock, periodMs: period, durationMs };
}

/** LoopInfo from a catalog's loop and the broadcast's shift (room catalog `tt.shift`, 0 normally). */
export function loopInfo(loop: NonNullable<ReturnType<typeof loopOf>>, shiftMs = 0): LoopInfo {
  return { wallZeroMs: wallClockMs(loop.clock, 0) + shiftMs, periodMs: loop.periodMs, durationMs: loop.durationMs };
}

/** Where wall time `wallMs` falls: the loop, and the file time in it (ms, may lie in the silent tail). */
export function loopPlace(info: LoopInfo, wallMs: number): { loop: number; fileMs: number } {
  const media = Math.max(0, wallMs - info.wallZeroMs);
  const loop = Math.floor(media / info.periodMs);
  return { loop, fileMs: media - loop * info.periodMs };
}

/** Wall time of file time `fileMs` in loop `loop`. */
export function loopWall(info: LoopInfo, loop: number, fileMs: number): number {
  return info.wallZeroMs + loop * info.periodMs + fileMs;
}

/**
 * The recording on a video element, addressed in wall time like the HLS archive. Past the end of the
 * file it holds still, silent, until the period ends, then plays the next loop from the start.
 */
export class LoopPlayback implements ArchivePlayback {
  readonly element: HTMLVideoElement;
  #info: LoopInfo;
  #now: () => number;
  #loop = 0;
  /** In the silent tail after the file ended: from which file time, since when (this device's ms). */
  #tail: { fileMs: number; at: number } | undefined;
  #tailTimer: ReturnType<typeof setTimeout> | undefined;
  #wantPlay = false;
  #error: string | undefined;
  #off: (() => void)[] = [];

  constructor(video: HTMLVideoElement, url: string, info: LoopInfo, options: { now?: () => number } = {}) {
    this.element = video;
    this.#info = info;
    this.#now = options.now ?? Date.now;
    const on = (type: string, fn: () => void) => {
      video.addEventListener(type, fn);
      this.#off.push(() => video.removeEventListener(type, fn));
    };
    on("play", () => {
      this.#wantPlay = true;
      if (this.#tail) video.pause(); // the tail is silence: the next loop starts on time by itself
    });
    on("pause", () => {
      if (!video.ended && !this.#tail) this.#wantPlay = false;
    });
    on("ended", () => {
      if (!this.#tail) this.#enterTail(this.#fileDurationMs());
    });
    on("error", () => (this.#error = video.error?.message || "the recording could not be played"));
    video.preload = "auto";
    video.src = url;
  }

  get error(): string | undefined {
    return this.#error;
  }

  async open(wallMs: number): Promise<void> {
    const video = this.element;
    if (video.readyState < HAVE_METADATA) {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          video.removeEventListener("loadedmetadata", done);
          video.removeEventListener("error", fail);
          resolve();
        };
        const fail = () => {
          video.removeEventListener("loadedmetadata", done);
          video.removeEventListener("error", fail);
          reject(new Error(video.error?.message || "the recording could not be loaded"));
        };
        video.addEventListener("loadedmetadata", done);
        video.addEventListener("error", fail);
      });
    }
    this.seek(wallMs);
  }

  seek(wallMs: number): void {
    const { loop, fileMs } = loopPlace(this.#info, wallMs);
    this.#loop = loop;
    this.#leaveTail();
    if (fileMs >= this.#fileDurationMs() - 50) this.#enterTail(fileMs);
    else this.element.currentTime = fileMs / 1000;
  }

  /** The recording is static: nothing to read again. */
  reload(): void {}

  pause(): void {
    this.#wantPlay = false;
    this.element.pause();
  }

  position(): number | undefined {
    if (this.#tail) {
      const fileMs = Math.min(this.#info.periodMs, this.#tail.fileMs + (this.#now() - this.#tail.at));
      return loopWall(this.#info, this.#loop, fileMs);
    }
    if (this.element.readyState < HAVE_METADATA) return undefined;
    return loopWall(this.#info, this.#loop, this.element.currentTime * 1000);
  }

  buffered(): Range[] {
    return this.#tail ? [] : mapBuffered(this.element, this.position());
  }

  close(): void {
    this.#leaveTail();
    this.#off.forEach((fn) => fn());
    this.element.removeAttribute("src");
    this.element.load();
  }

  #fileDurationMs(): number {
    const d = this.element.duration;
    return Number.isFinite(d) && d > 0 ? Math.min(d * 1000, this.#info.periodMs) : this.#info.durationMs;
  }

  /** Silence from file time `fileMs` to the period's end, then the next loop from its start. */
  #enterTail(fileMs: number): void {
    const wasPlaying = this.#wantPlay || !this.element.paused;
    this.#leaveTail();
    this.#wantPlay = wasPlaying;
    if (!this.element.paused) this.element.pause();
    this.#tail = { fileMs, at: this.#now() };
    this.#tailTimer = setTimeout(
      () => {
        this.#leaveTail();
        this.#loop += 1;
        this.element.currentTime = 0;
        if (this.#wantPlay) void this.element.play().catch(() => {});
      },
      Math.max(0, this.#info.periodMs - fileMs),
    );
  }

  #leaveTail(): void {
    clearTimeout(this.#tailTimer);
    this.#tailTimer = undefined;
    this.#tail = undefined;
  }
}
