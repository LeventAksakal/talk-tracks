// The room's chat as the player reads it (ticket 0021): talk/<room>/chat `chat`, one track the room service publishes.
// Opening the chat subscribes to it and closing unsubscribes (decision 0026: a panel is a subscription). Live, the
// latest group's carry-in brings the last 50 messages (the history on open) and every later object one message.
// Rewound, the group of the playhead is fetched and shown up to it, so a replay shows the chat where it was said.
// Group semantics: wiki/design/container-formats.md, "talk/R/chat".

import { CHAT_TRACK, chatPath } from "../contracts/names";
import { chatMessages, upTo } from "../contracts/tracks";
import type { ChatRecord } from "../contracts/types";
import { parseChatObject } from "../contracts/validate";
import { NotFound, type HistorySource } from "../playback/source";
import type { Closable } from "../transport/types";

/** A slice of room time: chat group k covers [k·4 s, (k+1)·4 s). */
const SLICE_MS = 4_000;
/** The latest group is on its way after subscribing; before this, the chat is "loading", not empty. */
const JOIN_GRACE_MS = 1_500;
/** A FETCH with no answer by then counts as not found (moq-relay 0.17.8 may never answer one). */
const FETCH_TIMEOUT_MS = 3_000;
/** Messages kept from the live subscription; older ones are still in the archive. */
const KEEP_LIVE = 500;
const PRIORITY = 120;

export type ChatPhase =
  /** Subscribed; the latest group has not come yet. */
  | "loading"
  /** The messages so far (possibly none: the chat starts from now). */
  | "ready";

export interface ChatView {
  phase: ChatPhase;
  /** Messages in effect at the playhead (live: all so far), oldest first. */
  messages: readonly ChatRecord[];
}

const sliceOf = (t: number) => Math.floor(Math.max(0, t) / SLICE_MS);

interface Fetched {
  state: "loading" | "found" | "missing";
  records: ChatRecord[][];
}

export interface ChatFeedOptions {
  now?: () => number;
  fetchTimeoutMs?: number;
}

/**
 * One room's chat track. `open` subscribes (the chat drawer opened), `close` unsubscribes; `setTime` says where the
 * playhead is, live or rewound; `view` is what to show. Change listeners for React (`subscribe`, `getVersion`).
 */
export class ChatFeed {
  readonly room: string;
  #source: HistorySource;
  #now: () => number;
  #fetchTimeout: number;
  #sub: Closable | undefined;
  #openedAt = 0;
  #seen = false;
  #live: ChatRecord[] = [];
  #groups = new Map<number, ChatRecord[][]>();
  #fetched = new Map<number, Fetched>();
  #inFlight = new Map<number, AbortController>();
  #t: number | undefined;
  #rewound = false;
  #listeners = new Set<() => void>();
  #version = 0;
  #graceTimer: ReturnType<typeof setTimeout> | undefined;
  #view: ChatView = { phase: "loading", messages: [] };

  constructor(source: HistorySource, room: string, options: ChatFeedOptions = {}) {
    this.room = room;
    this.#source = source;
    this.#now = options.now ?? Date.now;
    this.#fetchTimeout = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getVersion = (): number => this.#version;

  /** Whether the chat track is subscribed now. */
  get open(): boolean {
    return this.#sub !== undefined;
  }

  /** The chat drawer opened: one live subscription, from the latest group (its carry-in is the history). */
  start(): void {
    if (this.#sub) return;
    this.#openedAt = this.#now();
    this.#seen = false;
    this.#sub = this.#source.subscribe(
      chatPath(this.room),
      CHAT_TRACK,
      (o) => this.#onLive(o.group, o.index, o.payload),
      {
        priority: PRIORITY,
      },
    );
    clearTimeout(this.#graceTimer);
    this.#graceTimer = setTimeout(() => this.#changed(), JOIN_GRACE_MS + 10);
    this.#plan();
    this.#changed();
  }

  /** The chat drawer closed: unsubscribe, and drop what was held (the next open starts from the latest group). */
  stop(): void {
    this.#sub?.close();
    this.#sub = undefined;
    clearTimeout(this.#graceTimer);
    for (const c of this.#inFlight.values()) c.abort();
    this.#inFlight.clear();
    this.#live = [];
    this.#groups.clear();
    this.#fetched.clear();
    this.#changed();
  }

  /** The playhead: `t` room ms (undefined: live, nothing playing yet), rewound or at the live edge. */
  setTime(t: number | undefined, rewound: boolean): void {
    const before = this.#rewound ? (this.#t === undefined ? "" : sliceOf(this.#t)) : "live";
    this.#t = t;
    this.#rewound = rewound && t !== undefined;
    const after = this.#rewound ? sliceOf(t!) : "live";
    if (before !== after) this.#plan();
    if (this.#rewound || before !== after) this.#changed();
  }

  /** What to show at the playhead. */
  view(): ChatView {
    return this.#view;
  }

  // --- live ---------------------------------------------------------------------------------------------------

  #onLive(group: number, index: number, payload: Uint8Array): void {
    if (!this.#sub) return;
    const parsed = parseChatObject(payload);
    if (!parsed.ok) {
      console.warn(`dropping a chat object that does not match the contract: ${parsed.error}`);
      return;
    }
    this.#seen = true;
    const objects = this.#groups.get(group) ?? [];
    objects[index] = parsed.value;
    this.#groups.set(group, objects);
    // The live list: every message once, the newest KEEP_LIVE; the carry-in repeats ones already held.
    this.#live = chatMessages([...this.#live, ...parsed.value]).slice(-KEEP_LIVE);
    for (const k of [...this.#groups.keys()]) if (k < group - 2) this.#groups.delete(k);
    this.#changed();
  }

  // --- rewound: the group of the playhead -----------------------------------------------------------------------

  #plan(): void {
    if (!this.#sub || !this.#rewound || this.#t === undefined) return;
    const k = sliceOf(this.#t);
    for (const [g, c] of this.#inFlight) {
      if (g !== k) {
        c.abort();
        this.#inFlight.delete(g);
        if (this.#fetched.get(g)?.state === "loading") this.#fetched.delete(g);
      }
    }
    if (this.#groups.has(k) || this.#fetched.has(k)) return;
    void this.#fetch(k);
  }

  async #fetch(k: number): Promise<void> {
    const controller = new AbortController();
    this.#inFlight.set(k, controller);
    this.#fetched.set(k, { state: "loading", records: [] });
    this.#changed();
    const timer = setTimeout(() => controller.abort(), this.#fetchTimeout);
    let result: Fetched;
    try {
      const objects = await this.#source.fetchGroup(chatPath(this.room), CHAT_TRACK, k, {
        priority: PRIORITY,
        signal: controller.signal,
      });
      const records: ChatRecord[][] = [];
      for (const payload of objects) {
        const parsed = parseChatObject(payload);
        records.push(parsed.ok ? parsed.value : []);
      }
      result = { state: "found", records };
    } catch (e) {
      if (controller.signal.aborted && this.#inFlight.get(k) !== controller) return; // superseded by a seek
      result = { state: "missing", records: [] };
      if (!(e instanceof NotFound) && !controller.signal.aborted) console.warn("fetching the chat failed", e);
    } finally {
      clearTimeout(timer);
    }
    if (this.#inFlight.get(k) !== controller || !this.#sub) return;
    this.#inFlight.delete(k);
    this.#fetched.set(k, result);
    this.#changed();
  }

  // --- the view -------------------------------------------------------------------------------------------------

  #compute(): ChatView {
    if (!this.#sub) return { phase: "loading", messages: [] };
    if (!this.#rewound || this.#t === undefined) {
      const waiting = !this.#seen && this.#now() - this.#openedAt < JOIN_GRACE_MS;
      return { phase: waiting ? "loading" : "ready", messages: this.#live };
    }
    const t = this.#t;
    const k = sliceOf(t);
    const held = this.#groups.get(k);
    if (held) return { phase: "ready", messages: chatMessages(upTo(held.filter(Boolean), t)) };
    const fetched = this.#fetched.get(k);
    if (!fetched || fetched.state === "loading") return { phase: "loading", messages: this.#view.messages };
    return { phase: "ready", messages: chatMessages(upTo(fetched.records, t)) };
  }

  #changed(): void {
    const next = this.#compute();
    const same =
      next.phase === this.#view.phase &&
      next.messages.length === this.#view.messages.length &&
      next.messages.every((r, i) => r === this.#view.messages[i]);
    if (same) return;
    this.#view = next;
    this.#version++;
    for (const l of [...this.#listeners]) l();
  }
}

// --- a name for a listener who has not chosen one (no accounts, brand.md §6) -----------------------------------------

const ADJECTIVES = [
  "Amber",
  "Brave",
  "Bright",
  "Calm",
  "Clever",
  "Curious",
  "Eager",
  "Gentle",
  "Happy",
  "Keen",
  "Lively",
  "Lucky",
  "Merry",
  "Nimble",
  "Quiet",
  "Quick",
  "Sunny",
  "Swift",
  "Witty",
  "Zesty",
];
const ANIMALS = [
  "Badger",
  "Crane",
  "Dolphin",
  "Falcon",
  "Fox",
  "Gecko",
  "Heron",
  "Ibis",
  "Koala",
  "Lynx",
  "Marmot",
  "Otter",
  "Owl",
  "Panda",
  "Puffin",
  "Quokka",
  "Robin",
  "Seal",
  "Tapir",
  "Wren",
];

/** A random display name such as "Curious Otter", which the listener may change. */
export function randomName(random: () => number = Math.random): string {
  const pick = (list: readonly string[]) => list[Math.floor(random() * list.length) % list.length]!;
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}
