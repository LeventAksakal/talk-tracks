// What the playback layer needs from MoQ: announcements, one live SUBSCRIBE per track, and a one-group
// FETCH. MoqHistorySource implements it over @moq/net, FakeHistorySource in memory.

import type { AnnounceEvent, Closable } from "../transport/types";

/** One object of a group, with its index in the group (0 is a sliced track's carry-in). */
export interface GroupObject {
  group: number;
  index: number;
  payload: Uint8Array;
}

export interface LiveOptions {
  /** moq-lite subscription priority, 0..255, higher first. */
  priority: number;
}

export interface FetchOptions {
  priority: number;
  signal?: AbortSignal;
}

/** A FETCH that found nothing: the group was never produced, or is gone with its publisher. */
export class NotFound extends Error {
  constructor(message = "not found") {
    super(message);
    this.name = "NotFound";
  }
}

export interface HistorySource {
  /** Broadcast paths announced under `prefix`, relative to it; current ones first. */
  announced(prefix: string, onEvent: (event: AnnounceEvent) => void): Closable;
  /**
   * One live subscription to `track`. It follows the broadcast across re-announcements (a restarted
   * agent keeps its stable name). `close()` ends it on the wire, so the publisher stops being asked.
   */
  subscribe(path: string, track: string, onObject: (object: GroupObject) => void, options: LiveOptions): Closable;
  /** Every object of one group, in order. Rejects with NotFound when the group does not exist. */
  fetchGroup(path: string, track: string, group: number, options: FetchOptions): Promise<Uint8Array[]>;
}
