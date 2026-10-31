// The room's AI tracks as player features (ui-design §4): subtitles in the original language or a translation,
// chapters and glossary, slide descriptions. There are no switches (decision 0026): a track is subscribed while what
// needs it is picked or open. A subtitle language pick subscribes and Off lets go; a side panel tab subscribes while
// it is open; the sound "with slide descriptions" subscribes the descriptions. A track let go stays subscribed for
// LINGER_MS, so changing back is free and the old line stays up until the new one lands.

import type { TrackView } from "../playback/aiTracks";
import type { PanelTab, Prefs } from "./prefs";
import { AUDIENCE_TRACKS, SPEAKER_TRACKS, type TrackId } from "./slideTracks";

export interface RoomTracks {
  captions: TrackView | undefined;
  translations: TrackView[];
  describe: TrackView | undefined;
  outline: TrackView | undefined;
}

export function roomTracks(tracks: readonly TrackView[]): RoomTracks {
  return {
    captions: tracks.find((t) => t.kind === "captions"),
    translations: tracks.filter((t) => t.kind === "translation" && t.lang),
    describe: tracks.find((t) => t.kind === "slides"),
    outline: tracks.find((t) => t.kind === "outline"),
  };
}

/** The translation track for a subtitle language, if the room has one. */
export function translationFor(room: RoomTracks, lang: string): TrackView | undefined {
  const base = (tag: string) => tag.toLowerCase().split("-")[0];
  return (
    room.translations.find((t) => t.lang?.toLowerCase() === lang.toLowerCase()) ??
    room.translations.find((t) => base(t.lang ?? "") === base(lang))
  );
}

/** The side panel tab on screen, or undefined while the panel is closed. */
export function openTab(prefs: Pick<Prefs, "panel" | "tab">): PanelTab | undefined {
  return prefs.panel ? prefs.tab : undefined;
}

/** Track ids that what is picked and open needs now. */
export function wantedTracks(
  prefs: Pick<Prefs, "cc" | "subtitleLang" | "dual" | "sound">,
  room: RoomTracks,
  tab: PanelTab | undefined,
): Set<string> {
  const want = new Set<string>();
  const translating = prefs.cc && prefs.subtitleLang !== "original";
  const translation = translating ? translationFor(room, prefs.subtitleLang) : undefined;
  if (room.captions && ((prefs.cc && (!translating || prefs.dual)) || tab === "transcript")) want.add(room.captions.id);
  if (translation) want.add(translation.id);
  if (room.outline && (tab === "chapters" || tab === "glossary")) want.add(room.outline.id);
  if (room.describe && (prefs.sound === "describe" || tab === "descriptions")) want.add(room.describe.id);
  return want;
}

/**
 * The slide, annotation and room tracks the player needs (decision 0010): the room's state always (it says paused,
 * ended, not started; the room service publishes it, no agent works for it); the speaker's deck, slide, ink, marks and
 * laser while the slides are on screen; the audience's ink and marks only while the listener shows them, with the
 * Discussion tab or their own tools open (slide comments are supplementary, decision 0026).
 */
export function wantedSlideTracks(slidesShown: boolean, audience: boolean): TrackId[] {
  if (!slidesShown) return ["room"];
  return ["room", ...SPEAKER_TRACKS, ...(audience ? AUDIENCE_TRACKS : [])];
}

/** How long a track stays subscribed after nothing needs it (brand.md §6: "linger 30 s after Off"). */
export const LINGER_MS = 30_000;

/**
 * Wanted tracks plus the ones let go less than `ms` ago. `hold(wanted, now)` says what to keep subscribed and when to
 * ask again (the next release), so a quick change back never unsubscribes.
 */
export class Linger {
  readonly #ms: number;
  readonly #released = new Map<string, number>();
  #last = new Set<string>();

  constructor(ms = LINGER_MS) {
    this.#ms = ms;
  }

  hold(wanted: ReadonlySet<string>, now: number): { held: Set<string>; next: number | undefined } {
    for (const id of this.#last) if (!wanted.has(id) && !this.#released.has(id)) this.#released.set(id, now);
    for (const id of wanted) this.#released.delete(id);
    this.#last = new Set(wanted);
    const held = new Set(wanted);
    let next: number | undefined;
    for (const [id, at] of this.#released) {
      if (now - at >= this.#ms) {
        this.#released.delete(id);
        continue;
      }
      held.add(id);
      next = Math.min(next ?? Infinity, at + this.#ms);
    }
    return { held, next };
  }
}
