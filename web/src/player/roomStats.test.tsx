import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STATS_TRACK, statsPath } from "../contracts/names";
import type { RoomStats, TrackStats } from "../contracts/types";
import { FakeHistorySource } from "../playback/fakeSource";
import { RoomTracks } from "./StatsForNerds";

const ROOM = "talk1";
const PATH = statsPath(ROOM);
const json = (stats: RoomStats) => new TextEncoder().encode(JSON.stringify(stats));

const TRANSLATION: TrackStats = {
  namespace: "talk/talk1/agents/translate-tr",
  name: "items",
  kind: "translation",
  state: "on_demand",
  subscribers: 0,
  lang: "tr",
};
const SNAPSHOT: RoomStats = {
  at: 1_700_000_000_000,
  relay: true,
  listeners: 3,
  tracks: [
    { namespace: "talk/talk1/teacher", name: "audio", kind: "audio", state: "running", subscribers: 4 },
    { namespace: "talk/talk1/chat", name: "chat", kind: "chat", state: "running", subscribers: 2 },
    { namespace: "talk/talk1/agents/captions", name: "items", kind: "captions", state: "running", subscribers: 3 },
    TRANSLATION,
  ],
};

interface Shown {
  k: string;
  v: string;
}

/** Each row of the panel: what, and its numbers (the data the snapshot carries). */
const rows = (): Shown[] =>
  screen.getAllByRole("row").map((r) => ({
    k: r.querySelector("th")?.textContent ?? "",
    v: r.querySelector("td")?.textContent ?? "",
  }));
const row = (pick: (r: Shown) => boolean): Shown => rows().find(pick) ?? { k: "", v: "" };

function mount(source: FakeHistorySource) {
  return render(
    <table>
      <tbody>
        <RoomTracks source={source} room={ROOM} />
      </tbody>
    </table>,
  );
}

describe("the room's tracks in Stats for nerds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes while open, lists every broadcast with its subscribers and tracks, and unsubscribes when closed", () => {
    const source = new FakeHistorySource();
    source.announce(PATH);
    const view = mount(source);
    expect(source.subscriberCount(PATH, STATS_TRACK)).toBe(1);
    expect(rows()).toHaveLength(1); // waiting for the first snapshot

    act(() => source.publish(PATH, STATS_TRACK, 0, json(SNAPSHOT)));
    expect(rows()).toHaveLength(5); // the room, then one row per broadcast
    expect(row((r) => r.k === "room").v).toContain("3");
    const tr = row((r) => r.k.startsWith("agents/translate-tr"));
    expect(tr.k).toContain("0 subscribed");
    expect(tr.v).toContain("on demand");
    expect(row((r) => r.k.startsWith("teacher")).k).toContain("4 subscribed");

    act(() =>
      source.publish(PATH, STATS_TRACK, 1, json({ ...SNAPSHOT, tracks: [{ ...TRANSLATION, state: "running" }] })),
    );
    expect(rows()).toHaveLength(2); // the next snapshot replaces the last
    expect(row((r) => r.k.startsWith("agents/translate-tr")).v).toContain("running");

    view.unmount();
    expect(source.subscriberCount(PATH, STATS_TRACK)).toBe(0);
  });

  it("stops loading when the room service sends no stats for the room", async () => {
    mount(new FakeHistorySource());
    const before = rows();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(rows()).toHaveLength(1);
    expect(rows()).not.toEqual(before);
  });
});
