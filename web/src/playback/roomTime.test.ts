import { describe, expect, it } from "vitest";
import { archivedWallRanges, archiveState, firstVariant, hlsUrl, playlistWallRanges, readPlaylist } from "./hlsArchive";
import { MOQ_EPOCH_UNIX_MS } from "../contracts/types";
import { DEFAULT_LATENESS_MS, latenessOf, type RoomCatalog, statusOf } from "./roomCatalog";
import { hangClockOf, hangClockOfPayload, roomTimeOf, shiftOf, wallClockMs } from "./roomClock";
import { SliceLog } from "./sliceLog";
import type { LineItem } from "./wire";

describe("room clock", () => {
  it("maps a media timestamp to wall time through the hang catalog clock", () => {
    // PTS zero at 2026-10-28T10:00:00Z, in µs since the moq epoch.
    const zero = Date.parse("2026-10-28T10:00:00Z");
    const clock = hangClockOf({ clock: { wall: (zero - MOQ_EPOCH_UNIX_MS) * 1000 } })!;
    expect(clock.timescale).toBe(1_000_000);
    expect(wallClockMs(clock, 1_500)).toBe(zero + 1_500);
    // Room time = wall − E, plus the shift for a slow device.
    expect(roomTimeOf(zero + 1_500, zero - 60_000)).toBe(61_500);
    expect(roomTimeOf(zero + 1_500, zero - 60_000, 250)).toBe(61_750);
  });

  it("finds no clock when the publisher left it out", () => {
    expect(hangClockOf({ audio: {} })).toBeUndefined();
    expect(hangClockOf({ clock: { wall: -1 } })).toBeUndefined();
    expect(hangClockOfPayload(new TextEncoder().encode("not json"))).toBeUndefined();
    expect(hangClockOfPayload(new TextEncoder().encode('{"clock":{"wall":5,"timescale":1000}}'))).toEqual({
      wall: 5,
      timescale: 1000,
    });
  });
});

describe("room catalog", () => {
  const status = { status: "live" as const, producing: true, fetches_served: 3, backfills: 1, spend_usd: 0.02 };
  const catalog: RoomCatalog = {
    tracks: [
      {
        namespace: "talk/r/agents/captions",
        name: "items",
        packaging: "eventtimeline",
        tt: { latenessMs: 6000, cost: "paid" },
      },
      { namespace: "talk/r/agents/describe", name: "items", packaging: "eventtimeline" },
    ],
    tt: {
      E: 1_700_000_000_000,
      shift: { "123": 4000 },
      status: {
        captions: { ...status, updated_ms: 1_700_000_100_000 },
        describe: { ...status, updated_ms: 1_700_000_000_000 },
      },
    },
  };

  it("gives each track's L, 4 s when it declares none", () => {
    expect(latenessOf(catalog, "talk/r/agents/captions", "items")).toBe(6000);
    expect(latenessOf(catalog, "talk/r/agents/describe", "items")).toBe(DEFAULT_LATENESS_MS);
    expect(latenessOf(undefined, "x", "y")).toBe(DEFAULT_LATENESS_MS);
  });

  it("reads an agent's status, idle once its entry is older than 15 s", () => {
    const now = 1_700_000_105_000;
    expect(statusOf(catalog, "captions", now)).toMatchObject({ status: "live", fetches_served: 3, spend_usd: 0.02 });
    expect(statusOf(catalog, "describe", now)).toMatchObject({ status: "idle", producing: false });
    expect(statusOf(catalog, "chapters", now)).toBeUndefined();
  });

  it("finds the shift for a broadcast by its clock.wall", () => {
    expect(shiftOf(catalog.tt.shift, { wall: 123, timescale: 1e6 })).toBe(4000);
    expect(shiftOf(catalog.tt.shift, { wall: 456, timescale: 1e6 })).toBe(0);
  });
});

describe("archive playlist", () => {
  const media = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    '#EXT-X-MAP:URI="init.mp4"',
    "#EXT-X-PROGRAM-DATE-TIME:2026-10-28T10:00:00.000Z",
    "#EXTINF:2.0,",
    "s0.m4s",
    "#EXTINF:2.0,",
    "s1.m4s",
    "#EXT-X-GAP",
    "#EXTINF:2.0,",
    "gap.m4s",
    "#EXT-X-DISCONTINUITY",
    "#EXT-X-PROGRAM-DATE-TIME:2026-10-28T10:01:00.000Z",
    "#EXTINF:2.0,",
    "s2.m4s",
  ].join("\n");
  const t0 = Date.parse("2026-10-28T10:00:00Z");

  it("turns PROGRAM-DATE-TIME and EXTINF into wall ranges, minus gaps", () => {
    expect(playlistWallRanges(media)).toEqual([
      { start: t0, end: t0 + 4_000 },
      { start: t0 + 60_000, end: t0 + 62_000 },
    ]);
  });

  it("reads EXT-X-ENDLIST as the speaker having left", () => {
    expect(readPlaylist(media).ended).toBe(false);
    expect(readPlaylist(`${media}\n#EXT-X-ENDLIST\n`).ended).toBe(true);
  });

  it("follows an audio-only multivariant playlist the same way", async () => {
    const top = ["#EXTM3U", '#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="opus"', "audio.m3u8"].join("\n");
    const files: Record<string, string> = {
      "/archive/a/index.m3u8": top,
      [new URL("/archive/a/audio.m3u8", location.href).href]: `${media}\n#EXT-X-ENDLIST\n`,
    };
    const fetchFn = (async (u: string) =>
      files[u] === undefined ? new Response("", { status: 404 }) : new Response(files[u])) as unknown as typeof fetch;
    expect(await archiveState("/archive/a/index.m3u8", fetchFn)).toMatchObject({ ended: true });
    expect(await archiveState("/archive/none/index.m3u8", fetchFn)).toBeUndefined();
  });

  it("follows a multivariant playlist to its first variant", async () => {
    const top = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000\nlow/index.m3u8\n";
    expect(firstVariant(top)).toBe("low/index.m3u8");
    expect(firstVariant(media)).toBeUndefined();
    const url = hlsUrl("r");
    expect(url).toBe("/archive/r/index.m3u8");
    const files: Record<string, string> = {
      [url]: top,
      [new URL("/archive/r/low/index.m3u8", location.href).href]: media,
    };
    const fetchFn = (async (u: string) =>
      files[u] === undefined ? new Response("", { status: 404 }) : new Response(files[u])) as unknown as typeof fetch;
    expect(await archivedWallRanges(url, fetchFn)).toHaveLength(2);
    expect(await archivedWallRanges("/archive/none/index.m3u8", fetchFn)).toEqual([]);
  });
});

describe("cue revisions", () => {
  const cue = (rev: number, text: string, final = false): LineItem => ({
    type: "line",
    id: "4",
    startMs: 1_000,
    endMs: 2_000,
    text,
    final,
    rev,
  });

  it("keeps the highest rev, whatever order the records arrive in", () => {
    const log = new SliceLog();
    log.addLive(0, undefined, [cue(2, "two")]);
    log.addLive(0, undefined, [cue(1, "one")]);
    log.addLive(0, undefined, [cue(3, "three", true)]);
    log.addLive(0, undefined, [cue(2, "two again")]);
    expect(log.view(undefined).lines.map((l) => l.text)).toEqual(["three"]);
  });
});
