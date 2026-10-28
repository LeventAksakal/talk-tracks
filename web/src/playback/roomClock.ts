// The room clock (design §4.5): room time (ms) = wall time of a media timestamp − E.
//
// @moq/publish stamps every media timestamp with performance.now() in µs and advertises the mapping to
// wall time as the root `clock` of the teacher's hang catalog: `wall` is the wall time of PTS zero, in
// `timescale` units since the moq epoch (2020-01-01). E, the room's epoch in Unix ms, comes from the room
// catalog. Nothing else: no clock track, no offset.

/** 2020-01-01T00:00:00Z, the moq epoch, in Unix ms. */
export const MOQ_EPOCH_UNIX_MS = 1_577_836_800_000;

/** The hang catalog's root `clock`. */
export interface HangClock {
  wall: number;
  /** Units per second of `wall` (default 1 000 000: µs). */
  timescale: number;
}

/** The root `clock` of a hang catalog (parsed JSON), or undefined when the publisher omitted it. */
export function hangClockOf(catalog: unknown): HangClock | undefined {
  if (!catalog || typeof catalog !== "object") return undefined;
  const clock = (catalog as { clock?: unknown }).clock;
  if (!clock || typeof clock !== "object") return undefined;
  const { wall, timescale } = clock as { wall?: unknown; timescale?: unknown };
  if (typeof wall !== "number" || !Number.isFinite(wall) || wall < 0) return undefined;
  const ts = typeof timescale === "number" && timescale > 0 ? timescale : 1_000_000;
  return { wall, timescale: ts };
}

/** The hang catalog's track in a broadcast (@moq/hang catalog TRACK). */
export const HANG_CATALOG_TRACK = "catalog.json";

/** The root `clock` of a hang catalog track payload, or undefined (no clock, or not JSON). */
export function hangClockOfPayload(payload: Uint8Array): HangClock | undefined {
  try {
    return hangClockOf(JSON.parse(new TextDecoder().decode(payload)));
  } catch {
    return undefined;
  }
}

/** Unix ms of a media timestamp (`ptsMs`, ms since PTS zero), as @moq/hang's wallClockTime() computes it. */
export function wallClockMs(clock: HangClock, ptsMs: number): number {
  return MOQ_EPOCH_UNIX_MS + (1000 * clock.wall) / clock.timescale + ptsMs;
}

/**
 * Room time of a wall time. `shiftMs` is the room service's shift for a broadcast from a device whose
 * clock ran behind (catalog `tt.shift`, keyed by the broadcast's `clock.wall`); 0 otherwise.
 */
export function roomTimeOf(wallMs: number, epochMs: number, shiftMs = 0): number {
  return Math.round(wallMs - epochMs + shiftMs);
}
