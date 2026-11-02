// Demo sessions (decision 0032): a demo lecture's live session plays once from 00:00, ends, and a new session starts
// from 00:00 under the same room name. A session boundary is a real end and start, so the player shows an end card,
// then joins the new session with a fresh playback: no playhead, slices or "what you missed" carry over.
//
// How a session is told (the demo-sessions lane publishes it; proposed in the player lane's report): the teacher
// broadcast's hang catalog carries `talk_tracks.session`, an id that changes with every session, and optionally
// `talk_tracks.session_start_ms`, the room ms of the session's 00:00. Without it the session starts at the broadcast's
// PTS zero (each session is a new broadcast). A room whose catalog E changes is a new session too: its whole clock is.

import { type HangClock, hangClockOf, wallClockMs } from "./roomClock";

export interface SessionInfo {
  /** Changes with every session. */
  id: string;
  /** The broadcast's clock, for its PTS zero. */
  clock: HangClock;
  /** Room ms of the session's 00:00, when the publisher says. */
  startMs: number | undefined;
}

/** The session a teacher hang catalog (parsed JSON) announces, or undefined when the room has no sessions. */
export function sessionOf(catalog: unknown): SessionInfo | undefined {
  const clock = hangClockOf(catalog);
  const tt = (catalog as { talk_tracks?: unknown } | undefined)?.talk_tracks;
  if (!clock || !tt || typeof tt !== "object") return undefined;
  const { session, session_start_ms: start } = tt as { session?: unknown; session_start_ms?: unknown };
  if (typeof session !== "string" && typeof session !== "number") return undefined;
  if (session === "") return undefined;
  return {
    id: String(session),
    clock,
    startMs: typeof start === "number" && Number.isFinite(start) && start >= 0 ? start : undefined,
  };
}

/** Room ms of a session's 00:00: what the publisher says, else its broadcast's PTS zero. */
export function sessionOrigin(session: SessionInfo, epochMs: number, shiftMs = 0): number {
  return session.startMs ?? Math.max(0, wallClockMs(session.clock, 0) - epochMs + shiftMs);
}

/** What a playback says about its sessions (RoomMedia implements it). */
export interface SessionSource {
  /** What tells the session: the room catalog's E and the hang catalog's session id, each once known. */
  sessionKey(): { epoch?: number; session?: string };
  onChange(listener: () => void): () => void;
}

/** How long the end card stays before the new session is joined, ms. */
export const END_CARD_MS = 2_000;

/**
 * Watch a playback's sessions: the first E and session id seen are this playback's; either one changing later means
 * the session ended. `ended()` runs once at that moment (show the end card), `restart()` END_CARD_MS later (join the
 * new one). A value seen for the first time (the session id arriving after E) is no change.
 */
export function watchSessions(
  source: SessionSource,
  on: { ended(): void; restart(): void },
  options: { endCardMs?: number } = {},
): () => void {
  const first: { epoch?: number; session?: string } = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    if (timer !== undefined) return;
    const key = source.sessionKey();
    first.epoch ??= key.epoch;
    first.session ??= key.session;
    const changed =
      (key.epoch !== undefined && key.epoch !== first.epoch) ||
      (key.session !== undefined && key.session !== first.session);
    if (!changed) return;
    on.ended();
    timer = setTimeout(on.restart, options.endCardMs ?? END_CARD_MS);
  };
  const off = source.onChange(check);
  check();
  return () => {
    off();
    clearTimeout(timer);
  };
}
