import { describe, expect, it } from "vitest";
import type { Author, CommentRecord } from "../contracts/types";
import { IDENTITY_KEY, RoomServiceClient, type WebSocketLike, WriteError } from "./client";
import { FakeRoomService } from "./fake";
import { threadsAt } from "./threads";
import { AnnotationWriter, BATCH_MS } from "./writer";

/** A socket the test plays the room service on: what the client sent, and a way to answer. */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  answer(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    items,
  };
}

function connect(options: { token?: string; storage?: ReturnType<typeof memoryStorage> } = {}) {
  const sockets: FakeSocket[] = [];
  const storage = options.storage ?? memoryStorage();
  const client = new RoomServiceClient("ws://service/api/", "physics-101", {
    comments: true,
    storage,
    token: options.token,
    socket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    retryMs: 1,
  });
  return { client, sockets, storage, socket: () => sockets.at(-1)! };
}

const ADA: Author = { id: "u1", name: "Ada" };
const SPEAKER: Author = { id: "speaker", name: "Dr. Lee", speaker: true };
const comment = (m: number, id: string, text: string, by: Author, extra: object = {}): CommentRecord => ({
  m,
  data: { kind: "comment", id, at: m, text, by, anchor: { deck: 0, index: 2 }, ...extra },
});
const reply = (m: number, id: string, to: string, text: string, by: Author): CommentRecord => ({
  m,
  data: { kind: "reply", id, to, at: m, text, by },
});

describe("the room service client", () => {
  it("says hello with the identity this browser kept, and keeps the one it is given", () => {
    const storage = memoryStorage({ [IDENTITY_KEY]: JSON.stringify({ id: "u9", key: "k9", name: "Ada" }) });
    const { client, socket } = connect({ storage });
    expect(socket().url).toBe("ws://service/api/rooms/physics-101");
    socket().open();
    expect(socket().sent[0]).toEqual({ type: "hello", name: "Ada", id: "u9", key: "k9", comments: true });

    socket().answer({ type: "welcome", id: "u2", key: "k2", name: "Ada", speaker: false, now: 41_000 });
    expect(client.status()).toBe("open");
    expect(client.me()).toEqual({ id: "u2", name: "Ada", speaker: false });
    expect(JSON.parse(storage.items.get(IDENTITY_KEY)!)).toMatchObject({ id: "u2", key: "k2", name: "Ada" });
    expect(client.now()).toBeGreaterThanOrEqual(41_000);
  });

  it("as the speaker, proves the session with the relay token and keeps no listener identity", () => {
    const { socket, storage } = connect({ token: "jwt" });
    socket().open();
    expect(socket().sent[0]).toMatchObject({ type: "hello", token: "jwt", name: "Speaker" });
    expect(socket().sent[0]).not.toHaveProperty("id");
    socket().answer({ type: "welcome", id: "speaker", name: "Speaker", speaker: true, now: 0 });
    expect(storage.items.has(IDENTITY_KEY)).toBe(false);
  });

  it("answers a write with its ack, or the refusal's code", async () => {
    const { client, socket } = connect();
    socket().open();
    socket().answer({ type: "welcome", id: "u2", key: "k2", name: "Ada", speaker: false, now: 0 });
    const posted = client.write("comments", { kind: "comment", text: "Why?", anchor: { deck: 0, index: 1 } }, 9_000);
    const sent = socket().sent.at(-1)!;
    expect(sent).toMatchObject({ type: "write", track: "comments", at: 9_000 });
    socket().answer({ type: "ack", seq: sent.seq, m: 12_000, id: "c1" });
    await expect(posted).resolves.toEqual({ m: 12_000, id: "c1" });

    const erased = client.write("ink", { kind: "erase", strokes: ["u3:x"] });
    socket().answer({ type: "error", seq: socket().sent.at(-1)!.seq, code: "forbidden", message: "Not yours" });
    await expect(erased).rejects.toMatchObject({ code: "forbidden" });
  });

  it("needs a display name before writing, and sends one once chosen", async () => {
    const { client, socket } = connect();
    socket().open();
    socket().answer({ type: "welcome", id: "u2", key: "k2", name: null, speaker: false, now: 0 });
    await expect(client.write("marks", { kind: "clear", deck: 0, index: 0 })).rejects.toMatchObject({ code: "name" });
    client.setName("  Ada ");
    expect(socket().sent.at(-1)).toEqual({ type: "name", name: "Ada" });
    expect(client.me()?.name).toBe("Ada");
  });

  it("keeps the room's threads: the snapshot, then every pushed record, hidden ones left out", () => {
    const { client, socket } = connect();
    socket().open();
    socket().answer({ type: "welcome", id: "u2", key: "k2", name: "Ada", speaker: false, now: 0 });
    socket().answer({ type: "threads", records: [comment(1_000, "c1", "Why?", ADA)] });
    socket().answer({ type: "comment", record: reply(2_000, "c2", "c1", "Because", SPEAKER) });
    expect(client.threads().map((r) => r.data.kind)).toEqual(["comment", "reply"]);
    socket().answer({ type: "comment", record: { m: 3_000, data: { kind: "hide", id: "c1", by: SPEAKER } } });
    expect(client.threads()).toEqual([]);
  });

  it("waits and tries again while the room service does not hold the room; writes meanwhile fail", async () => {
    const { client, sockets, socket } = connect();
    socket().open();
    socket().answer({ type: "error", code: "no-room", message: "not yet" });
    expect(client.status()).toBe("waiting");
    await expect(client.write("ink", { kind: "clear", deck: 0, index: 0 })).rejects.toBeInstanceOf(WriteError);
    await new Promise((r) => setTimeout(r, 10));
    expect(sockets.length).toBeGreaterThan(1);
    client.close();
  });
});

describe("a listener's annotations as writes", () => {
  const on = { kind: "show" as const, deck: 0, index: 3 };

  function writer() {
    const service = new FakeRoomService({ me: { id: "u7", name: "Ada", speaker: false } });
    let clock = 0;
    const errors: WriteError[] = [];
    const w = new AnnotationWriter(
      service,
      (e) => errors.push(e),
      () => clock,
    );
    return { service, w, errors, tick: (ms: number) => (clock += ms) };
  }

  it("sends a stroke as begin, points batched every 50 ms, and end, on its own id, without `by`", () => {
    const { service, w, tick } = writer();
    const stroke = w.begin(on, "pen", "#e5383b", [0.1, 0.2])!;
    expect(stroke.stroke.startsWith("u7:")).toBe(true);
    w.move([0.2, 0.2]);
    w.move([0.3, 0.25]);
    tick(BATCH_MS);
    w.move([0.4, 0.3]);
    w.move([0.5, 0.3]);
    w.end();
    const kinds = service.writes.map((x) => [x.track, x.data.kind, (x.data.points as unknown[] | undefined)?.length]);
    expect(kinds).toEqual([
      ["ink", "begin", 1],
      ["ink", "points", 3],
      ["ink", "points", 1],
      ["ink", "end", undefined],
    ]);
    expect(service.writes.every((x) => !("by" in x.data))).toBe(true);
    expect(service.writes[0]!.data).toMatchObject({ stroke: stroke.stroke, deck: 0, index: 3, tool: "pen" });
  });

  it("marks text whole, and erases, unmarks and clears only by naming what to remove", () => {
    const { service, w } = writer();
    const id = w.mark(on, "underline", "#2f6bff", [{ run: "t1", start: 2 }])!;
    w.erase(["u7:a"]);
    w.unmark([id]);
    w.clear(on);
    expect(service.writes.map((x) => `${x.track}:${String(x.data.kind)}`)).toEqual([
      "marks:mark",
      "ink:erase",
      "marks:unmark",
      "ink:clear",
      "marks:clear",
    ]);
    expect(service.writes[0]!.data).toMatchObject({ id, style: "underline", span: [{ run: "t1", start: 2 }] });
  });

  it("writes nothing and reports why while there is no display name", async () => {
    const service = new FakeRoomService({ me: { id: "u7", name: null, speaker: false } });
    const w = new AnnotationWriter(service, () => {});
    expect(w.begin(on, "pen", "#000", [0, 0])).toBeUndefined();
    expect(service.writes).toEqual([]);
  });
});

describe("the threads at the playhead", () => {
  const records: CommentRecord[] = [
    comment(10_000, "c1", "What is a capsid?", ADA, { question: true }),
    reply(20_000, "c2", "c1", "Same question", { id: "u3", name: "Bo" }),
    reply(30_000, "c3", "c1", "The protein shell", SPEAKER),
    comment(40_000, "c4", "Nice diagram", { id: "u3", name: "Bo" }, { anchor: { deck: 0, index: 5 } }),
  ];

  it("puts the speaker's reply first under a question", () => {
    const [newest, oldest] = threadsAt(records);
    expect(newest!.comment.id).toBe("c4");
    expect(oldest!.replies.map((r) => r.id)).toEqual(["c3", "c2"]);
  });

  it("in a replay shows what had been said by then and counts the replies that came later", () => {
    const threads = threadsAt(records, { t: 25_000 });
    expect(threads.map((t) => t.comment.id)).toEqual(["c1"]);
    expect(threads[0]!.replies.map((r) => r.id)).toEqual(["c2"]);
    expect(threads[0]!.later).toBe(1);
  });

  it("filters questions and this slide, and searches every reply too", () => {
    expect(threadsAt(records, { filter: "questions" }).map((t) => t.comment.id)).toEqual(["c1"]);
    const slide = { kind: "show" as const, deck: 0, index: 5 };
    expect(threadsAt(records, { filter: "slide", slide }).map((t) => t.comment.id)).toEqual(["c4"]);
    expect(threadsAt(records, { search: "protein" }).map((t) => t.comment.id)).toEqual(["c1"]);
    expect(threadsAt(records, { search: "bo" }).map((t) => t.comment.id)).toEqual(["c4", "c1"]);
  });
});
