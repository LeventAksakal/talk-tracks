// Paused means paused for the AI tracks too (owner QA, 11-04: "captions and translations still resume even if stream
// is paused"): while the viewer has paused, no caption or translation line appears and nothing is fetched, live or
// rewound; on play they pick up in sync with the playhead.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cuesAt, subtitleTime } from "../player/subtitles";
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

  // Smoke check 11-04: paused on the virus recording, a seek to 8:30 left the opening lines from 0:00 on screen.
  it("rewound: a seek while paused never leaves the old line up; held text shows at once, nothing is fetched", async () => {
    const { source, room, tracks } = setup(300_000);
    tracks.setEnabled("captions/items", true);
    await settle();
    tracks.seek(250_000);
    await settle();
    tracks.setPaused(true);
    const fetched = source.fetches.length;
    // The subtitles read the frame clock, which holds at the playhead while paused rewound and follows a seek.
    const cue = (t: number | undefined) =>
      cuesAt(tracks.getSnapshot().tracks.find((x) => x.id === "captions/items")!.sliced!.lines, t, false, 2).map(
        (l) => l.id,
      );
    const at = (t: number) => subtitleTime(t, { t: 250_000, live: false });
    const said = (t: number) => room.talk.captions.filter((l) => l.startMs <= t && t < l.endMs).map((l) => l.id);
    const old = said(250_000)[0]!;
    expect(cue(at(250_000))).toContain(old);

    tracks.seek(60_000); // far, not held
    await settle();
    expect(cue(at(60_000))).not.toContain(old);
    expect(cue(at(60_000))).toEqual([]);

    tracks.seek(251_000); // into held text
    await settle();
    expect(cue(at(251_000))).toEqual(expect.arrayContaining(said(251_000)));
    expect(source.fetches.length).toBe(fetched);

    tracks.seek(60_000);
    tracks.setPaused(false);
    await settle();
    expect(source.fetches.length).toBeGreaterThan(fetched);
    expect(cue(60_000)).toEqual(expect.arrayContaining(said(60_000)));
  });

  it("recording: paused, a seek shows the line from the whole transcript already read, with no read or fetch", async () => {
    const relay = new FakeHistorySource();
    const room = new FakeRoom(relay, ROOM, fakeTalk(600_000));
    room.start(600_000);
    const archive = vi.fn((path: string, track: string, group: number, signal: AbortSignal) =>
      relay.fetchGroup(path, track, group, { priority: 0, signal }).catch(() => undefined),
    );
    tracks = new AiTracks(relay, ROOM, { liveBack: 0, archive });
    tracks.setLiveEdge(600_000);
    tracks.setEnabled("translate-tr/items", true);
    tracks.seek(2_000);
    await vi.waitFor(() => expect(archive.mock.calls.length).toBeGreaterThanOrEqual(150));
    await settle(50);
    tracks.setPaused(true);
    const reads = archive.mock.calls.length;
    const fetched = relay.fetches.length;
    const line = room.talk.translation.find((l) => l.startMs >= 510_000)!; // about 8:30
    const t = line.startMs + 500;
    tracks.seek(t);
    await settle();
    const shown = cuesAt(
      tracks.getSnapshot().tracks.find((x) => x.id === "translate-tr/items")!.sliced!.lines,
      subtitleTime(t, { t: 2_000, live: false }),
      false,
      2,
    );
    expect(shown.map((l) => l.id)).toContain(line.id);
    expect(shown.every((l) => l.startMs > 500_000)).toBe(true);
    expect(archive.mock.calls.length).toBe(reads);
    expect(relay.fetches.length).toBe(fetched);
  });
});
