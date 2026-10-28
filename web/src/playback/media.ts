// The speaker's media on the one media clock: live through @moq/watch, rewound from the archive with MSE.
// A room with no archived media (a looped demo room, whose recording is not served) still rewinds its
// AI tracks: the playhead then runs on a clock of its own and the media stays silent.

import { CLOCK_TRACK, slidesPath, teacherPath } from "../contracts/names";
import type { Closable } from "../transport/types";
import type { MoqTransport } from "../transport/moq";
import { ArchiveClient, archivedRanges, type RunIndex } from "./archive";
import { ArchivePlayer } from "./archivePlayer";
import type { Mode } from "./aiTracks";
import type { Range } from "./slices";

export type MediaStatus =
  | "idle" // nothing started (a browser plays sound only after a tap)
  | "loading"
  | "playing"
  | "no-media"; // rewound with no archived media: AI tracks only

export interface SpeakerMedia {
  mode(): Mode;
  status(): MediaStatus;
  /** The playhead, media ms; undefined until something plays (live) or a seek (rewound). */
  position(): number | undefined;
  /** Best estimate of the live edge, media ms. */
  liveEdge(): number | undefined;
  /** Media time the archive can play. */
  available(): Range[];
  /** Media time the element holds. */
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

/**
 * Live: the speaker broadcast through @moq/watch (as the viewer has it today), its playback time read
 * from the player's clock. Rewound: the archive's fMP4 segments with MSE, from the seek point. Go live
 * closes the archive player and starts the live one again.
 */
export class RoomMedia implements SpeakerMedia {
  readonly room: string;
  #transport: MoqTransport;
  #archive: ArchiveClient;
  #now: () => number;
  #elements: RoomMediaElements | undefined;
  #mode: Mode = "live";
  #wantLive = false;
  #status: MediaStatus = "idle";
  #error: string | undefined;
  #listeners = new Listeners();
  /** The last live playback time seen, and when. */
  #lastLive: { media: number; wall: number } | undefined;
  #live: { close(): void } | undefined;
  #liveGeneration = 0;
  #archivePlayer: ArchivePlayer | undefined;
  #run: RunIndex | undefined;
  #runLoadedAt = 0;
  /** A clock for rooms with no archived media. */
  #clock: ClockMedia | undefined;
  /** Room time minus the speaker's media timestamps, from the speaker console's `clock` track. */
  #offset: number | undefined;
  #clockTrack: Closable;
  #timer: ReturnType<typeof setInterval>;
  #closed = false;

  constructor(transport: MoqTransport, room: string, options: { archive?: ArchiveClient; now?: () => number } = {}) {
    this.room = room;
    this.#transport = transport;
    this.#archive = options.archive ?? new ArchiveClient();
    this.#now = options.now ?? Date.now;
    this.#timer = setInterval(() => this.#listeners.emit(), 250);
    // Room time = speaker media timestamp + offset (decision 0012 addendum, design §4.5). A broadcast with
    // no clock track (the demo looper, which already plays room time) means offset 0.
    this.#clockTrack = transport.subscribe(slidesPath(room), CLOCK_TRACK, ({ payload }) => {
      const offset = parseClock(payload);
      if (offset !== undefined) this.#offset = offset;
    });
    void this.#loadRun();
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
    else void this.#archivePlayer?.element.play().catch(() => {});
  }

  /** Stop all sound, live or rewound; the mode stays. */
  stop(): void {
    this.#wantLive = false;
    this.#stopLive();
    this.#archivePlayer?.element.pause();
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
    return this.#error ?? this.#archivePlayer?.error;
  }

  position(): number | undefined {
    if (this.#mode === "rewound") return this.#clock ? this.#clock.position() : this.#archivePlayer?.position();
    return this.#lastLive && this.#live ? this.#lastLive.media : undefined;
  }

  liveEdge(): number | undefined {
    if (this.#lastLive) return this.#lastLive.media + (this.#live ? 0 : this.#now() - this.#lastLive.wall);
    const run = this.#run;
    if (!run) return undefined;
    // From the archive: its newest media plus the time since it was written, if the room is still on air.
    const wall = run.media_last_wall_ms ?? run.last_wall_ms;
    const since = this.#now() - wall;
    return since < 30_000 ? run.media_last_ms + Math.max(0, since) : run.media_last_ms;
  }

  available(): Range[] {
    return this.#run ? archivedRanges(this.#run) : [];
  }

  buffered(): Range[] {
    return this.#archivePlayer?.buffered() ?? [];
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
    this.#archivePlayer?.close();
    this.#archivePlayer = undefined;
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
    clearInterval(this.#timer);
    this.#clockTrack.close();
    this.#stopLive();
    this.#archivePlayer?.close();
    this.#clock?.close();
    this.#listeners.clear();
  }

  async #loadRun(): Promise<RunIndex | undefined> {
    if (this.#run && this.#now() - this.#runLoadedAt < 3_000) return this.#run;
    try {
      this.#run = await this.#archive.currentRun(this.room);
      this.#runLoadedAt = this.#now();
      this.#listeners.emit();
    } catch (e) {
      console.warn("archive index", e);
    }
    return this.#run;
  }

  async #seekArchive(ms: number, edge: number | undefined): Promise<void> {
    const run = await this.#loadRun();
    if (this.#closed || this.#mode !== "rewound") return;
    const video = this.#elements?.video;
    const archived = run ? archivedRanges(run) : [];
    if (!run || !video || archived.length === 0 || typeof MediaSource === "undefined") {
      this.#useClock(ms, edge);
      return;
    }
    this.#clock?.close();
    this.#clock = undefined;
    if (this.#archivePlayer && this.#archivePlayer.run.run === run.run) {
      this.#archivePlayer.seek(ms);
    } else {
      this.#archivePlayer?.close();
      const player = new ArchivePlayer(video, this.#archive, run);
      this.#archivePlayer = player;
      player.onChange(() => this.#listeners.emit());
      try {
        await player.open(ms);
      } catch (e) {
        if (this.#archivePlayer !== player) return;
        this.#error = e instanceof Error ? e.message : String(e);
        player.close();
        this.#archivePlayer = undefined;
        this.#useClock(ms, edge);
        return;
      }
    }
    this.#status = "playing";
    this.#error = undefined;
    video.muted = false;
    await video.play().catch(() => {
      // Autoplay refused (no tap yet): the element waits for play().
      this.#status = "idle";
    });
    this.#listeners.emit();
  }

  #useClock(ms: number, edge: number | undefined): void {
    this.#archivePlayer?.close();
    this.#archivePlayer = undefined;
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
        cleanup.push(
          player.broadcast.out.status.subscribe((s) => {
            this.#status = s === "live" ? "playing" : s === "loading" ? "loading" : "idle";
            this.#listeners.emit();
          }),
        );
        const poll = setInterval(() => {
          const t = player.sync.now();
          if (t !== undefined) this.#lastLive = { media: Number(t) + (this.#offset ?? 0), wall: this.#now() };
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

/** The speaker console's room-clock track in `talk/R/slides`. */

/** `offset_ms` from a clock object `{"epoch_ms", "offset_ms", "session"}`, or undefined. */
export function parseClock(payload: Uint8Array): number | undefined {
  try {
    const v = JSON.parse(new TextDecoder().decode(payload)) as { offset_ms?: unknown };
    return typeof v.offset_ms === "number" && Number.isFinite(v.offset_ms) ? v.offset_ms : undefined;
  } catch {
    return undefined;
  }
}
