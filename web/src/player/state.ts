// The player states of ui-design §5: what the time display says and what the canvas shows, from the
// connection, the speaker and the playhead. Every state has a word, not only a colour.

import type { Mode } from "../playback/aiTracks";
import type { ConnectionStatus } from "../transport/types";
import type { RoomStateKind } from "./slideTracks";
import { formatBehind } from "./timeline";

export type PlayerStateKind =
  "connecting" | "not-started" | "live" | "behind" | "paused" | "ended" | "reconnecting" | "failed";

export const PLAYER_STATES: readonly PlayerStateKind[] = [
  "connecting",
  "not-started",
  "live",
  "behind",
  "paused",
  "ended",
  "reconnecting",
  "failed",
];

export interface PlayerStateInput {
  connection: ConnectionStatus | undefined;
  /** The connection was up at least once (so a drop is a reconnect, not a first connect). */
  everConnected: boolean;
  /** The speaker is on air; undefined when unknown. */
  onAir: boolean | undefined;
  /**
   * The room service's room state now, once the room track is read (decision 0017). It decides on air, paused,
   * ended and not started over the media's own guess.
   */
  room?: RoomStateKind;
  /** Rewound: the room's state at the playhead (a stretch nobody published reads as paused). */
  roomAt?: RoomStateKind;
  mode: Mode;
  liveEdge: number | undefined;
  behindMs: number;
  /** Live over WebSocket (the slower path). */
  slowerPath?: boolean;
  speaker?: string;
}

export interface PlayerState {
  kind: PlayerStateKind;
  /** The pill beside the time: "LIVE", "−4:30", "Paused", … */
  pill: string;
  /** The pill is a Go live button. */
  canGoLive: boolean;
  /** A card over the canvas, when the state needs one. */
  card?: { title: string; body: string; retry?: boolean; replay?: boolean; dim?: boolean };
}

/**
 * The inputs that put a room in state `kind`, laid over the real ones: the offline demo previews every state
 * (`/demo?state=paused`) for screenshots and judges. "live" and "behind" come from the real playhead.
 */
export function forcedInput(kind: PlayerStateKind): Partial<PlayerStateInput> {
  switch (kind) {
    case "connecting":
      return { connection: "connecting", everConnected: false };
    case "reconnecting":
      return { connection: "connecting", everConnected: true };
    case "failed":
      return { connection: "failed" };
    case "not-started":
      return { room: "waiting" };
    case "paused":
      return { room: "paused", mode: "live" };
    case "ended":
      return { room: "ended" };
    default:
      return {};
  }
}

export function playerState(input: PlayerStateInput): PlayerState {
  const { connection, mode } = input;
  if (connection === "failed")
    return {
      kind: "failed",
      pill: "Offline",
      canGoLive: false,
      card: { title: "Offline", body: "Lost the connection.", retry: true },
    };
  if (connection !== undefined && connection !== "connected") {
    return input.everConnected
      ? {
          kind: "reconnecting",
          pill: "Reconnecting…",
          canGoLive: false,
          card: { title: "Reconnecting…", body: "Holding the last frame. Nothing you set is lost.", dim: true },
        }
      : { kind: "connecting", pill: "Connecting…", canGoLive: false, card: { title: "Connecting…", body: "" } };
  }
  if (connection === undefined)
    return { kind: "connecting", pill: "Connecting…", canGoLive: false, card: { title: "Connecting…", body: "" } };

  const ended = input.room !== undefined ? input.room === "ended" : input.onAir === false && input.liveEdge !== undefined;
  // Rewound into a stretch where the speaker had paused (or nobody published): say so over that moment.
  const pausedThen =
    mode === "rewound" && (input.roomAt === "paused" || input.roomAt === "waiting")
      ? {
          title: input.roomAt === "waiting" ? "Not started yet here" : "Paused here",
          body: "The speaker was not on air at this point. Seek on, or go live.",
          dim: true,
        }
      : undefined;
  if (mode === "rewound" && !ended)
    return { kind: "behind", pill: formatBehind(input.behindMs), canGoLive: true, card: pausedThen };
  if (ended)
    return mode === "rewound"
      ? { kind: "ended", pill: "Ended", canGoLive: false, card: pausedThen }
      : {
          kind: "ended",
          pill: "Ended",
          canGoLive: false,
          card: { title: "The talk has ended", body: "The whole recording can be replayed.", replay: true },
        };
  if (input.room === "paused")
    return {
      kind: "paused",
      pill: "Paused",
      canGoLive: false,
      card: { title: "Paused by the speaker", body: "The talk carries on when the speaker comes back.", dim: true },
    };
  if (input.room === "waiting" || (input.room === undefined && input.onAir !== true && input.liveEdge === undefined))
    return {
      kind: "not-started",
      pill: "Not started",
      canGoLive: false,
      card: {
        title: "Not started",
        body: `Starts when ${input.speaker ?? "the speaker"} goes on air. You can pick subtitles and features now.`,
      },
    };
  return { kind: "live", pill: input.slowerPath ? "LIVE · WebSocket" : "LIVE", canGoLive: false };
}
