// The rooms presenters made (access codes, judge batches, any talk the archive recorded), for the hub's Live now and
// Recordings rows: GET /api/rooms on the room service (archive.listing, wiki/howto/tokens.md). One request per visit;
// the room service and the browser keep the answer a few seconds.

import { isValidRoom } from "../contracts/names";

export const COMMUNITY_URL = "/api/rooms";

export interface CommunityRoom {
  room: string;
  title: string;
  speaker?: string;
  state: "upcoming" | "live" | "ended";
  /** When the talk first went on air, Unix seconds. */
  started?: number;
  /** When it last sent media, once ended, Unix seconds. */
  ended?: number;
  /** Its length, seconds (so far, while live). */
  durationS?: number;
  /** The archive kept its talk: /watch/<room> plays it from the start. */
  recording: boolean;
  /** The first slide the archive kept, an /archive/ path. */
  still?: string;
}

/** The rooms; [] when the room service cannot be reached or says nothing sensible. */
export async function fetchCommunityRooms(
  fetchImpl: typeof fetch = fetch,
  url = COMMUNITY_URL,
): Promise<CommunityRoom[]> {
  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    return parseCommunityRooms(await res.json());
  } catch {
    return [];
  }
}

const STATES = new Set(["upcoming", "live", "ended"]);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const text = (v: unknown, most: number) =>
  typeof v === "string" && v.trim() && v.length <= most ? v.trim() : undefined;

export function parseCommunityRooms(doc: unknown): CommunityRoom[] {
  const rooms = doc && typeof doc === "object" ? (doc as { rooms?: unknown }).rooms : undefined;
  if (!Array.isArray(rooms)) return [];
  const out: CommunityRoom[] = [];
  for (const raw of rooms as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.room !== "string" || !isValidRoom(e.room)) continue;
    if (typeof e.state !== "string" || !STATES.has(e.state)) continue;
    const still = typeof e.still === "string" && /^\/archive\/[\w./-]+$/.test(e.still) ? e.still : undefined;
    out.push({
      room: e.room,
      title: text(e.title, 120) ?? e.room,
      speaker: text(e.speaker, 60),
      state: e.state as CommunityRoom["state"],
      started: num(e.started),
      ended: num(e.ended),
      durationS: num(e.duration),
      recording: e.recording === true,
      still,
    });
  }
  return out;
}
