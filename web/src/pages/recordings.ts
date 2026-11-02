// The recordings the hub lists (decision 0032): archived rooms named `<id>-recording`, from the archive's room list
// (wiki/howto/archive.md, `rooms.json`). Other archived rooms (generation runs, ended talks) are not listed.

import { isValidRoom, recordingOf } from "../contracts/names";

export const ROOMS_URL = "/archive/rooms.json";

export interface Recording {
  /** The archived room, `<id>-recording`. */
  room: string;
  /** The lecture or talk it records. */
  of: string;
  /** When it was last written, Unix ms; undefined when the archive does not say. */
  lastWallMs?: number;
}

/** The recordings in the archive, newest first; [] when the archive cannot be read. */
export async function fetchRecordings(fetchImpl: typeof fetch = fetch, url = ROOMS_URL): Promise<Recording[]> {
  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    return parseRooms(await res.json());
  } catch {
    return [];
  }
}

export function parseRooms(doc: unknown): Recording[] {
  if (!doc || typeof doc !== "object") return [];
  const rooms = (doc as { rooms?: unknown }).rooms;
  if (!Array.isArray(rooms)) return [];
  const out: Recording[] = [];
  for (const entry of rooms as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const { room, last_wall_ms } = entry as { room?: unknown; last_wall_ms?: unknown };
    if (typeof room !== "string" || !isValidRoom(room)) continue;
    const of = recordingOf(room);
    if (!of) continue;
    out.push({ room, of, lastWallMs: typeof last_wall_ms === "number" ? last_wall_ms : undefined });
  }
  return out.sort((a, b) => (b.lastWallMs ?? 0) - (a.lastWallMs ?? 0));
}
