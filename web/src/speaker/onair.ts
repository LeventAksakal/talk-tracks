import type { ConnectionStatus } from "../transport/types";

/** How long to wait for the relay to show our broadcast before calling the publish refused. */
export const CONFIRM_TIMEOUT_MS = 10_000;

export type MicState = "off" | "starting" | "publishing" | "error";

export type OnAir =
  | { kind: "off" }
  | { kind: "starting" }
  | { kind: "confirming"; occupied: boolean }
  | { kind: "on-air" }
  | { kind: "refused"; reason: string }
  | { kind: "error"; reason: string };

/**
 * Whether the speaker is on air. A refused browser publish is silent, so "on air" needs proof: a
 * second, anonymous connection (a viewer's view of the relay) must see the teacher broadcast
 * announced after this console started publishing.
 */
export function onAirState(input: {
  mic: MicState;
  micError?: string;
  publisherStatus: ConnectionStatus;
  publisherError?: string;
  /** Announced on the relay, as the anonymous watcher sees it. */
  teacherLive: boolean;
  /** Whether the watcher saw a (re)announcement since publishing started. */
  announcedSinceStart: boolean;
  /** Whether a teacher broadcast was already announced when publishing started. */
  liveAtStart: boolean;
  elapsedMs: number;
}): OnAir {
  if (input.mic === "off") return { kind: "off" };
  if (input.mic === "error") return { kind: "error", reason: input.micError ?? "The microphone could not start." };
  if (input.publisherStatus === "failed") {
    return { kind: "error", reason: input.publisherError ?? "The relay refused the connection. Check the token." };
  }
  if (input.mic === "starting") return { kind: "starting" };
  if (input.teacherLive && input.announcedSinceStart) return { kind: "on-air" };
  if (input.elapsedMs >= CONFIRM_TIMEOUT_MS) {
    return {
      kind: "refused",
      reason: input.liveAtStart
        ? "Another speaker is already on air in this room, and the relay has not taken this broadcast."
        : "The relay has not shown this broadcast. A missing, wrong or expired token is refused silently.",
    };
  }
  return { kind: "confirming", occupied: input.liveAtStart };
}
