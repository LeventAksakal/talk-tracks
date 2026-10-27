// The one seam between the app and Media over QUIC. Stores and components depend on this interface
// only; MoqTransport implements it over @moq/net, FakeTransport in memory (tests and /demo).

/** A broadcast path under a watched prefix was announced (active) or withdrawn. */
export interface AnnounceEvent {
  /** Path relative to the watched prefix, without leading slash. Empty for the prefix itself. */
  path: string;
  active: boolean;
}

/** One object (frame) received on a track. Agent tracks carry one object per group. */
export interface TrackObject {
  group: number;
  payload: Uint8Array;
  /** Local wall-clock arrival time, ms since the epoch. */
  receivedAt: number;
}

export interface Closable {
  close(): void;
}

export interface SubscribeOptions {
  /**
   * How old (ms) a non-latest group may be and still be delivered. 0 takes only the live edge;
   * audio wants about 500 ms.
   */
  maxAgeMs?: number;
}

/** A track this page publishes into. Each write is one group holding one object. */
export interface TrackWriter extends Closable {
  write(payload: Uint8Array): void;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "failed";

export interface Transport extends Closable {
  readonly kind: "moq" | "fake";
  /** Paths announced under `prefix`, as they come and go. Current ones are reported first. */
  announced(prefix: string, onEvent: (event: AnnounceEvent) => void): Closable;
  /**
   * Objects of `track` on broadcast `path`. Survives the broadcast being withdrawn and announced
   * again; a broken group is skipped, never the end of the track.
   */
  subscribe(path: string, track: string, onObject: (object: TrackObject) => void, options?: SubscribeOptions): Closable;
  /** Publish `track` on broadcast `path` (announced on the first call for that path). */
  publish(path: string, track: string): TrackWriter;
  /** Connection status, and a listener for changes. */
  status(): ConnectionStatus;
  onStatus(listener: (status: ConnectionStatus, error?: Error) => void): Closable;
}
