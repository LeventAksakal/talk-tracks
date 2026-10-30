// What every part of the player reads: the playback and its view, the device preferences, the player
// state, the frame clock and the UI state (open menu, panel tab). One context instead of a prop chain.

import { createContext, type ReactNode, useContext } from "react";
import type { RoomMedia } from "../playback/media";
import type { Playback, PlaybackView } from "../playback/playback";
import type { Transport } from "../transport/types";
import type { FrameClock } from "./frameClock";
import type { NotesApi } from "./notes";
import type { PanelTab, Prefs, SourceKind } from "./prefs";
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
  extraTabs: ExtraTab[];
  /** The playhead for display, room ms (live: the live position). */
  at: number | undefined;
  seek(ms: number): void;
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
