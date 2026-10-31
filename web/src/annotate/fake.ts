// A room service in memory, for tests: what the player and the console wrote, in order, and the room's threads,
// which a comment, reply or hide written here changes the way the real one does (agents archive/audience.py).

import { commentThreads } from "../contracts/tracks";
import type { Author, CommentData, CommentRecord } from "../contracts/types";
import type { Ack, Me, RoomService, ServiceStatus, WriteTrack } from "./client";
import { WriteError } from "./client";

export interface Written {
  track: WriteTrack;
  data: Record<string, unknown>;
  at?: number;
}

export class FakeRoomService implements RoomService {
  readonly writes: Written[] = [];
  #status: ServiceStatus;
  #me: Me | undefined;
  #records: CommentRecord[] = [];
  #threads: readonly CommentRecord[] = [];
  #listeners = new Set<() => void>();
  #version = 0;
  #now: number;
  #ids = 0;
  closed = false;

  constructor(options: { me?: Me; status?: ServiceStatus; now?: number; records?: CommentRecord[] } = {}) {
    this.#me = options.me ?? { id: "u1", name: null, speaker: false };
    this.#status = options.status ?? "open";
    this.#now = options.now ?? 0;
    if (options.records) this.push(...options.records);
  }

  status = (): ServiceStatus => this.#status;
  me = (): Me | undefined => this.#me;
  threads = (): readonly CommentRecord[] => this.#threads;
  now = (): number | undefined => this.#now;
  version = (): number => this.#version;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  setNow(m: number): void {
    this.#now = m;
  }

  setStatus(s: ServiceStatus): void {
    this.#status = s;
    this.#changed();
  }

  setName(name: string): void {
    if (this.#me) this.#me = { ...this.#me, name: name.trim() };
    this.#changed();
  }

  /** Records someone else wrote (or the room service re-sent), as the socket pushes them. */
  push(...records: CommentRecord[]): void {
    this.#records.push(...records);
    this.#threads = commentThreads(this.#records);
    this.#changed();
  }

  write(track: WriteTrack, data: object, at?: number): Promise<Ack> {
    if (this.#status !== "open") return Promise.reject(new WriteError("closed", "Not connected to the room service"));
    const me = this.#me;
    if (!me?.name) return Promise.reject(new WriteError("name", "Choose a display name first"));
    const fields = data as Record<string, unknown>;
    this.writes.push({ track, data: fields, ...(at === undefined ? {} : { at }) });
    const m = this.#now;
    if (track !== "comments") return Promise.resolve({ m });
    const by: Author = { id: me.id, name: me.name, ...(me.speaker ? { speaker: true } : {}) };
    const posted = fields.kind === "comment" || fields.kind === "reply";
    const id = posted ? `fake${++this.#ids}` : undefined;
    const record = {
      m,
      data: { ...fields, by, ...(posted ? { id, at: at === undefined ? m : Math.min(at, m) } : {}) } as CommentData,
    };
    this.push(record);
    return Promise.resolve({ m, ...(id ? { id } : {}) });
  }

  close(): void {
    this.closed = true;
    this.#listeners.clear();
  }

  #changed(): void {
    this.#version++;
    for (const l of [...this.#listeners]) l();
  }
}
