import type { ConnectionStatus } from "../transport/types";

/** How long to wait for the relay to carry our microphone before calling the publish refused. */
export const CONFIRM_TIMEOUT_MS = 10_000;
/** Our own audio must have come back through the relay this recently to count as on air. */
export const FRESH_AUDIO_MS = 3_000;
/** Media times within this distance of our own clock are taken to be our own frames. */
export const OWN_CLOCK_TOLERANCE_MS = 5_000;

export type MicState = "off" | "starting" | "publishing" | "error";

export type OnAir =
  | { kind: "off" }
  | { kind: "starting" }
  | { kind: "confirming"; occupied: boolean }
  | { kind: "on-air" }
  | { kind: "refused"; reason: string }
  | { kind: "error"; reason: string };

/** QUIC variable-length integer at the start of `bytes`: [value, bytes used]. */
export function readVarint(bytes: Uint8Array): [number, number] {
  const first = bytes[0];
  if (first === undefined) throw new RangeError("empty varint");
  const length = 1 << (first >> 6);
  if (bytes.length < length) throw new RangeError("truncated varint");
  let value = first & 0x3f;
  for (let i = 1; i < length; i++) value = value * 256 + bytes[i]!;
  return [value, length];
}

/**
 * Whether a frame of the speaker's audio track (legacy container: a varint media time in µs, then
 * the Opus packet) was published by this page. @moq/publish stamps audio with performance.now(), so
 * our own frames carry media times close to our own clock; another page's frames do not.
 */
export function isOwnAudio(payload: Uint8Array, nowMs: number): boolean {
  try {
    const [us] = readVarint(payload);
    return Math.abs(us / 1000 - nowMs) < OWN_CLOCK_TOLERANCE_MS;
  } catch {
    return false;
  }
}

/**
 * Whether the speaker is on air. A refused browser publish is silent, and a broadcast from an
 * earlier page load can linger on the relay, so "on air" needs proof: a second, anonymous
 * connection (a viewer's view of the relay) must be receiving this page's own audio frames.
 */
export function onAirState(input: {
  mic: MicState;
  micError?: string;
  publisherStatus: ConnectionStatus;
  publisherError?: string;
  /** ms since the anonymous watcher last received one of our own audio frames; undefined if never. */
  ownAudioAgoMs: number | undefined;
  /** Whether the watcher received fresh audio from someone else's page on the same path. */
  otherSpeaker: boolean;
  elapsedMs: number;
}): OnAir {
  if (input.mic === "off") return { kind: "off" };
  if (input.mic === "error") return { kind: "error", reason: input.micError ?? "The microphone could not start." };
  if (input.publisherStatus === "failed") {
    return { kind: "error", reason: input.publisherError ?? "The relay refused the connection. Check the token." };
  }
  if (input.mic === "starting") return { kind: "starting" };
  if (input.ownAudioAgoMs !== undefined && input.ownAudioAgoMs < FRESH_AUDIO_MS) return { kind: "on-air" };
  if (input.elapsedMs >= CONFIRM_TIMEOUT_MS) {
    const reason = input.otherSpeaker
      ? "Another speaker is on air in this room, and the relay is carrying their audio, not yours."
      : input.ownAudioAgoMs !== undefined
        ? "The relay stopped carrying your microphone."
        : "The relay is not carrying your microphone. A missing, wrong or expired token is refused silently.";
    return { kind: "refused", reason };
  }
  return { kind: "confirming", occupied: input.otherSpeaker };
}
