import { describe, expect, it } from "vitest";
import { HANG_CATALOG_TRACK, teacherPath } from "../contracts/names";
import type { Mode } from "../playback/aiTracks";
import type { RoomMedia } from "../playback/media";
import { FakeTransport } from "../transport/fake";
import { hangHasScreen, ScreenMedia, screenShown, screenUrl } from "./screenMedia";
import { sourceShown, stageSources } from "./Stage";
import { DEFAULT_PREFS } from "./prefs";

const E = 1_800_000_000_000;
const ROOM = "physics-101";

/** The speaker's media as the screen reads it: its mode, the frame shown (room ms) and the room catalog's E. */
function fakeMedia(state: { mode: Mode; at: number | undefined }): RoomMedia {
  return {
    mode: () => state.mode,
    frameTime: () => state.at,
    status: () => "playing",
    catalog: () => ({ tt: { E } }),
  } as unknown as RoomMedia;
}

/** The archive's screen playlist: shared from room time 8 s to 16 s. */
const PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:7",
  "#EXT-X-TARGETDURATION:4",
  `#EXT-X-PROGRAM-DATE-TIME:${new Date(E + 8_000).toISOString()}`,
  "#EXTINF:4.000,",
  "r1/teacher/screen/000000.m4s",
  `#EXT-X-PROGRAM-DATE-TIME:${new Date(E + 12_000).toISOString()}`,
  "#EXTINF:4.000,",
  "r1/teacher/screen/000001.m4s",
  "#EXT-X-ENDLIST",
  "",
].join("\n");

const hang = (renditions: string[]) =>
  JSON.stringify({ video: { renditions: Object.fromEntries(renditions.map((r) => [r, { codec: "avc1" }])) } });

describe("the shared screen in the player", () => {
  it("is on the stage live exactly while the speaker's catalog names a screen", async () => {
    const transport = new FakeTransport();
    const state = { mode: "live" as Mode, at: undefined };
    const fetchFn = (async () => new Response("", { status: 404 })) as typeof fetch;
    const screen = new ScreenMedia(transport, ROOM, fakeMedia(state), { fetchFn, tickMs: 0 });
    expect(screen.shown()).toBe(false);

    transport.emit(teacherPath(ROOM), HANG_CATALOG_TRACK, hang(["video", "screen"]));
    expect(screen.shown()).toBe(true);
    transport.emit(teacherPath(ROOM), HANG_CATALOG_TRACK, hang(["video"]));
    expect(screen.shown()).toBe(false);
    screen.close();
  });

  it("replays in rewind where the archive holds the screen, and only there", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => (urls.push(url), new Response(PLAYLIST))) as unknown as typeof fetch;
    const state: { mode: Mode; at: number | undefined } = { mode: "rewound", at: 5_000 };
    const screen = new ScreenMedia(undefined, ROOM, fakeMedia(state), { fetchFn, tickMs: 0, archiveBase: "/archive" });
    await screen.refresh();
    expect(urls[0]).toBe(screenUrl(ROOM, "/archive"));
    expect(screen.ranges()).toEqual([{ start: 8_000, end: 16_000 }]);

    expect(screen.shown()).toBe(false); // before the share
    state.at = 10_000;
    expect(screen.shown()).toBe(true);
    state.at = 16_000;
    expect(screen.shown()).toBe(false); // after it
    screen.close();
  });

  it("reads a screen only from the screen rendition of the hang catalog", () => {
    expect(hangHasScreen(JSON.parse(hang(["video", "screen"])))).toBe(true);
    expect(hangHasScreen(JSON.parse(hang(["video"])))).toBe(false);
    expect(hangHasScreen(null)).toBe(false);
    expect(screenShown("live", true, [], undefined)).toBe(true);
    expect(screenShown("rewound", true, [], 1_000)).toBe(false); // live sharing says nothing about the past
  });

  it("takes the slides' place on the stage, the camera staying in the corner", () => {
    const all = ["camera", "slides", "screen"] as const;
    expect(stageSources([...all])).toEqual(["camera", "screen"]);
    expect(stageSources(["camera", "slides"])).toEqual(["camera", "slides"]);
    const pip = { ...DEFAULT_PREFS, layout: "pip" as const };
    expect(sourceShown("screen", pip, [...all])).toBe(true);
    expect(sourceShown("camera", pip, [...all])).toBe(true);
    expect(sourceShown("slides", pip, [...all])).toBe(false);
    // One at a time: the listener's "main picture" choice shows the screen while it is shared.
    const single = { ...DEFAULT_PREFS, layout: "single" as const, single: "slides" as const };
    expect(sourceShown("screen", single, [...all])).toBe(true);
    expect(sourceShown("camera", single, [...all])).toBe(false);
    expect(sourceShown("slides", single, ["camera", "slides"])).toBe(true);
  });
});
