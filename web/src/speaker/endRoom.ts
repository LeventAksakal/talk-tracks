// End talk at the room service (decision 0024's endpoint): a short speaker session that says `end`, so the room's
// state track says "ended" for good and its agents stop, instead of a finished talk showing "Paused" forever.

import { type WebSocketLike, roomServiceBase } from "../annotate/client";

export interface EndRoomOptions {
  /** The endpoint's base URL; default `roomServiceBase()`. */
  base?: string;
  /** For tests. */
  socket?: (url: string) => WebSocketLike;
  /** Give up after this long; default 5 s. */
  timeoutMs?: number;
}

/**
 * Tell the room service that the speaker ended the talk. Proves the speaker with the relay token, as the console's
 * questions session does. Resolves true once the service acknowledged, false when it refused, could not be reached
 * or did not answer in time. Never rejects: ending the talk in the console does not wait on it.
 */
export function endRoom(room: string, token: string, options: EndRoomOptions = {}): Promise<boolean> {
  const url = `${options.base ?? roomServiceBase()}rooms/${encodeURIComponent(room)}`;
  return new Promise((resolve) => {
    let ws: WebSocketLike | undefined;
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        // closing is best effort
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), options.timeoutMs ?? 5_000);
    try {
      ws = options.socket ? options.socket(url) : (new WebSocket(url) as unknown as WebSocketLike);
    } catch {
      finish(false);
      return;
    }
    const send = (msg: object) => ws?.send(JSON.stringify(msg));
    ws.onopen = () => send({ type: "hello", token });
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: { type?: unknown; seq?: unknown };
      try {
        msg = JSON.parse(ev.data) as { type?: unknown; seq?: unknown };
      } catch {
        return;
      }
      if (msg.type === "welcome") send({ type: "end", seq: 1 });
      else if (msg.type === "ack" && msg.seq === 1) finish(true);
      else if (msg.type === "error") finish(false);
    };
    ws.onclose = () => finish(false);
    ws.onerror = () => {};
  });
}
