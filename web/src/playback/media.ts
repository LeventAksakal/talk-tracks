// The speaker's media on the room clock (design §4.5, §5.5): live through @moq/watch, rewound from the
// archive's HLS. Every position is room time: the wall time of a media timestamp − E. A room with no
// archived media still rewinds its AI tracks: the playhead then runs on a clock of its own, silent.

import { teacherPath } from "../contracts/names";
import type { Closable } from "../transport/types";
import type { MoqTransport } from "../transport/moq";
import type { Mode } from "./aiTracks";
import { type ArchivePlayback, type ArchiveState, archiveState, hlsUrl, openArchive } from "./hlsArchive";
import { type LoopInfo, loopInfo, loopOf, LoopPlayback, loopUrl } from "./loopArchive";
import { type RoomCatalog, STATUS_FRESH_MS, watchRoomCatalog } from "./roomCatalog";
import { HANG_CATALOG_TRACK, type HangClock, hangClockOf, roomTimeOf, shiftOf, wallClockMs } from "./roomClock";
import { type Range, sliceOf } from "./slices";

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
  /**
   * Room ms of the frame on screen (decision 0020), cheap enough to call every animation frame: live, the
   * frame @moq/watch painted (or its audio clock); rewound, the last frame the video element presented;
   * with no media, `position()`.
   */
  frameTime(): number | undefined;
  /** Best estimate of the live edge, room ms. */
  liveEdge(): number | undefined;
  /** Room time the archive can play. */
  available(): Range[];
  /** Room time the element holds. */
  buffered(): Range[];
  error(): string | undefined;
  /**
   * Whether the speaker is on air; undefined when unknown. Never from announcements: the relay does not
   * report a broadcast going away.
   */
  onAir?(): boolean | undefined;
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
  frameTime(): number | undefined {
    return this.position();
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
  /**
   * How long the first playlist read waits for the teacher's hang catalog, which says whether the room
   * loops (a looped room has no playlist), ms. A room whose speaker has left never sends one.
   */
  loopWaitMs?: number;
}

/**
 * Live: the speaker broadcast through @moq/watch; its playhead is the wall time of the playing media
 * timestamp (the teacher catalog's root `clock`) − E. Rewound: the archive's HLS from the seek point,
 * mapped through PROGRAM-DATE-TIME, or, in a looped demo room (the teacher's hang catalog says so), the
 * room's recording itself (loopArchive). Go live closes the archive playback and starts the live one
 * again. It also holds the room catalog, which gives E and every track's L.
 */
export class RoomMedia implements SpeakerMedia {
  readonly room: string;
  #transport: MoqTransport;
  #now: () => number;
  #archiveUrl: string;
  #loopUrl: string;
  /** A looped room's loop, from the teacher's hang catalog, and when it was last seen (this device's ms). */
  #loop: { loop: NonNullable<ReturnType<typeof loopOf>>; seen: number } | undefined;
  #fetch: typeof fetch;
  #elements: RoomMediaElements | undefined;
  #mode: Mode = "live";
  #wantLive = false;
  #status: MediaStatus = "idle";
  #error: string | undefined;
  #listeners = new Listeners();
  #catalog: RoomCatalog | undefined;
  /** The last live playhead seen (room ms), and when (this device's wall ms). */
  #lastLive: { room: number; wall: number } | undefined;
  #live: { close(): void } | undefined;
  /** The frame clock of the live player, once it exists: PTS on screen (ms) to room ms. */
  #liveFrame: (() => number | undefined) | undefined;
  #liveGeneration = 0;
  #archive: ArchivePlayback | undefined;
  #archiveGeneration = 0;
  /** The archive's last presented frame (requestVideoFrameCallback mediaTime, s) and the callback handle. */
  #presented: { mediaTime: number | undefined; handle: number | undefined } = {
    mediaTime: undefined,
    handle: undefined,
  };
  /** The archive's playlist as last read: wall-time ranges, and whether it has ended. */
  #playlist: ArchiveState | undefined;
  /** A clock for rooms with no archived media. */
  #clock: ClockMedia | undefined;
  #subs: Closable[] = [];
  #timers: ReturnType<typeof setInterval>[] = [];
  #closed = false;
  /** Settles once the room is known to loop or not: the first hang catalog, or `loopWaitMs` without one. */
  #loopKnown: Promise<void>;
  #setLoopKnown!: () => void;

  constructor(transport: MoqTransport, room: string, options: RoomMediaOptions = {}) {
    this.room = room;
    this.#transport = transport;
    this.#now = options.now ?? Date.now;
    this.#archiveUrl = hlsUrl(room, options.archiveBase);
    this.#loopUrl = loopUrl(room, options.archiveBase);
    this.#fetch = options.fetchFn ?? ((...args) => fetch(...args));
    this.#loopKnown = new Promise((resolve) => (this.#setLoopKnown = resolve));
    const loopWait = setTimeout(() => this.#setLoopKnown(), options.loopWaitMs ?? 3_000);
    this.#subs.push(
      { close: () => clearTimeout(loopWait) },
      watchRoomCatalog(transport, room, (catalog) => {
        this.#catalog = catalog;
        this.#listeners.emit();
      }),
      // A catalog track only (the looper repeats it every 2 s): no agent works for it.
      transport.subscribe(teacherPath(room), HANG_CATALOG_TRACK, ({ payload }) => {
        let loop: ReturnType<typeof loopOf>;
        try {
          loop = loopOf(JSON.parse(new TextDecoder().decode(payload)));
        } catch {
          return;
        }
        const first = !this.#loop;
        this.#loop = loop ? { loop, seen: this.#now() } : undefined;
        this.#setLoopKnown();
        if (first && loop) this.#listeners.emit();
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
    this.#archive?.pause();
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

  frameTime(): number | undefined {
    if (this.#mode === "live") return this.#liveFrame?.() ?? this.position();
    if (this.#clock) return this.#clock.position();
    const archive = this.#archive;
    const wall = archive?.position();
    const video = archive?.element;
    const mediaTime = this.#presented.mediaTime;
    // The presented frame through the playhead's own PROGRAM-DATE-TIME offset (decision 0020); paused,
    // seeking or with no frame yet, the playhead itself.
    if (wall !== undefined && video && mediaTime !== undefined && !video.paused && !video.seeking) {
      const lag = (mediaTime - video.currentTime) * 1000;
      if (Math.abs(lag) < 1_000) return this.#toRoom(wall + lag);
    }
    return this.#toRoom(wall);
  }

  liveEdge(): number | undefined {
    if (this.#lastLive) return this.#lastLive.room + (this.#live ? 0 : this.#now() - this.#lastLive.wall);
    // On air with no media playing here: room time now, as this device's clock has it.
    if (this.onAir()) return this.#toRoom(this.#now());
    return this.available().at(-1)?.end;
  }

  /**
   * The speaker has left when the live media's newest slice is behind the slice of now (k < ⌊now/S⌋), or,
   * with no live media here, when the archive's playlist has ended (30 s without media).
   */
  onAir(): boolean | undefined {
    const now = this.#toRoom(this.#now());
    if (this.#live && this.#lastLive && now !== undefined) return sliceOf(this.#lastLive.room) >= sliceOf(now);
    // A looper repeats the teacher catalog every 2 s while it plays.
    if (this.#loop) return this.#now() - this.#loop.seen < STATUS_FRESH_MS;
    return this.#playlist ? !this.#playlist.ended : undefined;
  }

  /**
   * Room time the archive can play. A looped room's recording plays any room time; the scrubber gets one
   * loop back from now, the whole lecture once.
   */
  available(): Range[] {
    const loop = this.#loopInfo();
    if (loop) {
      const now = this.#now();
      const from = Math.max(loop.wallZeroMs, now - loop.periodMs);
      return this.#rangesToRoom(now > from ? [{ start: from, end: now }] : []);
    }
    return this.#rangesToRoom(this.#playlist?.ranges ?? []);
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
    this.#error = undefined; // an archive error belongs to the rewound playback
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
    const e = this.#catalog?.tt.E;
    return wallMs === undefined || e === undefined ? undefined : roomTimeOf(wallMs, e);
  }

  #rangesToRoom(ranges: Range[]): Range[] {
    const e = this.#catalog?.tt.E;
    return e === undefined ? [] : ranges.map((r) => ({ start: r.start - e, end: r.end - e }));
  }

  /** The loop on the wall clock, the broadcast's shift included; undefined when the room does not loop. */
  #loopInfo(): LoopInfo | undefined {
    const loop = this.#loop?.loop;
    return loop && loopInfo(loop, shiftOf(this.#catalog?.tt.shift, loop.clock));
  }

  async #loadArchived(): Promise<void> {
    // Not before the room is known to loop or not: a looped room has no playlist (the archiver skips it).
    await this.#loopKnown;
    if (this.#loop || this.#closed) return;
    try {
      const before = this.#playlist;
      this.#playlist = await archiveState(this.#archiveUrl, this.#fetch);
      // The speaker came back: hls.js stopped reloading the playlist at its ENDLIST.
      if (before?.ended && this.#playlist && !this.#playlist.ended) this.#archive?.reload();
      this.#listeners.emit();
    } catch (e) {
      console.warn("archive playlist", e);
    }
  }

  async #seekArchive(ms: number, edge: number | undefined): Promise<void> {
    const generation = ++this.#archiveGeneration;
    if (!this.#loop && !this.#playlist?.ranges.length) await this.#loadArchived();
    if (this.#closed || this.#mode !== "rewound" || generation !== this.#archiveGeneration) return;
    const video = this.#elements?.video;
    const e = this.#catalog?.tt.E;
    const loop = this.#loopInfo();
    if (!video || e === undefined || (!loop && !this.#playlist?.ranges.length)) {
      this.#useClock(ms, edge);
      return;
    }
    this.#clock?.close();
    this.#clock = undefined;
    try {
      this.#archive ??= loop
        ? new LoopPlayback(video, this.#loopUrl, loop)
        : await openArchive(video, this.#archiveUrl);
      if (generation !== this.#archiveGeneration) return;
      await this.#archive.open(ms + e);
    } catch (err) {
      if (generation !== this.#archiveGeneration) return;
      this.#error = err instanceof Error ? err.message : String(err);
      this.#useClock(ms, edge);
      return;
    }
    if (generation !== this.#archiveGeneration) return;
    this.#watchFrames(video, generation);
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
    const { handle } = this.#presented;
    const video = this.#archive?.element;
    if (handle !== undefined && video && "cancelVideoFrameCallback" in video) video.cancelVideoFrameCallback(handle);
    this.#presented = { mediaTime: undefined, handle: undefined };
    this.#archive?.close();
    this.#archive = undefined;
  }

  /** Keep the media time of the frame the element last presented (requestVideoFrameCallback, decision 0020). */
  #watchFrames(video: HTMLVideoElement, generation: number): void {
    if (!("requestVideoFrameCallback" in video) || this.#presented.handle !== undefined) return;
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      if (generation !== this.#archiveGeneration) return;
      this.#presented = { mediaTime: metadata.mediaTime, handle: video.requestVideoFrameCallback(onFrame) };
    };
    this.#presented = { mediaTime: undefined, handle: video.requestVideoFrameCallback(onFrame) };
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
        const toRoom = (pts: number | undefined): number | undefined => {
          const e = this.#catalog?.tt.E;
          if (pts === undefined || !clock || e === undefined) return undefined;
          return roomTimeOf(wallClockMs(clock, pts), e, shiftOf(this.#catalog?.tt.shift, clock));
        };
        const poll = setInterval(() => {
          const room = toRoom(player.sync.now());
          if (room !== undefined) this.#lastLive = { room, wall: this.#now() };
        }, 100);
        cleanup.push(() => clearInterval(poll));
        // The frame painted on the canvas (its PTS, set in @moq/watch's own rAF), else the shared audio
        // clock for a room without video (decision 0020).
        this.#liveFrame = () => toRoom(player.renderer.out.timestamp.peek() ?? player.sync.now());
        cleanup.push(() => (this.#liveFrame = undefined));
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
