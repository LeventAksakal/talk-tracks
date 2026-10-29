// Broadcast and track names, mirroring agents/src/talk_tracks/contracts.py.

export const ROOT = "talk";

/** The speaker's broadcast: microphone audio (track `audio`, legacy container) and, later, video. */
export const teacherPath = (room: string) => `${ROOT}/${room}/teacher`;
export const AUDIO_TRACK = "audio";

/** The speaker's slide frames: one SlideFrame JSON per group on track `frames`. */
export const slidesPath = (room: string) => `${ROOT}/${room}/slides`;
export const FRAMES_TRACK = "frames";

/** The room catalog (MSF, design §5.10), published by the room service: a new group per change. */
export const catalogPath = (room: string) => `${ROOT}/${room}/catalog`;
export const CATALOG_TRACK = "catalog";

/**
 * Every agent publishes `talk/<room>/agents/<agent>` under a stable name: track `items` (an MSF
 * event timeline in 4 s slices: carry-in plus new records) or, for the chapters agent, track `outline` (one group
 * per revision).
 * The `instance` argument builds the v1 path for the legacy room store and demo script only.
 */
export const agentsPrefix = (room: string) => `${ROOT}/${room}/agents`;
export const agentPath = (room: string, agent: string, instance?: string) =>
  instance === undefined ? `${agentsPrefix(room)}/${agent}` : `${agentsPrefix(room)}/${agent}/${instance}`;
export const ITEMS_TRACK = "items";
export const OUTLINE_TRACK = "outline";
/** @deprecated v1 track of full-state snapshots. */
export const STATE_TRACK = "state";

/** Agents send a heartbeat every 2 s; an agent with no object for this long is stale. */
export const STALE_AFTER_MS = 6_000;

const ROOM_RE = /^[a-z0-9-]{3,32}$/;

export function isValidRoom(room: string): boolean {
  return ROOM_RE.test(room);
}

/** Lower-case and trim what a person typed; null when it can't be a room name. */
export function normaliseRoom(input: string): string | null {
  const room = input.trim().toLowerCase().replace(/\s+/g, "-");
  return isValidRoom(room) ? room : null;
}
