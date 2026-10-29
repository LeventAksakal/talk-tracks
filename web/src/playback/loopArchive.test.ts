import { afterEach, describe, expect, it, vi } from "vitest";
import { CATALOG_TRACK, catalogPath, teacherPath } from "../contracts/names";
import { MOQ_EPOCH_UNIX_MS } from "../contracts/types";
import { FakeTransport } from "../transport/fake";
import type { MoqTransport } from "../transport/moq";
import { type LoopInfo, loopInfo, loopOf, LoopPlayback, loopPlace, loopUrl, loopWall } from "./loopArchive";
import { RoomMedia } from "./media";
import { HANG_CATALOG_TRACK } from "./roomClock";

// The virus room as the looper publishes it: media time 0 at 2026-10-01, a 1024 s loop of a 1020.2 s lecture.
const EPOCH = Date.parse("2026-10-01T00:00:00Z");
const teacherCatalog = {
  clock: { wall: (EPOCH - MOQ_EPOCH_UNIX_MS) * 1000, timescale: 1_000_000 },
  audio: {},
  talk_tracks: { loop: 2392, loop_start_ms: 2_449_408_000, duration_ms: 1_020_200, period_ms: 1_024_000 },
};
const info: LoopInfo = { wallZeroMs: EPOCH, periodMs: 1_024_000, durationMs: 1_020_200 };

/** The bits of a video element LoopPlayback uses. */
class FakeVideo extends EventTarget {
  currentTime = 0;
  duration = Number.NaN;
  readyState = 0;
  paused = true;
  ended = false;
  error: MediaError | null = null;
  preload = "";
  src = "";
  buffered = { length: 0, start: () => 0, end: () => 0 };
  plays = 0;
  play(): Promise<void> {
    this.plays++;
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  load(): void {}
  removeAttribute(): void {
    this.src = "";
  }
  /** The file's metadata arrived. */
  loaded(durationS: number): void {
    this.duration = durationS;
    this.readyState = 1;
    this.dispatchEvent(new Event("loadedmetadata"));
  }
  /** Played to the end of the file. */
  end(): void {
    this.currentTime = this.duration;
    this.ended = true;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
    this.dispatchEvent(new Event("ended"));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("looped room recording", () => {
  it("reads the loop from the teacher's hang catalog", () => {
    expect(loopOf(teacherCatalog)).toMatchObject({ periodMs: 1_024_000, durationMs: 1_020_200 });
    expect(loopInfo(loopOf(teacherCatalog)!)).toEqual(info);
    expect(loopInfo(loopOf(teacherCatalog)!, 4_000).wallZeroMs).toBe(EPOCH + 4_000);
    // A speaker's own broadcast has a clock and no loop.
    expect(loopOf({ clock: teacherCatalog.clock, audio: {} })).toBeUndefined();
    expect(loopOf({ talk_tracks: teacherCatalog.talk_tracks })).toBeUndefined();
    expect(loopOf({ ...teacherCatalog, talk_tracks: { period_ms: 0 } })).toBeUndefined();
    expect(loopUrl("virus")).toBe("/archive/virus/lecture.mp4");
  });

  it("places any wall time in a loop and the file", () => {
    // The loop the catalog announces starts at its loop_start_ms.
    expect(loopPlace(info, EPOCH + 2_449_408_000)).toEqual({ loop: 2392, fileMs: 0 });
    expect(loopPlace(info, EPOCH + 2_449_408_000 + 61_500)).toEqual({ loop: 2392, fileMs: 61_500 });
    expect(loopPlace(info, EPOCH + 2_449_408_000 - 1_000)).toEqual({ loop: 2391, fileMs: 1_023_000 });
    expect(loopWall(info, 2392, 61_500)).toBe(EPOCH + 2_449_408_000 + 61_500);
  });

  it("seeks into the file and reports the playhead in wall time", async () => {
    const video = new FakeVideo();
    const p = new LoopPlayback(video as unknown as HTMLVideoElement, "/archive/virus/lecture.mp4", info);
    expect(video.src).toBe("/archive/virus/lecture.mp4");
    const at = EPOCH + 2_449_408_000 + 61_500;
    const opened = p.open(at);
    expect(p.position()).toBeUndefined();
    video.loaded(1020.2);
    await opened;
    expect(video.currentTime).toBe(61.5);
    expect(p.position()).toBe(at);
    video.currentTime = 70;
    expect(p.position()).toBe(EPOCH + 2_449_408_000 + 70_000);
    p.close();
    expect(video.src).toBe("");
  });

  it("fails to open when the recording is missing", async () => {
    const video = new FakeVideo();
    const p = new LoopPlayback(video as unknown as HTMLVideoElement, "/archive/virus/lecture.mp4", info);
    const opened = p.open(EPOCH);
    video.dispatchEvent(new Event("error"));
    await expect(opened).rejects.toThrow();
    expect(p.error).toBeDefined();
  });

  it("holds still, silent, after the file ends, then plays the next loop on time", async () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    const video = new FakeVideo();
    const p = new LoopPlayback(video as unknown as HTMLVideoElement, "u", info, { now: () => now });
    video.loaded(1020.2);
    await p.open(loopWall(info, 5, 1_019_000));
    await video.play();
    video.end();
    expect(p.position()).toBe(loopWall(info, 5, 1_020_200));
    now += 2_000;
    expect(p.position()).toBe(loopWall(info, 5, 1_022_200));
    // A play() in the tail waits for the next loop.
    await video.play();
    expect(video.paused).toBe(true);
    now += 1_800;
    vi.advanceTimersByTime(3_800);
    expect(video.currentTime).toBe(0);
    expect(video.paused).toBe(false);
    expect(p.position()).toBe(loopWall(info, 6, 0));
  });

  it("seeks into the silent tail and stays paused when stopped there", () => {
    vi.useFakeTimers();
    const video = new FakeVideo();
    const p = new LoopPlayback(video as unknown as HTMLVideoElement, "u", info, { now: () => 0 });
    video.loaded(1020.2);
    p.seek(loopWall(info, 3, 1_022_000));
    expect(p.position()).toBe(loopWall(info, 3, 1_022_000));
    p.pause();
    vi.advanceTimersByTime(2_000);
    expect(video.currentTime).toBe(0);
    expect(video.paused).toBe(true);
    expect(p.position()).toBe(loopWall(info, 4, 0));
  });
});

describe("RoomMedia in a looped room", () => {
  it("is on air, and offers one loop back from now, with no playlist to read", () => {
    const transport = new FakeTransport();
    const now = EPOCH + 2_449_500_000;
    const fetchFn = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const media = new RoomMedia(transport as unknown as MoqTransport, "virus", { now: () => now, fetchFn });
    transport.emitJson(catalogPath("virus"), CATALOG_TRACK, {
      tracks: [],
      tt: { E: EPOCH, shift: { [String(teacherCatalog.clock.wall)]: 0 } },
    });
    expect(media.onAir()).toBeUndefined();
    transport.emitJson(teacherPath("virus"), HANG_CATALOG_TRACK, teacherCatalog);
    expect(media.onAir()).toBe(true);
    expect(media.liveEdge()).toBe(2_449_500_000);
    expect(media.available()).toEqual([{ start: 2_449_500_000 - 1_024_000, end: 2_449_500_000 }]);
    media.close();
  });
});

describe("RoomMedia: the HLS archive probe waits for the teacher catalog", () => {
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const probe = () => vi.fn(async (_url: string) => new Response("", { status: 404 }));
  const urls = (fetchFn: ReturnType<typeof probe>) => fetchFn.mock.calls.map((c) => String(c[0]));

  it("never asks a looped room for index.m3u8", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const fetchFn = probe();
    const media = new RoomMedia(transport as unknown as MoqTransport, "virus", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await flush();
    expect(fetchFn).not.toHaveBeenCalled();
    transport.emitJson(teacherPath("virus"), HANG_CATALOG_TRACK, teacherCatalog);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(urls(fetchFn).filter((u) => u.endsWith("index.m3u8"))).toEqual([]);
    media.close();
  });

  it("reads a live room's playlist once its catalog shows no loop", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const fetchFn = probe();
    const media = new RoomMedia(transport as unknown as MoqTransport, "lecture", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await flush();
    expect(fetchFn).not.toHaveBeenCalled();
    transport.emitJson(teacherPath("lecture"), HANG_CATALOG_TRACK, { clock: teacherCatalog.clock, audio: {} });
    await flush();
    expect(urls(fetchFn)).toEqual(["/archive/lecture/index.m3u8"]);
    media.close();
  });

  it("reads the playlist after a short wait when no teacher catalog comes (the speaker left)", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const fetchFn = probe();
    const media = new RoomMedia(transport as unknown as MoqTransport, "lecture", {
      fetchFn: fetchFn as unknown as typeof fetch,
      loopWaitMs: 3_000,
    });
    await vi.advanceTimersByTimeAsync(2_900);
    expect(fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(urls(fetchFn)).toEqual(["/archive/lecture/index.m3u8"]);
    media.close();
  });
});
