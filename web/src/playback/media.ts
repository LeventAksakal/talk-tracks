// The speaker's media on the room clock (design §4.5, §5.5): live through @moq/watch, rewound from the
// archive's HLS. Every position is room time: the wall time of a media timestamp − E. A room with no
// archived media still rewinds its AI tracks: the playhead then runs on a clock of its own, silent.

import { teacherPath } from "../contracts/names";
import type { Closable } from "../transport/types";
import type { MoqTransport } from "../transport/moq";
import type { Mode } from "./aiTracks";
import { type ArchivePlayback, archivedWallRanges, hlsUrl, openArchive } from "./hlsArchive";
import { type RoomCatalog, watchRoomCatalog } from "./roomCatalog";
import { type HangClock, hangClockOf, roomTimeOf, wallClockMs } from "./roomClock";
import type { Range } from "./slices";

export type MediaStatus =
  | "idle" // nothing started (a browser plays sound only after a tap)
  | "loading"
  | "playing"
  | "no-media"; // rewound with no archived media: AI tracks only

export interface SpeakerMedia {
  mode(): Mode;
  status(): MediaStatus;
  /** The playhead, room ms; undefined until something plays (live) or a seek (rewound). */
  position(): number | undefined;
  /** Best estimate of the live edge, room ms. */
  liveEdge(): number | undefined;
  /** Room time the archive can play. */
  available(): Range[];
  /** Room time the element holds. */
  buffered(): Range[];
  error(): string | undefined;
  seek(ms: number): void;
  goLive(): void;
  onChange(listener: () => void): () => void;
  close(): void;
}

class Listeners {
  #set = new Set<() => void>();
  add(fn: () => void): () => void {
    this.#set.add(fn);
    return () => this.#set.delete(fn);
  }
  emit(): void {
    for (const fn of [...this.#set]) fn();
  }
  clear(): void {
    this.#set.clear();
  }
}

/**
 * A playhead that runs on the wall clock. Rewound, it plays from the seek point; live, it follows the
 * edge it is told about. Used with no media at all (tests, the offline demo) and for rooms without
 * archived media.
 */
export class ClockMedia implements SpeakerMedia {
  #mode: Mode = "live";
  #now: () => number;
  #anchor: { media: number; wall: number } | undefined;
  #edge: { media: number; wall: number } | undefined;
  #status: MediaStatus;
  #listeners = new Listeners();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: { now?: () => number; tickMs?: number; status?: MediaStatus } = {}) {
    this.#now = options.now ?? Date.now;
    this.#status = options.status ?? "playing";
    const tick = options.tickMs ?? 250;
    if (tick > 0) this.#timer = setInterval(() => this.tick(), tick);
  }

  /** Tell listeners the playhead moved (on a timer in the app; tests call it). */
  tick(): void {
    this.#listeners.emit();
  }

  /** The live edge is at media time `ms` now; it advances with the wall clock from here. */
  setLiveEdge(ms: number): void {
    this.#edge = { media: ms, wall: this.#now() };
  }

  mode(): Mode {
    return this.#mode;
  }
  status(): MediaStatus {
    return this.#mode === "live" ? "playing" : this.#status;
  }
  position(): number | undefined {
    if (this.#mode === "live") return this.liveEdge();
    if (!this.#anchor) return undefined;
    const pos = this.#anchor.media + (this.#now() - this.#anchor.wall);
    const edge = this.liveEdge();
    return edge === undefined ? pos : Math.min(pos, edge);
  }
  liveEdge(): number | undefined {
    return this.#edge && this.#edge.media + (this.#now() - this.#edge.wall);
  }
  available(): Range[] {
    return [];
  }
  buffered(): Range[] {
    return [];
  }
  error(): string | undefined {
    return undefined;
  }
  seek(ms: number): void {
    this.#mode = "rewound";
    this.#anchor = { media: ms, wall: this.#now() };
    this.#listeners.emit();
  }
  goLive(): void {
    this.#mode = "live";
    this.#anchor = undefined;
    this.#listeners.emit();
  }
  onChange(listener: () => void): () => void {
    return this.#listeners.add(listener);
  }
  close(): void {
    clearInterval(this.#timer);
    this.#listeners.clear();
  }
}

export interface RoomMediaElements {
  /** Live video from @moq/watch is painted here. */
  canvas: HTMLCanvasElement;
  /** Archived media plays here. */
  video: HTMLVideoElement;
}

export interface RoomMediaOptions {
  now?: () => number;
  /** Where the archive is served over HTTP. */
  archiveBase?: string;
  fetchFn?: typeof fetch;
  /** How often the archive's playlist is read again for what it holds, ms. */
  refreshMs?: number;
}

/**
 * Live: the speaker broadcast through @moq/watch; its playhead is the wall time of the playing media
 * timestamp (the teacher catalog's root `clock`) − E. Rewound: the archive's HLS from the seek point,
 * mapped through PROGRAM-DATE-TIME. Go live closes the archive playback and starts the live one again.
 * It also holds the room catalog, which gives E and every track's L.
 */
export class RoomMedia implements SpeakerMedia {
  readonly room: string;
  #transport: MoqTransport;
  #now: () => number;
  #archiveUrl: string;
  #fetch: typeof fetch;
  #elements: RoomMediaElements | undefined;
  #mode: Mode = "live";
  #wantLive = false;
  #status: MediaStatus = "idle";
  #error: string | undefined;
  #listeners = new Listeners();
  #catalog: RoomCatalog | undefined;
  #teacherLive = false;
  /** The last live playhead seen (room ms), and when (this device's wall ms). */
  #lastLive: { room: number; wall: number } | undefined;
  #live: { close(): void } | undefined;
  #liveGeneration = 0;
  #archive: ArchivePlayback | undefined;
  #archiveGeneration = 0;
  /** Wall-time ranges the archive holds. */
  #archived: Range[] = [];
  /** A clock for rooms with no archived media. */
  #clock: ClockMedia | undefined;
  #subs: Closable[] = [];
  #timers: ReturnType<typeof setInterval>[] = [];
  #closed = false;

  constructor(transport: MoqTransport, room: string, options: RoomMediaOptions = {}) {
    this.room = room;
    this.#transport = transport;
    this.#now = options.now ?? Date.now;
    this.#archiveUrl = hlsUrl(room, options.archiveBase);
    this.#fetch = options.fetchFn ?? ((...args) => fetch(...args));
    this.#subs.push(
      watchRoomCatalog(transport, room, (catalog) => {
        this.#catalog = catalog;
        this.#listeners.emit();
      }),
      transport.announced(teacherPath(room), ({ path, active }) => {
        if (path === "") this.#teacherLive = active;
      }),
    );
    this.#timers.push(setInterval(() => this.#listeners.emit(), 250));
    this.#timers.push(setInterval(() => void this.#loadArchived(), options.refreshMs ?? 10_000));
    void this.#loadArchived();
  }

  /** The newest room catalog, once it has arrived. */
  catalog(): RoomCatalog | undefined {
    return this.#catalog;
  }

  /** Give the media its elements (from React refs). */
  attach(elements: RoomMediaElements | undefined): void {
    this.#elements = elements;
    if (elements && this.#mode === "live" && this.#wantLive) this.#startLive();
  }

  /** Start live playback (call from a tap: browsers start sound only after a user gesture). */
  play(): void {
    this.#wantLive = true;
    if (this.#mode === "live") this.#startLive();
    else void this.#archive?.element.play().catch(() => {});
  }

  /** Stop all sound, live or rewound; the mode stays. */
  stop(): void {
    this.#wantLive = false;
    this.#stopLive();
    this.#archive?.element.pause();
    this.#status = "idle";
    this.#listeners.emit();
  }

  mode(): Mode {
    return this.#mode;
  }
  status(): MediaStatus {
    return this.#status;
  }
  error(): string | undefined {
    return this.#error ?? this.#archive?.error;
  }

  position(): number | undefined {
    if (this.#mode === "rewound") return this.#clock ? this.#clock.position() : this.#toRoom(this.#archive?.position());
    return this.#lastLive && this.#live ? this.#lastLive.room : undefined;
  }

  liveEdge(): number | undefined {
    if (this.#lastLive) return this.#lastLive.room + (this.#live ? 0 : this.#now() - this.#lastLive.wall);
    // On air with no media playing here: room time now, as this device's clock has it.
    if (this.#teacherLive) return this.#toRoom(this.#now());
    return this.available().at(-1)?.end;
  }

  available(): Range[] {
    return this.#rangesToRoom(this.#archived);
  }

  buffered(): Range[] {
    return this.#rangesToRoom(this.#archive?.buffered() ?? []);
  }

  seek(ms: number): void {
    const edge = this.liveEdge();
    this.#mode = "rewound";
    this.#stopLive();
    this.#status = "loading";
    this.#listeners.emit();
    void this.#seekArchive(ms, edge);
  }

  goLive(): void {
    this.#mode = "live";
    this.#closeArchive();
    this.#clock?.close();
    this.#clock = undefined;
    this.#status = "idle";
    if (this.#wantLive) this.#startLive();
    this.#listeners.emit();
  }

  onChange(listener: () => void): () => void {
    return this.#listeners.add(listener);
  }

  close(): void {
    this.#closed = true;
    this.#timers.forEach(clearInterval);
    this.#subs.forEach((s) => s.close());
    this.#stopLive();
    this.#closeArchive();
    this.#clock?.close();
    this.#listeners.clear();
  }

  #toRoom(wallMs: number | undefined): number | undefined {
    const e = this.#catalog?.epochMs;
    return wallMs === undefined || e === undefined ? undefined : roomTimeOf(wallMs, e);
  }

  #rangesToRoom(ranges: Range[]): Range[] {
    const e = this.#catalog?.epochMs;
    return e === undefined ? [] : ranges.map((r) => ({ start: r.start - e, end: r.end - e }));
  }

  async #loadArchived(): Promise<void> {
    try {
      this.#archived = await archivedWallRanges(this.#archiveUrl, this.#fetch);
      this.#listeners.emit();
    } catch (e) {
      console.warn("archive playlist", e);
    }
  }

  async #seekArchive(ms: number, edge: number | undefined): Promise<void> {
    const generation = ++this.#archiveGeneration;
    if (this.#archived.length === 0) await this.#loadArchived();
    if (this.#closed || this.#mode !== "rewound" || generation !== this.#archiveGeneration) return;
    const video = this.#elements?.video;
    const e = this.#catalog?.epochMs;
    if (!video || e === undefined || this.#archived.length === 0) {
      this.#useClock(ms, edge);
      return;
    }
    this.#clock?.close();
    this.#clock = undefined;
    try {
      this.#archive ??= await openArchive(video, this.#archiveUrl);
      if (generation !== this.#archiveGeneration) return;
      await this.#archive.open(ms + e);
    } catch (err) {
      if (generation !== this.#archiveGeneration) return;
      this.#error = err instanceof Error ? err.message : String(err);
      this.#useClock(ms, edge);
      return;
    }
    if (generation !== this.#archiveGeneration) return;
    this.#status = "playing";
    this.#error = undefined;
    video.muted = false;
    await video.play().catch(() => {
      // Autoplay refused (no tap yet): the element waits for play().
      this.#status = "idle";
    });
    this.#listeners.emit();
  }

  #closeArchive(): void {
    this.#archiveGeneration++;
    this.#archive?.close();
    this.#archive = undefined;
  }

  #useClock(ms: number, edge: number | undefined): void {
    this.#closeArchive();
    this.#clock?.close();
    const clock = new ClockMedia({ now: this.#now, tickMs: 0, status: "no-media" });
    if (edge !== undefined) clock.setLiveEdge(edge);
    clock.seek(ms);
    this.#clock = clock;
    this.#status = "no-media";
    this.#listeners.emit();
  }

  #startLive(): void {
    const canvas = this.#elements?.canvas;
    if (!canvas || this.#live || this.#closed) return;
    const generation = ++this.#liveGeneration;
    this.#status = "loading";
    const cleanup: (() => void)[] = [];
    this.#live = { close: () => cleanup.forEach((fn) => fn()) };
    import("@moq/watch")
      .then((Watch) => {
        if (generation !== this.#liveGeneration || !this.#live) return;
        const player = new Watch.Player({
          origin: this.#transport.origin,
          name: Watch.Net.Path.from(teacherPath(this.room)),
          canvas,
          catalogFormat: "hang",
          muted: false,
          delay: Watch.Net.Time.Milli(500),
        });
        cleanup.push(() => player.close());
        let clock: HangClock | undefined;
        cleanup.push(
          player.broadcast.out.status.subscribe((s) => {
            this.#status = s === "live" ? "playing" : s === "loading" ? "loading" : "idle";
            this.#listeners.emit();
          }),
          player.broadcast.out.catalog.subscribe((catalog) => {
            clock = hangClockOf(catalog);
            this.#error = catalog && !clock ? "The speaker's broadcast carries no clock." : undefined;
            this.#listeners.emit();
          }),
        );
        const poll = setInterval(() => {
          const pts = player.sync.now();
          const e = this.#catalog?.epochMs;
          if (pts === undefined || !clock || e === undefined) return;
          const shift = this.#catalog?.shift[String(clock.wall)] ?? 0;
          this.#lastLive = { room: roomTimeOf(wallClockMs(clock, Number(pts)), e, shift), wall: this.#now() };
        }, 100);
        cleanup.push(() => clearInterval(poll));
      })
      .catch((e: unknown) => {
        this.#error = String(e);
        this.#listeners.emit();
      });
  }

  #stopLive(): void {
    this.#liveGeneration++;
    this.#live?.close();
    this.#live = undefined;
  }
}
