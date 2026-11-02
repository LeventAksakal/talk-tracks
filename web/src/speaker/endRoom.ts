// End talk at the room service (decision 0024's endpoint): a short speaker session that says `end`, so the room's
// state track says "ended" for good and its agents stop, instead of a finished talk showing "Paused" forever. The
// message is retried until the service answers it: a lost socket or a silent service is tried again, with a growing
// pause, until it acknowledges.

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
 * How one try went: `acked` the room says ended; `nothing` the room never went live (no clock), so there is nothing
 * to end; `refused` the service will not take it from this token (not the speaker's), so trying again cannot help;
 * `lost` no answer (unreachable, socket closed, timed out, busy): try again.
 */
export type EndOutcome = "acked" | "nothing" | "refused" | "lost";

/** Tell the room service the speaker ended the talk, once. Proves the speaker with the relay token. Never rejects. */
export function endRoomOnce(room: string, token: string, options: EndRoomOptions = {}): Promise<EndOutcome> {
  const url = `${options.base ?? roomServiceBase()}rooms/${encodeURIComponent(room)}`;
  return new Promise((resolve) => {
    let ws: WebSocketLike | undefined;
    let done = false;
    const finish = (outcome: EndOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        // closing is best effort
      }
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("lost"), options.timeoutMs ?? 5_000);
    try {
      ws = options.socket ? options.socket(url) : (new WebSocket(url) as unknown as WebSocketLike);
    } catch {
      finish("lost");
      return;
    }
    const send = (msg: object) => ws?.send(JSON.stringify(msg));
    ws.onopen = () => send({ type: "hello", token });
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: { type?: unknown; seq?: unknown; code?: unknown };
      try {
        msg = JSON.parse(ev.data) as { type?: unknown; seq?: unknown; code?: unknown };
      } catch {
        return;
      }
      if (msg.type === "welcome") send({ type: "end", seq: 1 });
      else if (msg.type === "ack" && msg.seq === 1) finish("acked");
      else if (msg.type === "error") {
        // Too many tries or messages is the service being busy: try again later.
        finish(msg.code === "not-live" ? "nothing" : msg.code === "rate" || msg.code === "limit" ? "lost" : "refused");
      }
    };
    ws.onclose = () => finish("lost");
    ws.onerror = () => {};
  });
}

/**
 * Tell the room service that the speaker ended the talk. Resolves true once the service acknowledged, false when it
 * refused, could not be reached or did not answer in time. Never rejects.
 */
export async function endRoom(room: string, token: string, options: EndRoomOptions = {}): Promise<boolean> {
  return (await endRoomOnce(room, token, options)) === "acked";
}

export interface RetryOptions {
  /** The pause after the first lost try, ms; it doubles up to `maxDelayMs`. Default 1 s. */
  firstDelayMs?: number;
  /** Default 10 s. */
  maxDelayMs?: number;
  /** Stops the retries (the page goes away). */
  signal?: AbortSignal;
}

/**
 * Try `attempt` until the service answers it: lost tries (false, or `lost`) are tried again after a growing pause.
 * Resolves with the answer (true counts as `acked`), or `lost` when stopped by the signal.
 */
export async function untilAnswered(
  attempt: () => Promise<boolean | EndOutcome>,
  options: RetryOptions = {},
): Promise<EndOutcome> {
  let delay = options.firstDelayMs ?? 1_000;
  const max = options.maxDelayMs ?? 10_000;
  for (;;) {
    if (options.signal?.aborted) return "lost";
    const raw = await attempt().catch(() => "lost" as const);
    const outcome: EndOutcome = raw === true ? "acked" : raw === false ? "lost" : raw;
    if (outcome !== "lost") return outcome;
    if (options.signal?.aborted) return "lost";
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    delay = Math.min(max, delay * 2);
  }
}
