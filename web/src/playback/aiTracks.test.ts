import { afterEach, describe, expect, it } from "vitest";
import { AiTracks } from "./aiTracks";
import { FakeHistorySource } from "./fakeSource";
import { FakeRoom, fakeTalk } from "./fixtures";
import { sliceOf } from "./slices";
import { ITEMS_TRACK, OUTLINE_TRACK, PRIORITY } from "./wire";

const ROOM = "lecture";
const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

let tracks: AiTracks | undefined;
afterEach(() => tracks?.close());

function setup(startMs: number, options: ConstructorParameters<typeof FakeRoom>[3] = {}) {
  const source = new FakeHistorySource();
  const room = new FakeRoom(source, ROOM, fakeTalk(), options);
  room.start(startMs);
  tracks = new AiTracks(source, ROOM, { liveBack: 0 });
  return { source, room, tracks };
}

const view = (t: AiTracks, id: string) => t.getSnapshot().tracks.find((x) => x.id === id)!;

describe("AiTracks: opting in", () => {
  it("lists every announced track and subscribes to none until chosen", () => {
    const { source, room, tracks } = setup(60_000);
    expect(tracks.getSnapshot().tracks.map((t) => t.id)).toEqual([
      "captions/items",
      "translate-tr/items",
      "describe/items",
      "chapters/outline",
    ]);
    expect(source.subscriptions).toEqual([]);
    expect(source.subscriberCount(room.path("captions"), ITEMS_TRACK)).toBe(0);
  });

  it("switching a track on opens one subscription at its priority; off closes it", async () => {
    const { source, room, tracks } = setup(60_000);
    tracks.setEnabled("captions/items", true);
    tracks.setEnabled("translate-tr/items", true);
    expect(source.subscriberCount(room.path("captions"), ITEMS_TRACK)).toBe(1);
    expect(source.subscriptions.map((s) => s.priority)).toEqual([PRIORITY.captions, PRIORITY.translation]);

    tracks.setEnabled("captions/items", false);
    expect(source.subscriberCount(room.path("captions"), ITEMS_TRACK)).toBe(0);
    expect(source.subscriberCount(room.path("translate-tr"), ITEMS_TRACK)).toBe(1);
    await settle();
    expect(view(tracks, "captions/items").sliced).toBeUndefined();
  });

  it("switching a track off cancels its pending fetches", async () => {
    const { source, tracks } = setup(120_000);
    source.fetchDelayMs = 50;
    tracks.setEnabled("captions/items", true);
    tracks.seek(30_000);
    expect(view(tracks, "captions/items").loading).toBe(true);
    tracks.setEnabled("captions/items", false);
    expect(view(tracks, "captions/items").loading).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(view(tracks, "captions/items").held).toEqual([]);
  });
});

describe("AiTracks: live", () => {
  it("a late joiner shows the current slice's carry-in at once", async () => {
    const { tracks } = setup(61_000);
    tracks.setEnabled("captions/items", true);
    await settle();
    const v = view(tracks, "captions/items").sliced!;
    expect(v.loaded).toBe(true);
    expect(v.lines.length).toBeGreaterThanOrEqual(2);
    expect(v.lines.every((l) => l.final)).toBe(true);
  });

  it("follows the live edge, interim lines replaced by their final version", async () => {
    const { room, tracks } = setup(10_000);
    tracks.setEnabled("captions/items", true);
    await settle();
    room.advanceTo(40_000);
    await settle();
    const v = view(tracks, "captions/items").sliced!;
    const ids = v.lines.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    const lastFinal = room.talk.captions.filter((l) => l.endMs + 400 <= 40_000).at(-1)!;
    expect(v.lines.find((l) => l.id === lastFinal.id)).toMatchObject({ final: true, text: lastFinal.text });
    expect(tracks.getSnapshot().liveEdgeMs).toBe((sliceOf(40_000) + 1) * 4_000);
  });

  it("shows the newest outline snapshot, live and rewound", async () => {
    const { room, tracks } = setup(130_000);
    tracks.setEnabled("chapters/outline", true);
    await settle();
    expect(view(tracks, "chapters/outline").outline?.chapters.map((c) => c.title)).toEqual([
      "Introduction",
      "Erosion",
      "Deposition",
    ]);
    tracks.seek(5_000);
    room.advanceTo(190_000);
    await settle();
    expect(view(tracks, "chapters/outline").outline?.chapters).toHaveLength(4);
  });

  it("fetches a few slices behind the live edge for scrollback when asked to", async () => {
    const source = new FakeHistorySource();
    new FakeRoom(source, ROOM).start(61_000);
    tracks = new AiTracks(source, ROOM, { liveBack: 3 });
    tracks.setEnabled("captions/items", true);
    await settle();
    const k = sliceOf(61_000);
    expect(source.fetchedGroups(`talk/${ROOM}/agents/captions`, ITEMS_TRACK).sort()).toEqual([k - 3, k - 2, k - 1]);
  });
});

describe("AiTracks: rewind", () => {
  it("seeking fetches the slice at t first, then its neighbours, at the history priority", async () => {
    const { source, room, tracks } = setup(200_000);
    tracks.setEnabled("captions/items", true);
    await settle();
    tracks.seek(50_000);
    await settle();
    const k = sliceOf(50_000);
    const groups = source.fetchedGroups(room.path("captions"), ITEMS_TRACK);
    expect(groups.slice(0, 3)).toEqual([k, k + 1, k - 1]);
    expect(new Set(groups)).toEqual(new Set([k - 2, k - 1, k, k + 1, k + 2]));
    expect(source.fetches.every((f) => f.priority === PRIORITY.fetch)).toBe(true);
  });

  it("shows the state at t: lines up to t, the current line, the slide on screen", async () => {
    const { tracks, room } = setup(200_000);
    tracks.setEnabled("captions/items", true);
    tracks.setEnabled("describe/items", true);
    tracks.seek(70_000);
    await settle();
    const cap = view(tracks, "captions/items").sliced!;
    expect(cap.lines.every((l) => l.startMs <= 70_000)).toBe(true);
    const spoken = room.talk.captions.filter((l) => l.startMs <= 70_000 && 70_000 < l.endMs)[0]!;
    expect(cap.current?.id).toBe(spoken.id);
    expect(cap.lines.at(-1)?.id).toBe(spoken.id);
    // The slide shown at 62 s was described 2.5 s later; rewound, it shows from its own time.
    expect(view(tracks, "describe/items").sliced!.slide?.atMs).toBe(62_000);
  });

  it("merges a translation that landed in the next slice", async () => {
    const { tracks, room } = setup(200_000);
    tracks.setEnabled("translate-tr/items", true);
    // Line 8 ends at 40.6 s; its translation is produced at 42.4 s, in slice 10, not slice 9.
    const line = room.talk.translation.find((l) => sliceOf(l.endMs + 1_800) > sliceOf(l.startMs))!;
    tracks.seek(line.startMs + 100);
    await settle();
    expect(view(tracks, "translate-tr/items").sliced!.lines.map((l) => l.id)).toContain(line.id);
  });

  it("keeps at most two fetches in flight across tracks", async () => {
    const { source, tracks } = setup(200_000);
    source.fetchDelayMs = 5;
    for (const id of ["captions/items", "translate-tr/items", "describe/items"]) tracks.setEnabled(id, true);
    tracks.seek(100_000);
    await new Promise((r) => setTimeout(r, 200));
    expect(source.maxInFlight).toBe(2);
    expect(source.fetches.length).toBe(15);
    // Every track's current slice comes before any neighbour.
    expect(source.fetches.slice(0, 3).map((f) => f.group)).toEqual([25, 25, 25]);
  });

  it("prefetches as the playhead moves, and never past the live edge", async () => {
    const { source, room, tracks } = setup(60_000);
    tracks.setEnabled("captions/items", true);
    await settle();
    tracks.seek(40_000);
    await settle();
    expect(source.fetchedGroups(room.path("captions"), ITEMS_TRACK)).not.toContain(sliceOf(48_000) + 1);
    tracks.setPosition(48_000);
    await settle();
    expect(source.fetchedGroups(room.path("captions"), ITEMS_TRACK)).toContain(sliceOf(48_000) + 2);
    tracks.seek(58_000);
    await settle();
    const edge = sliceOf(60_000);
    expect(Math.max(...source.fetchedGroups(room.path("captions"), ITEMS_TRACK))).toBeLessThanOrEqual(edge);
  });

  it("drops fetches that a new seek no longer needs", async () => {
    const { source, tracks } = setup(300_000);
    source.fetchDelayMs = 20;
    tracks.setEnabled("captions/items", true);
    tracks.seek(40_000);
    tracks.seek(200_000);
    await new Promise((r) => setTimeout(r, 300));
    const held = view(tracks, "captions/items").held;
    expect(held.every((r) => r.start >= 180_000)).toBe(true);
  });

  it("a slice never produced reads as not loaded; a capped one says so", async () => {
    const { tracks } = setup(200_000, { neverProduced: { captions: [10] }, capped: { captions: [20] } });
    tracks.setEnabled("captions/items", true);
    tracks.seek(41_000);
    await settle();
    expect(view(tracks, "captions/items").sliced).toMatchObject({ loaded: false, capped: false });
    tracks.seek(81_000);
    await settle();
    expect(view(tracks, "captions/items").sliced).toMatchObject({ loaded: true, capped: true });
  });

  it("Go live drops what was fetched and keeps what arrived live", async () => {
    const { room, tracks } = setup(100_000);
    tracks.setEnabled("captions/items", true);
    await settle();
    tracks.seek(20_000);
    await settle();
    room.advanceTo(104_000);
    await settle();
    expect(view(tracks, "captions/items").held.some((r) => r.start < 40_000)).toBe(true);
    tracks.goLive();
    await settle();
    const v = tracks.getSnapshot();
    expect(v.mode).toBe("live");
    expect(view(tracks, "captions/items").held.every((r) => r.start >= 96_000)).toBe(true);
    expect(view(tracks, "captions/items").sliced!.lines.at(-1)!.startMs).toBeGreaterThan(90_000);
  });

  it("loads a transcript of a missed range without touching the playback state", async () => {
    const { room, tracks } = setup(200_000);
    tracks.setEnabled("captions/items", true);
    await settle();
    const lines = await tracks.transcript("captions/items", 60_000, 100_000);
    const expected = room.talk.captions.filter((l) => l.startMs >= 60_000 && l.startMs < 100_000).map((l) => l.id);
    expect(lines.map((l) => l.id)).toEqual(expected);
    expect(lines.every((l) => l.final)).toBe(true);
    expect(view(tracks, "captions/items").held.every((r) => r.start >= 196_000)).toBe(true);
  });
});

describe("AiTracks: outline track is never fetched", () => {
  it("opens only a live subscription", async () => {
    const { source, room, tracks } = setup(100_000);
    tracks.setEnabled("chapters/outline", true);
    tracks.seek(10_000);
    await settle();
    expect(source.fetchedGroups(room.path("chapters"), OUTLINE_TRACK)).toEqual([]);
    expect(source.subscriberCount(room.path("chapters"), OUTLINE_TRACK)).toBe(1);
  });
});
