// Broadcast and track names, mirroring agents/src/talk_tracks/contracts.py.

export const ROOT = "talk";

/** The speaker's hang broadcast (@moq/publish): microphone and camera, described by its `catalog.json`. */
export const teacherPath = (room: string) => `${ROOT}/${room}/teacher`;
export const AUDIO_TRACK = "audio";
/** The hang catalog track of teacherPath(room), which names its media tracks. */
export const HANG_CATALOG_TRACK = "catalog.json";

/** The speaker's slide broadcast (decision 0018). */
export const slidesPath = (room: string) => `${ROOT}/${room}/slides`;
/** One SlideFrame JSON per slide shown, for the describe agent. */
export const FRAMES_TRACK = "frames";
/** DeckObject: one group per deck, object 0 the DeckInfo, later objects the slide images. */
export const DECK_TRACK = "deck";
/** CurrentSlideObject, sliced. */
export const SLIDE_TRACK = "slide";
/** InkObject, sliced: the pencil. Also in annotationsPath(room). */
export const INK_TRACK = "ink";
/** MarksObject, sliced: text underlines and highlights. Also in annotationsPath(room). */
export const MARKS_TRACK = "marks";
/** PointerObject, sliced: the laser, ephemeral. */
export const POINTER_TRACK = "pointer";

/** The room service's broadcast: the room catalog (MSF, design §5.10, a new group per change) and the room's state. */
export const catalogPath = (room: string) => `${ROOT}/${room}/catalog`;
export const CATALOG_TRACK = "catalog";
/** RoomStateObject, sliced, in catalogPath(room). */
export const ROOM_TRACK = "room";

/** Listener comments, published by the room service (listeners never publish to the relay). */
export const commentsPath = (room: string) => `${ROOT}/${room}/comments`;
/** CommentsObject, sliced. */
export const COMMENTS_TRACK = "comments";

/**
 * Everyone else's annotations of the deck, tracks INK_TRACK and MARKS_TRACK (the same objects as the
 * speaker's), published by the room service (decision 0021).
 */
export const annotationsPath = (room: string) => `${ROOT}/${room}/annotations`;

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

const ROOM_RE = /^[a-z0-9-]{3,40}$/;

export function isValidRoom(room: string): boolean {
  return ROOM_RE.test(room);
}

/** Lower-case and trim what a person typed; null when it can't be a room name. */
export function normaliseRoom(input: string): string | null {
  const room = input.trim().toLowerCase().replace(/\s+/g, "-");
  return isValidRoom(room) ? room : null;
}
