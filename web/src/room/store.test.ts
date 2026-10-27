import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentPath, slidesPath, teacherPath } from "../contracts/names";
import { captions, envelope } from "../test/envelopes";
import { FakeTransport } from "../transport/fake";
import { guessFromName, RoomStore } from "./store";

const ROOM = "room-1";
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("RoomStore", () => {
  let now = 0;
  let transport: FakeTransport;
  let store: RoomStore;

  beforeEach(() => {
    now = 1_000;
    transport = new FakeTransport({ now: () => now });
    store = new RoomStore(transport, ROOM, { now: () => now, tickMs: 0 });
  });
  afterEach(() => store.close());

  const publish = (agent: string, instance: string, e: Parameters<typeof envelope>[0]) =>
    transport.emitJson(agentPath(ROOM, agent, instance), "state", envelope({ instance, ...e }));
  const agent = (name: string) => store.getSnapshot().agents.find((a) => a.name === name);

  it("discovers an agent, subscribes and shows its latest snapshot", () => {
    transport.announce(agentPath(ROOM, "captions", "1000"));
    expect(agent("captions")?.health).toBe("waiting");
    expect(transport.subscriberCount(agentPath(ROOM, "captions", "1000"), "state")).toBe(1);

    publish("captions", "1000", { seq: 0, state: captions(["Hello"], "wor") });
    const a = agent("captions")!;
    expect(a.health).toBe("live");
    expect(a.latest?.envelope.state).toMatchObject({ kind: "captions", interim: "wor" });
    expect(a.label).toBe("Captions");
  });

  it("follows the newest instance and ignores a lingering older one", () => {
    transport.announce(agentPath(ROOM, "captions", "1000"));
    publish("captions", "1000", { seq: 3, state: captions(["old"]) });
    transport.announce(agentPath(ROOM, "captions", "2000"));
    expect(agent("captions")?.instance).toBe("2000");
    expect(transport.subscriberCount(agentPath(ROOM, "captions", "1000"), "state")).toBe(0);
    expect(transport.subscriberCount(agentPath(ROOM, "captions", "2000"), "state")).toBe(1);

    publish("captions", "2000", { seq: 0, state: captions(["old", "new"]) });
    expect(agent("captions")?.latest?.envelope.instance).toBe("2000");

    // An older instance announced late (a slow relay) does not take over.
    transport.announce(agentPath(ROOM, "captions", "1500"));
    expect(agent("captions")?.instance).toBe("2000");
  });

  it("marks an agent stale after 6 s without an object, and live again on a heartbeat", () => {
    transport.announce(agentPath(ROOM, "captions", "1000"));
    publish("captions", "1000", { seq: 0 });
    now += 5_000;
    store.tick();
    expect(agent("captions")?.health).toBe("live");
    now += 1_500;
    store.tick();
    expect(agent("captions")?.health).toBe("stale");
    publish("captions", "1000", { seq: 0 }); // heartbeat: same seq
    expect(agent("captions")?.health).toBe("live");
    expect(agent("captions")?.historyLength).toBe(1);
  });

  it("keeps every state change with its arrival time, but not heartbeats", () => {
    transport.announce(agentPath(ROOM, "captions", "1000"));
    publish("captions", "1000", { seq: 0, state: captions(["a"]) });
    now += 100;
    publish("captions", "1000", { seq: 1, state: captions(["a", "b"]) });
    publish("captions", "1000", { seq: 1, state: captions(["a", "b"]) });
    const history = store.history("captions");
    expect(history.map((s) => s.envelope.seq)).toEqual([0, 1]);
    expect(history.map((s) => s.receivedAt)).toEqual([1_000, 1_100]);
  });

  it("thins old history instead of growing without bound", () => {
    store.close();
    store = new RoomStore(transport, ROOM, { now: () => now, tickMs: 0, maxHistory: 10 });
    transport.announce(agentPath(ROOM, "captions", "1000"));
    for (let seq = 0; seq < 40; seq++) publish("captions", "1000", { seq });
    const seqs = store.history("captions").map((s) => s.envelope.seq);
    expect(seqs.length).toBeLessThanOrEqual(10);
    expect(seqs[0]).toBe(0);
    expect(seqs[seqs.length - 1]).toBe(39);
  });

  it("drops objects that do not match the contract, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    transport.announce(agentPath(ROOM, "captions", "1000"));
    transport.emitJson(agentPath(ROOM, "captions", "1000"), "state", { hello: "world" });
    transport.emit(agentPath(ROOM, "captions", "1000"), "state", "not json");
    expect(agent("captions")?.latest).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("subscribes and drops a track on request", () => {
    const path = agentPath(ROOM, "translate-tr", "1000");
    transport.announce(path);
    expect(transport.subscriberCount(path, "state")).toBe(1);
    store.setSubscribed("translate-tr", false);
    expect(transport.subscriberCount(path, "state")).toBe(0);
    expect(agent("translate-tr")?.subscribed).toBe(false);
    store.setSubscribed("translate-tr", true);
    expect(transport.subscriberCount(path, "state")).toBe(1);
  });

  it("honours the default subscription policy", () => {
    store.close();
    store = new RoomStore(transport, ROOM, { tickMs: 0, subscribeByDefault: (a) => !a.startsWith("translate-") });
    transport.announce(agentPath(ROOM, "translate-ar", "1"));
    transport.announce(agentPath(ROOM, "captions", "1"));
    expect(agent("translate-ar")?.subscribed).toBe(false);
    expect(agent("captions")?.subscribed).toBe(true);
  });

  it("resubscribes when a path is withdrawn and announced again, and catches up on the latest group", async () => {
    const path = agentPath(ROOM, "captions", "1000");
    transport.announce(path);
    publish("captions", "1000", { seq: 0 });
    transport.withdraw(path);
    expect(transport.subscriberCount(path, "state")).toBe(0);
    expect(agent("captions")?.health).toBe("gone");

    publish("captions", "1000", { seq: 1, state: captions(["back"]) }); // published while nobody listened
    transport.announce(path);
    expect(transport.subscriberCount(path, "state")).toBe(1);
    await flush();
    expect(agent("captions")?.latest?.envelope.seq).toBe(1);
    expect(agent("captions")?.health).toBe("live");
  });

  it("adds up cost over every instance an agent has had", () => {
    transport.announce(agentPath(ROOM, "translate-tr", "1000"));
    publish("translate-tr", "1000", {
      seq: 0,
      agent: { name: "translate-tr", label: "TR", model: "m" },
      usage: { cost_usd: 0.5, requests: 2 },
      state: { kind: "translation", lang: "tr", lines: [] },
    });
    transport.announce(agentPath(ROOM, "translate-tr", "2000"));
    publish("translate-tr", "2000", {
      seq: 0,
      agent: { name: "translate-tr", label: "TR", model: "m" },
      usage: { cost_usd: 0.25, requests: 1 },
      state: { kind: "translation", lang: "tr", lines: [] },
    });
    expect(agent("translate-tr")?.costUsd).toBeCloseTo(0.75);
    expect(agent("translate-tr")?.requests).toBe(3);
  });

  it("tracks the speaker's broadcasts and orders agents by kind", () => {
    transport.announce(teacherPath(ROOM));
    transport.announce(slidesPath(ROOM));
    transport.announce(agentPath(ROOM, "chapters", "1"));
    transport.announce(agentPath(ROOM, "translate-tr", "1"));
    transport.announce(agentPath(ROOM, "captions", "1"));
    const view = store.getSnapshot();
    expect(view.teacherLive).toBe(true);
    expect(view.slidesLive).toBe(true);
    expect(view.agents.map((a) => a.name)).toEqual(["captions", "translate-tr", "chapters"]);
    transport.withdraw(teacherPath(ROOM));
    expect(store.getSnapshot().teacherLive).toBe(false);
  });

  it("notifies subscribers and returns a stable snapshot between changes", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    transport.announce(agentPath(ROOM, "captions", "1"));
    expect(listener).toHaveBeenCalled();
    expect(store.getSnapshot()).not.toBe(before);
  });

  it("reports the connection status", () => {
    transport.setStatus("disconnected");
    expect(store.getSnapshot().status).toBe("disconnected");
  });
});

describe("guessFromName", () => {
  it("reads kind and language from conventional agent names", () => {
    expect(guessFromName("translate-ar")).toMatchObject({ kind: "translation", lang: "ar" });
    expect(guessFromName("describe").kind).toBe("slides");
    expect(guessFromName("chapters").kind).toBe("outline");
    expect(guessFromName("mystery").kind).toBeUndefined();
  });
});
