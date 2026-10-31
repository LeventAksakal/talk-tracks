// The room service's write endpoint for listeners and the speaker (decision 0024): one WebSocket per browser on
// /api/rooms/<room>. Listeners never publish to the relay; what they draw, mark and comment goes here, and comes
// back to everyone on the room service's tracks (talk/<room>/annotations, talk/<room>/comments). The same socket
// carries the room's threads for the Discussion tab and the console's question list. Protocol: the module
// docstring of agents/src/talk_tracks/archive/listeners.py.

import { commentThreads } from "../contracts/tracks";
import type { CommentRecord } from "../contracts/types";

export type WriteTrack = "ink" | "marks" | "comments";

/** Who this browser is in the room: an id the room service gave it (or "speaker"), a display name. */
export interface Me {
  id: string;
  /** Null until the listener chose one (writes need it). */
  name: string | null;
  speaker: boolean;
}

export type ServiceStatus = "connecting" | "open" | "waiting" | "closed" | "refused";

/** A write that went out: its room time, and a new comment's or reply's id. */
export interface Ack {
  m: number;
  id?: string;
}

export type ErrorCode = "invalid" | "forbidden" | "not-live" | "limit" | "rate" | "name" | "closed";

export class WriteError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** What the player and the console use; the WebSocket client below, or a fake in tests. */
export interface RoomService {
  status(): ServiceStatus;
  me(): Me | undefined;
  /** Every comment and reply shown now, edits applied, hidden ones left out, in the order they were made. */
  threads(): readonly CommentRecord[];
  /** Room time now, as the service last said, moved on by the local clock; undefined before it said. */
  now(): number | undefined;
  /** Change listener for status, me and threads. */
  subscribe(listener: () => void): () => void;
  version(): number;
  setName(name: string): void;
  /** One record's data without `by` (a new comment or reply also without `id` and `at`); `at`: a replay's playhead. */
  write(track: WriteTrack, data: object, at?: number): Promise<Ack>;
  close(): void;
}

/** What a browser keeps so its strokes stay its own across reloads (no account). */
export interface Identity {
  id?: string;
  key?: string;
  name?: string;
}

export const IDENTITY_KEY = "tt.listener.v1";

export function readIdentity(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): Identity {
  try {
    const raw = storage?.getItem(IDENTITY_KEY);
    const v: unknown = raw ? JSON.parse(raw) : {};
    if (!v || typeof v !== "object") return {};
    const o = v as Record<string, unknown>;
    const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);
    return { id: str(o.id), key: str(o.key), name: str(o.name) };
  } catch {
    return {};
  }
}

export function writeIdentity(identity: Identity, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // private mode or storage full: the next visit is a new listener
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The endpoint's base URL: VITE_ROOM_SERVICE_URL, else :8091 on this host in development, else /api/ here. */
export function roomServiceBase(): string {
  const env = import.meta.env.VITE_ROOM_SERVICE_URL as string | undefined;
  if (env) return env.endsWith("/") ? env : `${env}/`;
  const secure = location.protocol === "https:";
  if (import.meta.env.DEV) return `ws://${location.hostname}:8091/api/`;
  return `${secure ? "wss" : "ws"}://${location.host}/api/`;
}

export interface ClientOptions {
  /** The speaker's relay token: the session is the speaker's. */
  token?: string;
  /** The speaker's display name. */
  name?: string;
  /** Receive the threads and every new comment record. */
  comments?: boolean;
  /** Keep the identity here (listeners only); default localStorage. */
  storage?: Pick<Storage, "getItem" | "setItem">;
  /** For tests. */
  socket?: (url: string) => WebSocketLike;
  now?: () => number;
  /** First reconnect delay; doubles to 30 s. */
  retryMs?: number;
}

/** The part of WebSocket the client uses. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

const OPEN = 1;
const MAX_RETRY_MS = 30_000;

type Pending = { resolve: (a: Ack) => void; reject: (e: WriteError) => void };

/**
 * One room's endpoint session. Connects at once and reconnects with backoff (the room service may not hold the
 * room until the speaker starts). Writes made while not open fail with code "closed"; a stroke in progress is
 * then lost, like a dropped pen.
 */
export class RoomServiceClient implements RoomService {
  readonly url: string;
  #opts: ClientOptions;
  #ws: WebSocketLike | undefined;
  #status: ServiceStatus = "connecting";
  #me: Me | undefined;
  #records: CommentRecord[] = [];
  #threads: readonly CommentRecord[] = [];
  #nowAt: { room: number; local: number } | undefined;
  #seq = 0;
  #pending = new Map<number, Pending>();
  #listeners = new Set<() => void>();
  #version = 0;
  #retry: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #identity: Identity;

  constructor(base: string, room: string, options: ClientOptions = {}) {
    this.url = `${base}rooms/${encodeURIComponent(room)}`;
    this.#opts = options;
    this.#retry = options.retryMs ?? 2_000;
    this.#identity = options.token ? { name: options.name || "Speaker" } : readIdentity(options.storage);
    this.#connect();
  }

  status = (): ServiceStatus => this.#status;
  me = (): Me | undefined => this.#me;
  threads = (): readonly CommentRecord[] => this.#threads;
  version = (): number => this.#version;

  now = (): number | undefined => {
    if (!this.#nowAt) return undefined;
    return this.#nowAt.room + (this.#clock() - this.#nowAt.local);
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  setName(name: string): void {
    const clean = name.trim().slice(0, 60);
    if (!clean) return;
    this.#identity = { ...this.#identity, name: clean };
    if (!this.#opts.token) writeIdentity(this.#identity, this.#opts.storage);
    if (this.#me) this.#me = { ...this.#me, name: clean };
    if (this.#status === "open") this.#send({ type: "name", name: clean });
    this.#changed();
  }

  write(track: WriteTrack, data: object, at?: number): Promise<Ack> {
    if (this.#status !== "open" || !this.#ws) {
      return Promise.reject(new WriteError("closed", "Not connected to the room service"));
    }
    if (!this.#me?.name) return Promise.reject(new WriteError("name", "Choose a display name first"));
    const seq = ++this.#seq;
    return new Promise<Ack>((resolve, reject) => {
      this.#pending.set(seq, { resolve, reject });
      this.#send({ type: "write", seq, track, data, ...(at === undefined ? {} : { at: Math.round(at) }) });
    });
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#ws?.close();
    this.#ws = undefined;
    this.#fail("closed", "Closed");
    this.#setStatus("closed");
    this.#listeners.clear();
  }

  // --- connection ------------------------------------------------------------------------------------------------

  #clock(): number {
    return (this.#opts.now ?? Date.now)();
  }

  #connect(): void {
    if (this.#closed) return;
    this.#setStatus(this.#status === "waiting" ? "waiting" : "connecting");
    let ws: WebSocketLike;
    try {
      ws = this.#opts.socket ? this.#opts.socket(this.url) : (new WebSocket(this.url) as unknown as WebSocketLike);
    } catch {
      this.#later();
      return;
    }
    this.#ws = ws;
    ws.onopen = () => {
      const { id, key, name } = this.#identity;
      this.#send({
        type: "hello",
        ...(name ? { name } : {}),
        ...(this.#opts.token ? { token: this.#opts.token } : { ...(id ? { id } : {}), ...(key ? { key } : {}) }),
        ...(this.#opts.comments ? { comments: true } : {}),
      });
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        this.#onMessage(JSON.parse(ev.data) as Message);
      } catch {
        // not ours
      }
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = undefined;
      this.#fail("closed", "The connection to the room service dropped");
      if (this.#status !== "refused") this.#later();
    };
    ws.onerror = () => {};
  }

  #later(): void {
    if (this.#closed) return;
    if (this.#status === "open" || this.#status === "connecting") this.#setStatus("waiting");
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#connect(), this.#retry);
    this.#retry = Math.min(MAX_RETRY_MS, this.#retry * 2);
  }

  #onMessage(msg: Message): void {
    switch (msg.type) {
      case "welcome": {
        this.#me = { id: msg.id, name: msg.name ?? null, speaker: msg.speaker };
        if (typeof msg.now === "number") this.#nowAt = { room: msg.now, local: this.#clock() };
        if (!msg.speaker) {
          this.#identity = { ...this.#identity, id: msg.id, key: msg.key ?? this.#identity.key };
          writeIdentity(this.#identity, this.#opts.storage);
        }
        this.#retry = this.#opts.retryMs ?? 2_000;
        this.#setStatus("open");
        return;
      }
      case "threads":
        this.#records = [...msg.records];
        this.#threads = commentThreads(this.#records);
        this.#changed();
        return;
      case "comment":
        this.#records.push(msg.record);
        this.#threads = commentThreads(this.#records);
        this.#changed();
        return;
      case "name":
        if (this.#me) this.#me = { ...this.#me, name: msg.name };
        this.#changed();
        return;
      case "ack": {
        if (typeof msg.m === "number") this.#nowAt = { room: msg.m, local: this.#clock() };
        const p = msg.seq === null ? undefined : this.#pending.get(msg.seq);
        if (p) {
          this.#pending.delete(msg.seq!);
          p.resolve({ m: msg.m, ...(msg.id ? { id: msg.id } : {}) });
        }
        return;
      }
      case "error": {
        if (msg.seq === undefined || msg.seq === null) {
          // An answer to hello: the room is not held yet (try again later), or the speaker's link is refused.
          if (msg.code === "forbidden") {
            this.#setStatus("refused");
            this.#ws?.close();
          } else if (msg.code === "no-room") {
            this.#setStatus("waiting");
            this.#ws?.close();
          }
          return;
        }
        const p = this.#pending.get(msg.seq);
        if (p) {
          this.#pending.delete(msg.seq);
          p.reject(new WriteError(msg.code as ErrorCode, msg.message));
        }
        return;
      }
    }
  }

  #send(msg: object): void {
    if (this.#ws?.readyState === OPEN) this.#ws.send(JSON.stringify(msg));
  }

  #fail(code: ErrorCode, message: string): void {
    for (const p of this.#pending.values()) p.reject(new WriteError(code, message));
    this.#pending.clear();
  }

  #setStatus(s: ServiceStatus): void {
    if (s === this.#status) return;
    this.#status = s;
    this.#changed();
  }

  #changed(): void {
    this.#version++;
    for (const l of [...this.#listeners]) l();
  }
}

type Message =
  | { type: "welcome"; id: string; key?: string; name: string | null; speaker: boolean; now: number | null }
  | { type: "threads"; records: CommentRecord[] }
  | { type: "comment"; record: CommentRecord }
  | { type: "name"; name: string }
  | { type: "ack"; seq: number | null; m: number; id?: string }
  | { type: "error"; seq?: number | null; code: string; message: string };
