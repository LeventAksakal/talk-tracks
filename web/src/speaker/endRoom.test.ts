import { describe, expect, it } from "vitest";
import type { WebSocketLike } from "../annotate/client";
import { endRoom } from "./endRoom";

/** A room service that answers hello with welcome (or an error) and end with ack. */
function service(answer: { hello: object; end?: object }) {
  const sent: object[] = [];
  let url = "";
  let closed = false;
  const socket = (u: string): WebSocketLike => {
    url = u;
    const ws: WebSocketLike = {
      readyState: 1,
      send(data) {
        const msg = JSON.parse(data) as { type: string };
        sent.push(msg);
        const reply = msg.type === "hello" ? answer.hello : answer.end;
        if (reply) queueMicrotask(() => ws.onmessage?.({ data: JSON.stringify(reply) }));
      },
      close() {
        closed = true;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    queueMicrotask(() => ws.onopen?.({}));
    return ws;
  };
  return { socket, sent, url: () => url, closed: () => closed };
}

describe("ending the talk at the room service", () => {
  it("says end as the speaker, with the relay token, and resolves once acknowledged", async () => {
    const s = service({
      hello: { type: "welcome", id: "speaker", speaker: true },
      end: { type: "ack", seq: 1, m: 61_000 },
    });
    expect(await endRoom("physics-101", "tok", { base: "ws://svc/api/", socket: s.socket })).toBe(true);
    expect(s.url()).toBe("ws://svc/api/rooms/physics-101");
    expect(s.sent).toEqual([
      { type: "hello", token: "tok" },
      { type: "end", seq: 1 },
    ]);
    expect(s.closed()).toBe(true);
  });

  it("resolves false when the link is refused or nobody answers, and never rejects", async () => {
    const refused = service({ hello: { type: "error", code: "forbidden", message: "no" } });
    expect(await endRoom("physics-101", "bad", { base: "ws://svc/api/", socket: refused.socket })).toBe(false);
    expect(refused.sent).toEqual([{ type: "hello", token: "bad" }]);

    const silent = service({ hello: { type: "welcome", id: "speaker", speaker: true } });
    expect(await endRoom("physics-101", "tok", { base: "ws://svc/api/", socket: silent.socket, timeoutMs: 10 })).toBe(
      false,
    );
    const broken = () => {
      throw new Error("no sockets here");
    };
    expect(await endRoom("physics-101", "tok", { base: "ws://svc/api/", socket: broken })).toBe(false);
  });
});
