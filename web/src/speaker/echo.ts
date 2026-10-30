// "Know it works" (S4) for the slide tracks: an anonymous connection, a viewer's view of the relay,
// subscribes to the console's own deck, slide, ink, marks and pointer tracks and checks every object
// against the contracts. A refused publish is silent (decision 0005), so this is the proof.

import { DECK_TRACK, INK_TRACK, MARKS_TRACK, POINTER_TRACK, SLIDE_TRACK, slidesPath } from "../contracts/names";
import {
  type Parsed,
  parseCurrentSlideObject,
  parseDeckObject,
  parseInkObject,
  parseMarksObject,
  parsePointerObject,
} from "../contracts/validate";
import type { Closable, Transport } from "../transport/types";

export const ECHO_TRACKS: Record<string, (p: Uint8Array) => Parsed<unknown>> = {
  [DECK_TRACK]: parseDeckObject,
  [SLIDE_TRACK]: parseCurrentSlideObject,
  [INK_TRACK]: parseInkObject,
  [MARKS_TRACK]: parseMarksObject,
  [POINTER_TRACK]: parsePointerObject,
};

export interface EchoCount {
  /** Objects the relay carried back that match the contract. */
  ok: number;
  /** Objects that did not: a bug to report. */
  bad: number;
  lastError?: string;
  lastAt?: number;
}

export type Echo = Record<string, EchoCount>;

export function watchEcho(transport: Transport, room: string, onEcho: (echo: Echo) => void): Closable {
  const echo: Echo = Object.fromEntries(Object.keys(ECHO_TRACKS).map((t) => [t, { ok: 0, bad: 0 }]));
  const subs = Object.entries(ECHO_TRACKS).map(([track, parse]) =>
    transport.subscribe(slidesPath(room), track, ({ payload, receivedAt }) => {
      const parsed = parse(payload);
      const c = echo[track]!;
      echo[track] = parsed.ok
        ? { ...c, ok: c.ok + 1, lastAt: receivedAt }
        : { ...c, bad: c.bad + 1, lastError: parsed.error, lastAt: receivedAt };
      onEcho({ ...echo });
    }),
  );
  return { close: () => subs.forEach((s) => s.close()) };
}
