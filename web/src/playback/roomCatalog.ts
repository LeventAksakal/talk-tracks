// The room catalog `talk/<room>/catalog` (design §5.10): an MSF catalog published by the room service,
// with a Talk Tracks extension object `tt` at the root and on each track. Everything that knows its
// shape is here, so the contract can settle without touching the rest.
//
// Field names inside `tt` are not fixed by the design yet. Assumed until the contract lands:
//   root  tt.epochMs                        the room epoch E (Unix ms)
//   root  tt.shift   { "<clock.wall>": ms } shifts for broadcasts from a slow device clock
//   root  tt.status  { "<track path>/<track name>": { producing, originFetches, cachedFetches, backfills, spendUsd, capped } }
//   track tt.latenessMs                     L, the most a track publishes late
//   track tt.cost                           "paid" | "free"

import { ROOT } from "../contracts/names";
import type { Closable, Transport } from "../transport/types";

export const catalogPath = (room: string) => `${ROOT}/${room}/catalog`;
export const CATALOG_TRACK = "catalog";

export interface CatalogTrack {
  /** Full path of the track's broadcast, e.g. talk/R/agents/captions. */
  namespace: string;
  name: string;
  eventType: string | undefined;
  lang: string | undefined;
  /** L: how late (ms) the track may publish an item after its room time. */
  latenessMs: number;
  cost: "paid" | "free" | undefined;
}

export interface TrackStatus {
  producing: boolean;
  /** FETCHes the agent served as origin (relay cache misses). */
  originFetches: number;
  /** FETCHes the relay answered from its cache. */
  cachedFetches: number;
  backfills: number;
  spendUsd: number;
  capped: boolean;
}

export interface RoomCatalog {
  /** E, the room epoch, Unix ms. */
  epochMs: number | undefined;
  tracks: CatalogTrack[];
  /** By `<namespace>/<name>`. */
  status: Record<string, TrackStatus>;
  /** Shift in ms by the teacher broadcast's `clock.wall`. */
  shift: Record<string, number>;
}

/** L for a track with none declared. */
export const DEFAULT_LATENESS_MS = 4_000;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function parseRoomCatalog(payload: Uint8Array | string): RoomCatalog | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(typeof payload === "string" ? payload : new TextDecoder().decode(payload));
  } catch {
    return undefined;
  }
  const root = obj(raw);
  const tt = obj(root.tt);
  const tracks: CatalogTrack[] = (Array.isArray(root.tracks) ? root.tracks : []).flatMap((t) => {
    const o = obj(t);
    if (typeof o.name !== "string" || typeof o.namespace !== "string") return [];
    const x = obj(o.tt);
    return [
      {
        namespace: o.namespace,
        name: o.name,
        eventType: typeof o.eventType === "string" ? o.eventType : undefined,
        lang: typeof o.lang === "string" ? o.lang : undefined,
        latenessMs: Math.max(0, num(x.latenessMs) ?? DEFAULT_LATENESS_MS),
        cost: x.cost === "paid" || x.cost === "free" ? x.cost : undefined,
      },
    ];
  });
  const status: Record<string, TrackStatus> = {};
  for (const [key, v] of Object.entries(obj(tt.status))) {
    const s = obj(v);
    status[key] = {
      producing: s.producing === true,
      originFetches: num(s.originFetches) ?? 0,
      cachedFetches: num(s.cachedFetches) ?? 0,
      backfills: num(s.backfills) ?? 0,
      spendUsd: num(s.spendUsd) ?? 0,
      capped: s.capped === true,
    };
  }
  const shift: Record<string, number> = {};
  for (const [key, v] of Object.entries(obj(tt.shift))) {
    const ms = num(v);
    if (ms !== undefined) shift[key] = ms;
  }
  return { epochMs: num(tt.epochMs), tracks, status, shift };
}

/** The track's L from the catalog, by broadcast path and track name. */
export function latenessOf(catalog: RoomCatalog | undefined, path: string, track: string): number {
  return catalog?.tracks.find((t) => t.namespace === path && t.name === track)?.latenessMs ?? DEFAULT_LATENESS_MS;
}

/** The newest catalog, as it changes. Reading it subscribes to the room service only: no agent works for it. */
export function watchRoomCatalog(
  transport: Transport,
  room: string,
  onCatalog: (catalog: RoomCatalog) => void,
): Closable {
  return transport.subscribe(catalogPath(room), CATALOG_TRACK, ({ payload }) => {
    const catalog = parseRoomCatalog(payload);
    if (catalog) onCatalog(catalog);
  });
}
