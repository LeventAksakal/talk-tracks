// Broadcast and track names, mirroring agents/src/talk_tracks/contracts.py.

export const ROOT = "talk";

/** The speaker's broadcast: microphone audio (track `audio`, legacy container) and, later, video. */
export const teacherPath = (room: string) => `${ROOT}/${room}/teacher`;
export const AUDIO_TRACK = "audio";

/** The speaker's slide frames: one SlideFrame JSON per group on track `frames`. */
export const slidesPath = (room: string) => `${ROOT}/${room}/slides`;
export const FRAMES_TRACK = "frames";

/** Every agent publishes `talk/<room>/agents/<agent>/<instance>`, track `state`. */
export const agentsPrefix = (room: string) => `${ROOT}/${room}/agents`;
export const agentPath = (room: string, agent: string, instance: string) => `${agentsPrefix(room)}/${agent}/${instance}`;
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
