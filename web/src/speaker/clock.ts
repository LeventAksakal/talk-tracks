// The console's room clock (design §4.5, lane briefs "Speaker console"): room ms = wall time of the
// speaker's media − E + the broadcast's tt.shift. @moq/publish stamps media with performance.now() and
// advertises the wall time of PTS zero as the hang catalog's root `clock`, so the console stamps its
// slide, ink, marks and pointer records on that same clock: ink lands on the audio it was drawn over.
// Nothing is stamped until the room catalog gives E and lists this broadcast's shift.

import { SLICE_MS, roomMs } from "../contracts/types";
import type { RoomCatalog } from "../contracts/types";
import { type HangClock, shiftOf, wallClockMs } from "../playback/roomClock";

/** Where the room clock stands, for the pre-flight list. */
export type ClockState =
  | { kind: "no-broadcast" }
  | { kind: "no-clock" }
  | { kind: "waiting-epoch" }
  | { kind: "waiting-shift" }
  | { kind: "ready"; epoch: number; shift: number; local: boolean };

/** Wall ms now, on the media's clock when the hang clock is known (as the archive maps media). */
export function wallNowMs(clock?: HangClock, perfNow = performance.now()): number {
  return clock ? wallClockMs(clock, perfNow) : performance.timeOrigin + perfNow;
}

/** A local E for development without a room service: the wall time now, rounded down to a slice. */
export function localEpoch(wallMs: number): number {
  return Math.floor(wallMs / SLICE_MS) * SLICE_MS;
}

/**
 * The clock state from what the console sees: its own broadcast's hang clock (undefined while not on
 * air, null when the catalog has no clock) and the room catalog. `localEpochMs` overrides E (dev only).
 */
export function clockState(
  onAir: boolean,
  hang: HangClock | null | undefined,
  catalog: RoomCatalog | undefined,
  localEpochMs?: number,
): ClockState {
  if (localEpochMs !== undefined) return { kind: "ready", epoch: localEpochMs, shift: 0, local: true };
  if (!onAir || hang === undefined) return { kind: "no-broadcast" };
  if (hang === null) return { kind: "no-clock" };
  if (!catalog) return { kind: "waiting-epoch" };
  if (catalog.tt.shift[String(hang.wall)] === undefined) return { kind: "waiting-shift" };
  return { kind: "ready", epoch: catalog.tt.E, shift: shiftOf(catalog.tt.shift, hang), local: false };
}

/** Room ms now, or undefined while the clock is not ready. */
export function roomNowFn(state: ClockState, hang: HangClock | null | undefined): (() => number) | undefined {
  if (state.kind !== "ready") return undefined;
  const clock = state.local ? undefined : (hang ?? undefined);
  return () => Math.max(0, roomMs(wallNowMs(clock), state.epoch, state.shift));
}
