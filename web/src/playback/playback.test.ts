import { afterEach, describe, expect, it } from "vitest";
import { ArchiveClient, archivedRanges, type RunIndex, segmentAt } from "./archive";
import { FakeHistorySource } from "./fakeSource";
import { FakeRoom } from "./fixtures";
import { ClockMedia } from "./media";
import { Playback } from "./playback";
import { formatClock } from "./timeline";

const ROOM = "lecture";
const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

let playback: Playback | undefined;
afterEach(() => playback?.close());

function setup(liveMs: number) {
  let wall = 1_000_000;
  const clock = { now: () => wall, advance: (ms: number) => (wall += ms) };
  const source = new FakeHistorySource();
  const room = new FakeRoom(source, ROOM);
  room.start(liveMs);
  const media = new ClockMedia({ now: clock.now, tickMs: 0 });
  media.setLiveEdge(liveMs);
  playback = new Playback(source, media, ROOM, { now: clock.now, liveBack: 0 });
  return { source, room, media, playback, clock };
}

describe("Playback: one clock", () => {
  it("seeking moves the media and every opted-in track to the same media time", async () => {
    const { playback } = setup(200_000);
    playback.tracks.setEnabled("captions/items", true);
    playback.tracks.setEnabled("describe/items", true);
    playback.seek(90_000);
    await settle();
    const v = playback.getSnapshot();
    expect(v.timeline).toMatchObject({ mode: "rewound", position: 90_000, liveEdge: 200_000, behindMs: 110_000 });
    expect(v.tracks).toMatchObject({ mode: "rewound", position: 90_000 });
    const captions = v.tracks.tracks.find((t) => t.kind === "captions")!.sliced!;
    expect(Math.max(...captions.lines.map((l) => l.startMs))).toBeLessThanOrEqual(90_000);
    expect(v.timeline.held.some((r) => r.start <= 90_000 && 90_000 < r.end)).toBe(true);
  });

  it("the tracks follow the media playhead as it plays", async () => {
    const { playback, media, clock } = setup(200_000);
    playback.tracks.setEnabled("captions/items", true);
    playback.seek(40_000);
    await settle();
    clock.advance(9_000);
    media.setLiveEdge(209_000);
    media.tick();
    await settle();
    expect(playback.getSnapshot().tracks.position).toBe(49_000);
    expect(playback.getSnapshot().timeline.position).toBe(49_000);
  });

  it("a seek at or past live is Go live", async () => {
    const { playback } = setup(100_000);
    playback.seek(150_000);
    expect(playback.getSnapshot().timeline.mode).toBe("live");
  });
});

describe("Playback: Go live and what you missed", () => {
  it("returning to live lists the chapters that started in the skipped range", async () => {
    const { playback } = setup(250_000);
    playback.tracks.setEnabled("chapters/outline", true);
    playback.tracks.setEnabled("captions/items", true);
    await settle();
    playback.seek(30_000);
    await settle();
    playback.goLive();
    await settle();
    const v = playback.getSnapshot();
    expect(v.timeline.mode).toBe("live");
    expect(v.missed).toMatchObject({ fromMs: 30_000, toMs: 250_000, reason: "rewound", outlineOn: true });
    expect(v.missed!.chapters.map((c) => c.start_ms)).toEqual([61_000, 121_000, 181_000, 241_000]);
  });

  it("loads the missed captions on request, one fetch per slice", async () => {
    const { playback, room, source } = setup(250_000);
    playback.tracks.setEnabled("captions/items", true);
    await settle();
    playback.seek(200_000);
    await settle();
    playback.goLive();
    const before = source.fetches.length;
    await playback.loadMissedTranscript();
    const v = playback.getSnapshot();
    // Lines begun in the range and heard of by live time (an interim version comes 1.8 s in).
    const expected = room.talk.captions.filter((l) => l.startMs >= 200_000 && l.startMs + 1_800 <= 250_000);
    expect(v.missed!.transcript!.map((l) => l.id)).toEqual(expected.map((l) => l.id));
    // Slices 50..62; 62 is held live, so twelve fetches.
    expect(source.fetches.length - before).toBe(12);
  });

  it("time away from a hidden tab counts as missed; a short absence does not", async () => {
    const { playback, media, clock } = setup(100_000);
    playback.tracks.setEnabled("chapters/outline", true);
    playback.setAway(true);
    clock.advance(10_000);
    playback.setAway(false);
    expect(playback.getSnapshot().missed).toBeUndefined();
    playback.setAway(true);
    clock.advance(90_000);
    media.setLiveEdge(200_000);
    playback.setAway(false);
    expect(playback.getSnapshot().missed).toMatchObject({ fromMs: 110_000, toMs: 200_000, reason: "away" });
  });

  it("a short rewind is not worth a summary", async () => {
    const { playback } = setup(100_000);
    playback.seek(95_000);
    playback.goLive();
    expect(playback.getSnapshot().missed).toBeUndefined();
  });
});

describe("archive index", () => {
  const run: RunIndex = {
    room: "live",
    run: "1761650000000",
    started_wall_ms: 0,
    last_wall_ms: 0,
    media_first_ms: 1_520,
    media_last_ms: 30_000,
    tracks: [
      {
        track: "audio",
        kind: "audio",
        codec: "opus",
        mime: 'audio/mp4; codecs="opus"',
        segments: [
          { n: 0, init: "init-0.mp4", start_ms: 1_520, end_ms: 7_540 },
          { n: 1, init: "init-0.mp4", start_ms: 7_540, end_ms: 13_560 },
          { n: 2, init: "init-2.mp4", start_ms: 20_000, end_ms: 26_000 },
        ],
      },
      { track: "video", kind: "video", codec: "avc1.64001f", mime: 'video/mp4; codecs="avc1.64001f"', segments: [] },
    ],
  };

  it("finds the segment holding a time, or the next one across a gap", () => {
    const s = run.tracks[0]!.segments;
    expect([0, 1_520, 7_539, 7_540, 15_000, 25_999, 26_000].map((ms) => segmentAt(s, ms))).toEqual([
      0, 0, 0, 1, 2, 2, -1,
    ]);
  });

  it("lists what can be played, gaps included", () => {
    expect(archivedRanges(run)).toEqual([
      { start: 1_520, end: 13_560 },
      { start: 20_000, end: 26_000 },
    ]);
  });

  it("names files as the archive lays them out", async () => {
    const asked: string[] = [];
    const client = new ArchiveClient("/archive/", async (url) => {
      asked.push(String(url));
      return String(url).endsWith("room.json")
        ? Response.json({ room: "live", runs: [{ run: "1" }, { run: run.run }] })
        : Response.json(run);
    });
    const current = (await client.currentRun("live"))!;
    expect(asked).toEqual(["/archive/live/room.json", `/archive/live/${run.run}/run.json`]);
    const audio = current.tracks[0]!;
    expect(client.segmentUrl(current, audio, audio.segments[1]!)).toBe(
      `/archive/live/${run.run}/teacher/audio/000001.m4s`,
    );
    expect(client.initUrl(current, audio, audio.segments[2]!)).toBe(
      `/archive/live/${run.run}/teacher/audio/init-2.mp4`,
    );
  });

  it("a room with nothing archived is undefined, not an error", async () => {
    const client = new ArchiveClient("/archive", async () => new Response("", { status: 404 }));
    expect(await client.currentRun("demo")).toBeUndefined();
  });
});

describe("formatClock", () => {
  it("formats media time", () => {
    expect([0, 61_000, 3_725_000].map(formatClock)).toEqual(["0:00", "1:01", "1:02:05"]);
  });
});
