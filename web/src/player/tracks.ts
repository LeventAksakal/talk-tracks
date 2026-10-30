// The room's AI tracks as player features (ui-design §4): subtitles in the original language or a
// translation, chapters, slide descriptions. Nothing is subscribed until the viewer turns the feature on
// (decision 0010); the player then holds exactly the tracks its features need.

import type { TrackView } from "../playback/aiTracks";
import type { Prefs } from "./prefs";

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

/** Track ids the viewer's features need on. */
export function wantedTracks(prefs: Prefs, room: RoomTracks): Set<string> {
  const want = new Set<string>();
  const translating = prefs.cc && prefs.subtitleLang !== "original";
  const translation = translating ? translationFor(room, prefs.subtitleLang) : undefined;
  if (room.captions && ((prefs.cc && (!translating || prefs.dual)) || prefs.transcript)) want.add(room.captions.id);
  if (translation) want.add(translation.id);
  if (room.outline && prefs.chapters) want.add(room.outline.id);
  if (room.describe && prefs.describe !== "off") want.add(room.describe.id);
  return want;
}
