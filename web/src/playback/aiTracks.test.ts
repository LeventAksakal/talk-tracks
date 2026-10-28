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
    await settle();
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

  it("marks a latest group older than the media's slice as stale", async () => {
    const { tracks } = setup(61_000);
    tracks.setEnabled("captions/items", true);
    await settle();
    tracks.setLiveEdge(62_000);
    expect(view(tracks, "captions/items").stale).toBe(false);
    // The speaker media is two slices on; the agent has published nothing since.
    tracks.setLiveEdge(70_000);
    expect(view(tracks, "captions/items").stale).toBe(true);
    tracks.seek(30_000);
    expect(view(tracks, "captions/items").stale).toBe(false);
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

describe("AiTracks: joining a publisher that starts subscriptions at the next group", () => {
  it("takes the slice in progress from live, and fetches it whole once the first live slice arrives", async () => {
    const source = new FakeHistorySource();
    source.startAtNextGroup = true;
    const room = new FakeRoom(source, ROOM);
    room.start(61_000);
    tracks = new AiTracks(source, ROOM, { liveBack: 0 });
    tracks.setLiveEdge(61_000);
    tracks.setEnabled("captions/items", true);
    await settle();
    const k = sliceOf(61_000);
    // The open slice is never fetched (moq-relay 0.17.8 may never answer it).
    expect(source.fetchedGroups(room.path("captions"), ITEMS_TRACK)).toEqual([]);
    room.advanceTo(65_500);
    await settle();
    expect(source.fetchedGroups(room.path("captions"), ITEMS_TRACK)).toEqual([k]);
    const lines = view(tracks, "captions/items").sliced!.lines;
    const spokenInK = room.talk.captions.filter((l) => sliceOf(l.endMs + 400) === k);
    for (const l of spokenInK) expect(lines.find((x) => x.id === l.id)).toMatchObject({ final: true });
  });
});

describe("AiTracks: FETCH on moq-relay 0.17.8", () => {
  it("never fetches the first live slice or a later one: those come from the subscription", async () => {
    const { source, room, tracks } = setup(100_000);
    tracks.setEnabled("captions/items", true);
    await settle();
    const firstLive = sliceOf(100_000);
    room.advanceTo(112_000);
    await settle();
    tracks.seek(firstLive * 4000 + 2000);
    await settle();
    const groups = source.fetchedGroups(room.path("captions"), ITEMS_TRACK);
    expect(groups.every((k) => k < firstLive)).toBe(true);
    expect(view(tracks, "captions/items").sliced!.loaded).toBe(true);
  });

  it("a FETCH with no answer becomes a hole after the timeout; the slices around it load", async () => {
    const source = new FakeHistorySource();
    const room = new FakeRoom(source, ROOM, fakeTalk());
    room.start(200_000);
    const k = sliceOf(50_000);
    // Another viewer's subscription began at slice k: the relay never answers a FETCH of it.
    source.hang(room.path("captions"), ITEMS_TRACK, k);
    tracks = new AiTracks(source, ROOM, { liveBack: 0, fetchTimeoutMs: 300, retryMissingMs: 60_000 });
    tracks.setEnabled("captions/items", true);
    await settle();
    tracks.seek(50_000);
    await settle();
    expect(view(tracks, "captions/items").loading).toBe(true);
    await new Promise((r) => setTimeout(r, 350));
    await settle();
    const v = view(tracks, "captions/items");
    expect(v.loading).toBe(false);
    expect(v.held.filter((r) => r.start < 100_000)).toEqual([
      { start: (k - 1) * 4000, end: k * 4000 },
      { start: (k + 1) * 4000, end: (k + 2) * 4000 },
    ]);
    // Not asked again while the hole is fresh.
    tracks.setPosition(50_500);
    await settle();
    expect(source.fetchedGroups(room.path("captions"), ITEMS_TRACK).filter((g) => g === k)).toHaveLength(1);
  });
});

describe("AiTracks: rewind", () => {
  it("seeking to t fetches slices t/S-1 to (t+L)/S, the slice at t first, at the history priority", async () => {
    const { source, room, tracks } = setup(200_000);
    tracks.setEnabled("captions/items", true);
    await settle();
    const before = source.fetches.length;
    tracks.seek(50_000);
    await settle();
    const k = sliceOf(50_000);
    const groups = source.fetchedGroups(room.path("captions"), ITEMS_TRACK).slice(before);
    // L = 4 s by default: 50 s + 4 s ends in slice k+1.
    expect(groups).toEqual([k, k - 1, k + 1]);
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

  it("fetches further ahead for a track that publishes late (L from the catalog)", async () => {
    const source = new FakeHistorySource();
    const room = new FakeRoom(source, ROOM, fakeTalk());
    room.start(200_000);
    tracks = new AiTracks(source, ROOM, {
      liveBack: 0,
      latenessMs: (_path, track) => (track === ITEMS_TRACK ? 10_000 : 4_000),
    });
    tracks.setEnabled("captions/items", true);
    await settle();
    const before = source.fetches.length;
    tracks.seek(50_000);
    await settle();
    const k = sliceOf(50_000);
    expect(source.fetchedGroups(room.path("captions"), ITEMS_TRACK).slice(before)).toEqual([
      k,
      k - 1,
      k + 1,
      k + 2,
      k + 3,
    ]);
  });

  it("keeps at most two fetches in flight across tracks", async () => {
    const { source, tracks } = setup(200_000);
    source.fetchDelayMs = 5;
    for (const id of ["captions/items", "translate-tr/items", "describe/items"]) tracks.setEnabled(id, true);
    tracks.seek(100_000);
    await new Promise((r) => setTimeout(r, 200));
    expect(source.maxInFlight).toBe(2);
    expect(source.fetches.length).toBe(9);
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
    // What arrived live, and the slice before it (the one in progress at join).
    expect(view(tracks, "captions/items").held.every((r) => r.start >= 88_000)).toBe(true);
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
