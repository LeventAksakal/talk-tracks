// What every part of the player reads: the playback and its view, the device preferences, the player
// state, the frame clock and the UI state (open menu, panel tab). One context instead of a prop chain.

import { createContext, type ReactNode, useContext } from "react";
import type { RoomMedia } from "../playback/media";
import type { Playback, PlaybackView } from "../playback/playback";
import type { Transport } from "../transport/types";
import type { FrameClock } from "./frameClock";
import type { Listening } from "./listening";
import type { NotesApi } from "./notes";
import type { PanelTab, Prefs, SourceKind } from "./prefs";
import type { SlideTracks } from "./slideTracks";
import type { PlayerState } from "./state";
import type { RoomTracks } from "./tracks";

export type MenuKind = "cc" | "style" | "layout" | "settings";

export interface UiState {
  menu: MenuKind | undefined;
  stats: boolean;
  shortcuts: boolean;
  /** Transcript search text. */
  search: string;
  /** Bumped to move focus into the transcript search or the note box. */
  focusSearch: number;
  focusNote: number;
  /** Sound was started from a gesture (live media plays only after one). */
  playing: boolean;
  /** A short message for screen readers and the canvas ("Bookmark added"). */
  toast: string | undefined;
}

export const INITIAL_UI: UiState = {
  menu: undefined,
  stats: false,
  shortcuts: false,
  search: "",
  focusSearch: 0,
  focusNote: 0,
  playing: false,
  toast: undefined,
};

/** An extra side panel tab, for lanes that come later (Discussion). */
export interface ExtraTab {
  id: string;
  label: string;
  content: ReactNode;
}

export interface PlayerCtx {
  playback: Playback;
  view: PlaybackView;
  /** RoomMedia when the room has real speaker media; undefined in the offline demo. */
  media: RoomMedia | undefined;
  transport: Transport | undefined;
  roomName: string;
  title: string;
  tracks: RoomTracks;
  prefs: Prefs;
  update: (change: Partial<Prefs> | ((p: Prefs) => Partial<Prefs>)) => void;
  ui: UiState;
  setUi: (change: Partial<UiState> | ((u: UiState) => Partial<UiState>)) => void;
  state: PlayerState;
  clock: FrameClock;
  notes: NotesApi;
  sources: SourceKind[];
  /** The speaker's slide tracks, the audience's annotations and the room's state; undefined with no relay. */
  slides: SlideTracks | undefined;
  /** The slides are on screen in the current layout, so their tracks are subscribed (decision 0010). */
  slidesShown: boolean;
  /** The number of the slide on screen at the playhead (1-based), from the slide track or the descriptions. */
  slideNumber: number | undefined;
  extraTabs: ExtraTab[];
  /** The listener's tools and the room service's session (decision 0024); undefined where nobody can write. */
  listening: Listening | undefined;
  /** The playhead for display, room ms (live: the live position). */
  at: number | undefined;
  /** A room time as the talk's clock shows it ("12:34"); in a looped demo room, the time within the loop. */
  talkClock(ms: number): string;
  seek(ms: number): void;
  /** Move by `deltaMs` from the playhead (negative: back). */
  seekBy(deltaMs: number): void;
  goLive(): void;
  openTab(tab: PanelTab): void;
  togglePlay(): void;
  addBookmark(): void;
  announce(message: string): void;
}

export const PlayerContext = createContext<PlayerCtx | null>(null);

export function usePlayer(): PlayerCtx {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer outside <Player>");
  return ctx;
}
