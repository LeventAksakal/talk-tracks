// The cost guard for downloads and offers (decisions 0010, 0019): a translation agent is lazy and paid, so a
// subscription or a FETCH of its past can wake it and spend. A download that gathers "every language", the lecture
// package and the language offer therefore use only translations that cost nothing more to read: the ones this
// listener already has subscribed, the ones the room catalog says are running now, and recorded ones (a looped
// room's tracks are listed as free). Picking one language by hand is the listener's choice, like picking subtitles.

import { agentPath } from "../contracts/names";
import type { TrackView } from "../playback/aiTracks";
import { type RoomCatalog, statusOf, trackOf } from "../playback/roomCatalog";

export interface LanguageGuard {
  /** The newest room catalog; undefined before it arrives (then only subscribed tracks count). */
  catalog: RoomCatalog | undefined;
  room: string;
  /** No relay and no paid agents (the offline demo): every track is free. */
  offline: boolean;
  now?: number;
}

/** Why a translation can be read without waking an agent, or undefined when it cannot. */
export function whyFree(
  track: TrackView,
  guard: LanguageGuard,
): "offline" | "subscribed" | "free" | "running" | undefined {
  if (guard.offline) return "offline";
  if (track.enabled) return "subscribed";
  if (trackOf(guard.catalog, agentPath(guard.room, track.agent), track.track)?.tt?.cost === "free") return "free";
  if (statusOf(guard.catalog, track.agent, guard.now)?.status === "live") return "running";
  return undefined;
}

/** Split a room's translations into those a download may gather and those it leaves out. */
export function gatherableTranslations(
  translations: readonly TrackView[],
  guard: LanguageGuard,
): { included: TrackView[]; left: TrackView[] } {
  const included: TrackView[] = [];
  const left: TrackView[] = [];
  for (const t of translations) (whyFree(t, guard) ? included : left).push(t);
  return { included, left };
}
