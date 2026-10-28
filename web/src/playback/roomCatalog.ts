// The room catalog `talk/<room>/catalog` (design §5.10): an MSF catalog published by the room service,
// with a Talk Tracks object `tt` at the root (E, shift, status by agent name) and on each track
// (dependsOn, latenessMs, cost). Types and validation are the contract's (raw JSON: @moq/msf's schema
// drops our fields); this file only reads it.

import { CATALOG_TRACK, catalogPath } from "../contracts/names";
import type { CatalogTrack, RoomCatalog, TrackStatus } from "../contracts/types";
import { parseRoomCatalog } from "../contracts/validate";
import type { Closable, Transport } from "../transport/types";

export type { CatalogTrack, RoomCatalog, TrackStatus };

/** L for a track with none declared. */
export const DEFAULT_LATENESS_MS = 4_000;
/** A status entry not written for this long counts as idle (lane briefs, "Catalog field names"). */
export const STATUS_FRESH_MS = 15_000;

export function trackOf(catalog: RoomCatalog | undefined, path: string, track: string): CatalogTrack | undefined {
  return catalog?.tracks.find((t) => t.namespace === path && t.name === track);
}

/** The track's L, by broadcast path and track name. */
export function latenessOf(catalog: RoomCatalog | undefined, path: string, track: string): number {
  return Math.max(0, trackOf(catalog, path, track)?.tt?.latenessMs ?? DEFAULT_LATENESS_MS);
}

/** An agent's status, idle when its entry is stale. */
export function statusOf(catalog: RoomCatalog | undefined, agent: string, now = Date.now()): TrackStatus | undefined {
  const s = catalog?.tt.status?.[agent];
  if (!s) return undefined;
  return s.status !== "capped" && now - s.updated_ms > STATUS_FRESH_MS ? { ...s, status: "idle", producing: false } : s;
}

/** The newest catalog, as it changes. Reading it subscribes to the room service only: no agent works for it. */
export function watchRoomCatalog(
  transport: Transport,
  room: string,
  onCatalog: (catalog: RoomCatalog) => void,
): Closable {
  return transport.subscribe(catalogPath(room), CATALOG_TRACK, ({ payload }) => {
    const parsed = parseRoomCatalog(payload);
    if (parsed.ok) onCatalog(parsed.value);
    else console.warn(`dropping a room catalog that does not match the contract: ${parsed.error}`);
  });
}
