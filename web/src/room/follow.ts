// Which agent instance to follow, and which of its snapshots are new. Transport-free; mirrors
// agents/src/talk_tracks/follow.py.
//
// Every agent process publishes under a fresh path named by its start time in ms
// (talk/<room>/agents/<agent>/<instance>). A replacement always has a larger number than the one it
// replaces, and a killed process's broadcast can linger on the relay for seconds: following the
// newest numeric instance that is still announced handles both.

import type { LegacyEnvelope as Envelope } from "../contracts/types";

export function instanceNumber(instance: string): number | null {
  return /^\d+$/.test(instance) ? Number(instance) : null;
}

/** The newest numeric instance among those announced, or undefined when none is. */
export function newestInstance(instances: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestNumber = -1;
  for (const instance of instances) {
    const n = instanceNumber(instance);
    if (n !== null && n > bestNumber) {
      best = instance;
      bestNumber = n;
    }
  }
  return best;
}

/** Split `<agent>/<instance>` (relative to the agents prefix); null for anything else. */
export function parseAgentPath(path: string): { agent: string; instance: string } | null {
  const parts = path.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { agent: parts[0], instance: parts[1] };
}

/** Lets through each state change of the followed instance once; heartbeats repeat a seq. */
export class SnapshotFilter {
  #instance: string | undefined;
  #seq = -1;

  /** "new" for a state change, "heartbeat" for a repeat, "other" for another instance or an old seq. */
  accept(envelope: Envelope, followed: string | undefined): "new" | "heartbeat" | "other" {
    if (envelope.instance !== followed) return "other";
    if (envelope.instance !== this.#instance) {
      this.#instance = envelope.instance;
      this.#seq = -1;
    }
    if (envelope.seq === this.#seq) return "heartbeat";
    if (envelope.seq < this.#seq) return "other";
    this.#seq = envelope.seq;
    return "new";
  }
}
