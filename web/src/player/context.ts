// What every part of the player reads: the playback and its view, the device preferences, the player
// state, the frame clock and the UI state (open menu, panel tab). One context instead of a prop chain.

import { createContext, type ReactNode, useContext } from "react";
import type { RoomService } from "../annotate/client";
import type { RoomMedia } from "../playback/media";
import type { Playback, PlaybackView } from "../playback/playback";
import type { Transport } from "../transport/types";
import type { FrameClock } from "./frameClock";
import type { RoomMediaElement } from "./roomMediaElement";
import type { Listening } from "./listening";
import type { NotesApi } from "./notes";
import type { PanelTab, Prefs, SourceKind } from "./prefs";
import type { ScreenMedia } from "./screenMedia";
import type { SlideTracks } from "./slideTracks";
import type { PlayerState } from "./state";
import type { RoomTracks } from "./tracks";

export type MenuKind = "cc" | "layout";

export interface UiState {
  menu: MenuKind | undefined;
  stats: boolean;
  shortcuts: boolean;
  /** Transcript search text. */
  search: string;
  /** Bumped to move focus into the transcript search or the note box. */
  focusSearch: number;
  focusNote: number;
  /** The media element plays (Media Chrome's paused state, mirrored for the stage). */
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
  /** The speaker's shared screen, live and rewound; undefined in the offline demo. */
  screen?: ScreenMedia | undefined;
  roomName: string;
  title: string;
  tracks: RoomTracks;
  /** The prefs as they apply in this room (tracks.roomSubtitles). */
  prefs: Prefs;
  /** The remembered translation this room does not carry over unasked (a paid one picked elsewhere): offered. */
  carried?: string | undefined;
  update: (change: Partial<Prefs> | ((p: Prefs) => Partial<Prefs>)) => void;
  ui: UiState;
  setUi: (change: Partial<UiState> | ((u: UiState) => Partial<UiState>)) => void;
  state: PlayerState;
  clock: FrameClock;
  notes: NotesApi;
  /** What the speaker sends at the frame shown (camera, slides, a shared screen); Stage lays out stageSources(sources). */
  sources: SourceKind[];
  /**
   * The room has not said yet what it sends: the stage draws no picture until it has, so the camera never opens full
   * size and then jumps to its corner once the slides turn up (a layout shift).
   */
  sourcesPending: boolean;
  /** The speaker's slide tracks, the audience's annotations and the room's state; undefined with no relay. */
  slides: SlideTracks | undefined;
  /** The slides are on screen in the current layout, so their tracks are subscribed (decision 0010). */
  slidesShown: boolean;
  /** The audience's ink, marks and comment marks are shown (and subscribed): the Discussion tab or the tools are open. */
  audienceShown: boolean;
  /** The number of the slide on screen at the playhead (1-based), from the slide track or the descriptions. */
  slideNumber: number | undefined;
  extraTabs: ExtraTab[];
  /** The listener's tools and the room service's session (decision 0024); undefined where nobody can write. */
  listening: Listening | undefined;
  /** The room service's session for the chat; set even where the listener tools are off (a looped demo room). */
  roomService: RoomService | undefined;
  /** A demo room: a live session of a recorded lecture (decision 0032; the old name kept). */
  looped: boolean;
  /** A recording (`<id>-recording`, decision 0032): video on demand, with nobody in the room to chat with. */
  vod?: boolean;
  /** The playhead for display, room ms (live: the live position). */
  at: number | undefined;
  /** A room time as the talk's clock shows it ("12:34"); in a demo session or loop, the time since its start. */
  talkClock(ms: number): string;
  /** Room ms of the talk clock's 00:00 (a demo session's start; 0 in other rooms). */
  origin: number;
  /** The media element Media Chrome drives, once mounted. */
  element(): RoomMediaElement | null;
  seek(ms: number): void;
  /** Move by `deltaMs` from the playhead (negative: back). */
  seekBy(deltaMs: number): void;
  goLive(): void;
  openTab(tab: PanelTab): void;
  /** Keep these tracks subscribed (a download gathering them) until the returned release is called. */
  holdTracks(ids: readonly string[]): () => void;
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
