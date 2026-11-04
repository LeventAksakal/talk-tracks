// Paused means paused for the AI tracks too (owner QA, 11-04: "captions and translations still resume even if stream
// is paused"): while the viewer has paused, no caption or translation line appears and nothing is fetched, live or
// rewound; on play they pick up in sync with the playhead.

import { afterEach, describe, expect, it } from "vitest";
import { AiTracks } from "./aiTracks";
import { FakeHistorySource } from "./fakeSource";
import { FakeRoom, fakeTalk } from "./fixtures";
import { ITEMS_TRACK } from "./wire";

const ROOM = "lecture";
const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

let tracks: AiTracks | undefined;
afterEach(() => tracks?.close());

function setup(startMs: number) {
  const source = new FakeHistorySource();
  const room = new FakeRoom(source, ROOM, fakeTalk());
  room.start(startMs);
  tracks = new AiTracks(source, ROOM, { liveBack: 0 });
  return { source, room, tracks };
}

const lines = (t: AiTracks, id: string) =>
  (t.getSnapshot().tracks.find((x) => x.id === id)?.sliced?.lines ?? []).map((l) => `${l.id}:${l.text}`);

describe("Paused AI tracks", () => {
  it("live: no new caption or translation line arrives while paused, and they follow live again on play", async () => {
    const { source, room, tracks } = setup(20_000);
    tracks.setEnabled("captions/items", true);
    tracks.setEnabled("translate-tr/items", true);
    await settle();
    room.advanceTo(30_000);
    await settle();
    tracks.setPaused(true);
    const captions = lines(tracks, "captions/items");
    const turkish = lines(tracks, "translate-tr/items");
    const fetched = source.fetches.length;
    expect(source.subscriberCount(room.path("captions"), ITEMS_TRACK)).toBe(0);
    room.advanceTo(60_000);
    await settle();
    expect(lines(tracks, "captions/items")).toEqual(captions);
    expect(lines(tracks, "translate-tr/items")).toEqual(turkish);
    expect(source.fetches.length).toBe(fetched);

    tracks.setPaused(false);
    room.advanceTo(64_000);
    await settle();
    expect(source.subscriberCount(room.path("captions"), ITEMS_TRACK)).toBe(1);
    const newest = room.talk.captions.filter((l) => l.endMs + 400 <= 64_000).at(-1)!;
    expect(lines(tracks, "captions/items")).toContain(`${newest.id}:${newest.text}`);
  });

  it("rewound: a seek while paused fetches nothing until play, then the slices at the playhead", async () => {
    const { source, room, tracks } = setup(120_000);
    tracks.setEnabled("captions/items", true);
    await settle();
    tracks.setPaused(true);
    const fetched = source.fetches.length;
    tracks.seek(30_000);
    await settle();
    expect(source.fetches.length).toBe(fetched);
    tracks.setPaused(false);
    await settle();
    expect(source.fetchedGroups(room.path("captions"), ITEMS_TRACK).length).toBeGreaterThan(0);
    const spoken = room.talk.captions.find((l) => l.startMs <= 30_000 && l.endMs >= 28_000)!;
    expect(lines(tracks, "captions/items")).toContain(`${spoken.id}:${spoken.text}`);
  });
});
