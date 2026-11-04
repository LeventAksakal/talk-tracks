// A demo session (decision 0032) rewinds into its lecture file, archive/<room>/lecture.mp4. When the archive does not
// serve that file (it is a hard link made by hand on the VM; /watch/rsa had none), a rewind used to fall back to a
// silent clock: the captions moved on, with no sound and no picture. The session's recording room, <room>-recording,
// holds the same lecture as HLS: the rewind plays that instead, at the same lecture time.

import { describe, expect, it, vi } from "vitest";
import { CATALOG_TRACK, catalogPath, teacherPath } from "../contracts/names";
import { MOQ_EPOCH_UNIX_MS } from "../contracts/types";
import { FakeTransport } from "../transport/fake";
import type { MoqTransport } from "../transport/moq";
import type { ArchivePlayback } from "./hlsArchive";
import { RoomMedia } from "./media";
import { HANG_CATALOG_TRACK } from "./roomClock";

const EPOCH = Date.parse("2026-10-01T00:00:00Z");
/** The session's lecture 00:00 on the wall clock. */
const SESSION_ZERO = EPOCH + 5_000_000;
/** The recording room's lecture 00:00 on its own wall clock: its playlist's first PROGRAM-DATE-TIME. */
const RECORDING_ZERO = Date.parse("2026-10-30T07:52:56Z");
const clock = { wall: (SESSION_ZERO - MOQ_EPOCH_UNIX_MS) * 1000, timescale: 1_000_000 };
const teacherCatalog = { clock, audio: {}, talk_tracks: { session: "s1", duration_ms: 1_200_000 } };

const playlist = [
  "#EXTM3U",
  "#EXT-X-TARGETDURATION:4",
  `#EXT-X-PROGRAM-DATE-TIME:${new Date(RECORDING_ZERO).toISOString()}`,
  ...Array.from({ length: 300 }, (_, i) => `#EXTINF:4.000,\n${String(i).padStart(6, "0")}.m4s`),
  "#EXT-X-ENDLIST",
].join("\n");

/** The bits of a video element the room media uses. */
class FakeVideo extends EventTarget {
  currentTime = 0;
  duration = Number.NaN;
  readyState = 0;
  paused = true;
  ended = false;
  error: MediaError | null = null;
  preload = "";
  src = "";
  muted = false;
  playbackRate = 1;
  buffered = { length: 0, start: () => 0, end: () => 0 };
  plays = 0;
  play(): Promise<void> {
    this.plays++;
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  load(): void {}
  removeAttribute(): void {
    this.src = "";
  }
}

/** An HLS playback that sits where it was opened. */
function fakeHls(video: FakeVideo) {
  const opened: number[] = [];
  const playback: ArchivePlayback = {
    element: video as unknown as HTMLVideoElement,
    error: undefined,
    open: async (wall) => void opened.push(wall),
    seek: (wall) => void opened.push(wall),
    reload: () => {},
    position: () => opened.at(-1),
    buffered: () => [],
    pause: () => video.pause(),
    close: () => {},
  };
  return { playback, opened };
}

function sessionRoom(lectureFile: "missing" | "served") {
  const transport = new FakeTransport();
  const video = new FakeVideo();
  const hls = fakeHls(video);
  const urls: string[] = [];
  const fetchFn = vi.fn(async (url: string) => {
    urls.push(url);
    return url.endsWith("/rsa-recording/index.m3u8") ? new Response(playlist) : new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const openArchive = vi.fn(async () => hls.playback);
  const media = new RoomMedia(transport as unknown as MoqTransport, "rsa", {
    now: () => SESSION_ZERO + 900_000,
    fetchFn,
    openArchive,
  });
  transport.emitJson(teacherPath("rsa"), HANG_CATALOG_TRACK, teacherCatalog);
  transport.emitJson(catalogPath("rsa"), CATALOG_TRACK, {
    tracks: [],
    tt: { E: EPOCH, shift: { [String(clock.wall)]: 0 } },
  });
  media.attach({ canvas: {} as HTMLCanvasElement, video: video as unknown as HTMLVideoElement });
  /** The lecture file answers the element: a 404 is a format error, else its metadata. */
  const answer = () => {
    if (lectureFile === "missing") video.dispatchEvent(new Event("error"));
    else {
      video.duration = 1200;
      video.readyState = 1;
      video.dispatchEvent(new Event("loadedmetadata"));
    }
  };
  return { media, video, hls, urls, openArchive, answer };
}

describe("a demo session's rewind", () => {
  it("plays the recording room's HLS at the same lecture time when the lecture file is missing", async () => {
    const { media, video, hls, openArchive, answer } = sessionRoom("missing");
    const lectureMs = 300_000;
    const roomMs = SESSION_ZERO - EPOCH + lectureMs;
    media.seek(roomMs);
    await Promise.resolve();
    answer();
    await vi.waitFor(() => expect(media.status()).toBe("playing"));
    // hls.js starts loading at the seek point (lecture 300 s), not at 00:00.
    expect(openArchive).toHaveBeenCalledWith(video, "/archive/rsa-recording/index.m3u8", 300);
    expect(hls.opened).toEqual([RECORDING_ZERO + lectureMs]);
    // Sound and picture play, and the playhead reads in the session's room time.
    expect(video.plays).toBe(1);
    expect(media.position()).toBe(roomMs);
    expect(media.error()).toBeUndefined();

    // The next rewind goes straight to the recording room: no second try of the missing file.
    media.seek(roomMs - 60_000);
    await vi.waitFor(() => expect(hls.opened).toHaveLength(2));
    expect(hls.opened[1]).toBe(RECORDING_ZERO + lectureMs - 60_000);
    media.close();
  });

  it("plays the lecture file when the archive serves it", async () => {
    const { media, video, openArchive, urls, answer } = sessionRoom("served");
    media.seek(SESSION_ZERO - EPOCH + 300_000);
    await Promise.resolve();
    answer();
    await vi.waitFor(() => expect(media.status()).toBe("playing"));
    expect(video.currentTime).toBe(300);
    expect(openArchive).not.toHaveBeenCalled();
    expect(urls.some((u) => u.includes("-recording"))).toBe(false);
    media.close();
  });
});
