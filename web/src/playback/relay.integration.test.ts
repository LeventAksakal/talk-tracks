// @vitest-environment node
//
// Against a real moq-relay, over its WebSocket path (Node has no WebTransport; Safari and iPhone use the
// same path). Skipped unless TT_RELAY_URL is set, e.g.
//   TT_RELAY_URL=http://localhost:4463/ TT_RELAY_ROOM=rwd npx vitest run src/playback/relay.integration.test.ts
// TT_RELAY_ROOM names a room whose agents publish the sliced contract (the demo looper does). The
// switch-off test needs no agents: it publishes a probe track itself and watches its demand.

import * as Moq from "@moq/net";
import { afterAll, describe, expect, it } from "vitest";
import { MoqTransport } from "../transport/moq";
import { AiTracks } from "./aiTracks";
import { MoqHistorySource } from "./moqSource";
import { sliceOf } from "./slices";
import { NotFound } from "./source";
import { agentPath, ITEMS_TRACK, parseObject } from "./wire";

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const RELAY = env.TT_RELAY_URL;
const ROOM = env.TT_RELAY_ROOM ?? "rwd";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | undefined, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error("timed out");
    await sleep(25);
  }
}

describe.skipIf(!RELAY)("against the relay", () => {
  const transports: MoqTransport[] = [];
  const connect = () => {
    const t = new MoqTransport({ url: new URL(RELAY!) });
    transports.push(t);
    return t;
  };
  afterAll(() => transports.forEach((t) => t.close()));

  it("switching a track off cancels the subscription at its publisher", async () => {
    // The publisher: a probe agent track, and whether anyone upstream asks for it.
    const pub = connect();
    const path = `talk/${ROOM}-probe/agents/probe`;
    const broadcast = pub.origin.createBroadcast(Moq.Path.from(path));
    const track = broadcast.createTrack(ITEMS_TRACK);
    broadcast.announce();
    let group = 0;
    const writer = setInterval(() => track.writeString(JSON.stringify({ g: group++ })), 200);
    try {
      const viewer = new MoqHistorySource(connect());
      await sleep(1_000);
      const got: number[] = [];
      const sub = viewer.subscribe(path, ITEMS_TRACK, (o) => got.push(o.group), { priority: 224 });
      await until(() => got.length > 2 || undefined, 8_000);
      expect(track.used.peek()).toBe(true);

      const t0 = performance.now();
      sub.close();
      await until(() => !track.used.peek() || undefined, 5_000);
      const ms = Math.round(performance.now() - t0);
      console.log(`publisher saw no subscriber ${ms} ms after switch-off`);
      expect(ms).toBeLessThan(2_000);

      // The same through the playback engine's toggle.
      const tracks = new AiTracks(viewer, `${ROOM}-probe`, { liveBack: 0 });
      await until(() => tracks.getSnapshot().tracks.find((t) => t.agent === "probe"), 5_000);
      tracks.setEnabled("probe/items", true);
      await until(() => track.used.peek() || undefined, 5_000);
      const t1 = performance.now();
      tracks.setEnabled("probe/items", false);
      await until(() => !track.used.peek() || undefined, 5_000);
      console.log(`engine switch-off: publisher idle after ${Math.round(performance.now() - t1)} ms`);
      tracks.close();

      // Today's viewer path (transport/moq.ts, used by the RoomStore) for comparison.
      const old = connect().subscribe(path, ITEMS_TRACK, () => {});
      await until(() => track.used.peek() || undefined, 5_000);
      const t2 = performance.now();
      old.close();
      await until(() => !track.used.peek() || undefined, 5_000);
      console.log(`MoqTransport.subscribe close: publisher idle after ${Math.round(performance.now() - t2)} ms`);
    } finally {
      clearInterval(writer);
      broadcast.close();
    }
  }, 30_000);

  it("live: a sliced track delivers carry-ins and items that parse", async () => {
    const source = new MoqHistorySource(connect());
    const objects: { group: number; kind: string }[] = [];
    const sub = source.subscribe(
      agentPath(ROOM, "captions"),
      ITEMS_TRACK,
      (o) => {
        const p = parseObject(o.payload, "captions", o.index);
        objects.push({ group: o.group, kind: p.ok ? p.value.kind : `bad: ${p.error}` });
      },
      { priority: 224 },
    );
    await until(() => objects.some((o) => o.kind === "carry") || undefined, 10_000);
    sub.close();
    expect(objects.every((o) => !o.kind.startsWith("bad"))).toBe(true);
    console.log("live groups", [...new Set(objects.map((o) => o.group))]);
  }, 20_000);

  it("FETCH: a past slice comes back whole, carry-in first; a future one is not found", async () => {
    const source = new MoqHistorySource(connect());
    let edge: number | undefined;
    const sub = source.subscribe(agentPath(ROOM, "captions"), ITEMS_TRACK, (o) => (edge = o.group), { priority: 224 });
    const live = await until(() => edge, 10_000);
    sub.close();
    for (const k of [live - 1, live - 5]) {
      const t0 = performance.now();
      const objects = await source.fetchGroup(agentPath(ROOM, "captions"), ITEMS_TRACK, k, { priority: 32 });
      const kinds = objects.map((o, i) => {
        const p = parseObject(o, "captions", i);
        return p.ok ? p.value.kind : "bad";
      });
      console.log(`fetch slice ${k}: ${objects.length} objects in ${Math.round(performance.now() - t0)} ms`);
      expect(kinds[0]).toBe("carry");
      expect(kinds.slice(1).every((k) => k === "items")).toBe(true);
    }
    await expect(
      source.fetchGroup(agentPath(ROOM, "captions"), ITEMS_TRACK, live + 50, { priority: 32 }),
    ).rejects.toBeInstanceOf(Error);
  }, 30_000);

  it("seek: the engine shows the state at a past media time", async () => {
    const tracks = new AiTracks(new MoqHistorySource(connect()), ROOM, { liveBack: 0 });
    await until(() => tracks.getSnapshot().tracks.find((t) => t.id === "captions/items"), 5_000);
    tracks.setEnabled("captions/items", true);
    const edgeMs = await until(() => tracks.getSnapshot().liveEdgeMs, 10_000);
    const at = edgeMs - 20_000;
    tracks.seek(at);
    const view = await until(() => {
      const v = tracks.getSnapshot().tracks.find((t) => t.id === "captions/items")?.sliced;
      return v?.loaded ? v : undefined;
    }, 10_000);
    console.log(`at slice ${sliceOf(at)}: ${view.lines.length} lines, last "${view.lines.at(-1)?.text}"`);
    expect(view.lines.every((l) => l.startMs <= at)).toBe(true);
    tracks.close();
  }, 30_000);

  it("a FETCH of a group nothing announces is NotFound", async () => {
    const source = new MoqHistorySource(connect());
    await expect(
      source.fetchGroup(`talk/${ROOM}/agents/nobody`, ITEMS_TRACK, 1, { priority: 32 }),
    ).rejects.toBeInstanceOf(NotFound);
  }, 15_000);
});
