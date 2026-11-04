// The speaker's media on the room clock (design §4.5, §5.5): live through @moq/watch, rewound from the
// archive's HLS. Every position is room time: the wall time of a media timestamp − E. A room with no
// archived media still rewinds its AI tracks: the playhead then runs on a clock of its own, silent.

import { agentsPrefix, RECORDING_SUFFIX, recordingOf, teacherPath } from "../contracts/names";
import type { Closable } from "../transport/types";
import type { MoqTransport } from "../transport/moq";
import type { Mode } from "./aiTracks";
import { type ArchivePlayback, type ArchiveState, archiveState, hlsUrl, openArchive } from "./hlsArchive";
import { type LoopInfo, loopInfo, loopOf, LoopPlayback, loopPlace, loopUrl } from "./loopArchive";
import { type RoomCatalog, STATUS_FRESH_MS, watchRoomCatalog } from "./roomCatalog";
import { HANG_CATALOG_TRACK, type HangClock, hangClockOf, roomTimeOf, shiftOf, wallClockMs } from "./roomClock";
import { type SessionInfo, sessionOf, sessionOrigin, type SessionSource } from "./session";
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
  /** Start (or resume) playing; live media starts its sound here, so call it from a gesture. */
  play?(): void;
  /** Stop playing; the mode stays. */
  pause?(): void;
  /** Playback rate for rewound media (live always plays at 1×). */
  setRate?(rate: number): void;
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
  #rate = 1;
  /** Paused while rewound: the media ms it holds at. */
  #frozen: number | undefined;

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
    if (this.#frozen !== undefined) return this.#frozen;
    if (!this.#anchor) return undefined;
    const pos = this.#anchor.media + (this.#now() - this.#anchor.wall) * this.#rate;
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
  /** Move the playhead; paused, it stays paused at the new place (a seek never plays). */
  seek(ms: number): void {
    const paused = this.#mode === "rewound" && this.#frozen !== undefined;
    this.#mode = "rewound";
    this.#frozen = paused ? ms : undefined;
    this.#anchor = { media: ms, wall: this.#now() };
    this.#listeners.emit();
  }
  goLive(): void {
    this.#mode = "live";
    this.#frozen = undefined;
    this.#anchor = undefined;
    this.#listeners.emit();
  }
  play(): void {
    if (this.#frozen === undefined) return;
    this.#anchor = { media: this.#frozen, wall: this.#now() };
    this.#frozen = undefined;
    this.#listeners.emit();
  }
  /** Rewound, the playhead holds still until play(); live, the edge runs on (the player holds its display). */
  pause(): void {
    if (this.#mode !== "rewound" || this.#frozen !== undefined) return;
    this.#frozen = this.position();
    this.#listeners.emit();
  }
  setRate(rate: number): void {
    if (!(rate > 0) || rate === this.#rate) return;
    const pos = this.#mode === "rewound" && this.#frozen === undefined ? this.position() : undefined;
    this.#rate = rate;
    if (pos !== undefined) this.#anchor = { media: pos, wall: this.#now() };
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
  /** Opens an HLS archive on the video element (tests stand in for hls.js). */
  openArchive?: (video: HTMLVideoElement, url: string, startS?: number) => Promise<ArchivePlayback>;
  /**
   * How long the first playlist read waits for the teacher's hang catalog, which says whether the room
   * loops (a looped room has no playlist), ms. A room whose speaker has left never sends one.
   */
  loopWaitMs?: number;
  /** The longest that wait runs while the relay has not answered or the room catalog says it is a recording, ms. */
  loopWaitCapMs?: number;
}

/** See `loopWaitCapMs`. */
const LOOP_WAIT_CAP_MS = 20_000;

/**
 * The room catalog of a recording (a looped demo room): it lists agent tracks and every one is free. A live room's
 * agents are paid, so this is the looper's catalog (agents' slicing.room_catalog).
 */
export function recordedRoom(catalog: RoomCatalog, room: string): boolean {
  const agents = catalog.tracks.filter((t) => t.namespace.startsWith(`${agentsPrefix(room)}/`));
  return agents.length > 0 && agents.every((t) => t.tt?.cost === "free");
}

/**
 * Live: the speaker broadcast through @moq/watch; its playhead is the wall time of the playing media
 * timestamp (the teacher catalog's root `clock`) − E. Rewound: the archive's HLS from the seek point,
 * mapped through PROGRAM-DATE-TIME, or, in a looped demo room (the teacher's hang catalog says so), the
 * room's recording itself (loopArchive). Go live closes the archive playback and starts the live one
 * again. It also holds the room catalog, which gives E and every track's L.
 */
export class RoomMedia implements SpeakerMedia, SessionSource {
  readonly room: string;
  #transport: MoqTransport;
  #now: () => number;
  #archiveUrl: string;
  #loopUrl: string;
  /** A demo session's recording room (`<room>-recording`, decision 0032): its HLS, when the lecture file is missing. */
  #recordingUrl: string;
  /** The session's lecture file could not be loaded: rewinds play the recording room's HLS straight away. */
  #loopFileMissing = false;
  #openArchive: (video: HTMLVideoElement, url: string, startS?: number) => Promise<ArchivePlayback>;
  /** A looped room's loop, from the teacher's hang catalog, and when it was last seen (this device's ms). */
  #loop: { loop: NonNullable<ReturnType<typeof loopOf>>; seen: number } | undefined;
  /** A demo session's id and clock, from the teacher's hang catalog (decision 0032). */
  #session: SessionInfo | undefined;
  #fetch: typeof fetch;
  #elements: RoomMediaElements | undefined;
  #mode: Mode = "live";
  #wantLive = false;
  /** Paused by the viewer (stop): a seek moves the playhead and stays paused, the archive opens without playing. */
  #held = false;
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
  /** Live speaker volume, 0–1, and the live player's volume input once it exists. */
  #volume = 1;
  #liveVolume: { set(volume: number): void } | undefined;
  #rate = 1;
  #archive: ArchivePlayback | undefined;
  #archiveGeneration = 0;
  /** The archive's last presented frame (requestVideoFrameCallback mediaTime, s) and the callback handle. */
  #presented: { mediaTime: number | undefined; handle: number | undefined } = {
    mediaTime: undefined,
    handle: undefined,
  };
  /** The archive's playlist as last read: wall-time ranges, and whether it has ended. */
  #playlist: ArchiveState | undefined;
  #loading: Promise<void> | undefined;
  /** A clock for rooms with no archived media. */
  #clock: ClockMedia | undefined;
  /**
   * The clock stands in only because the room catalog (its epoch) or the elements were not in yet when a rewind
   * opened: the archive opens once they come, and meanwhile the picture is loading, not missing.
   */
  #awaiting = false;
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
    this.#recordingUrl = hlsUrl(`${room}${RECORDING_SUFFIX}`, options.archiveBase);
    this.#openArchive = options.openArchive ?? openArchive;
    this.#fetch = options.fetchFn ?? ((...args) => fetch(...args));
    this.#loopKnown = new Promise((resolve) => (this.#setLoopKnown = resolve));
    // No teacher catalog after the short wait: the room does not loop (its speaker left), unless the relay has not
    // answered yet (no room catalog either) or the room catalog says the room is a recording, whose looper sends
    // the teacher catalog every 2 s. Then wait on, up to a cap. A demo lecture's recording room (`<id>-recording`,
    // decision 0032) has no teacher broadcast at all, and its agents are free too: it never loops, so its playlist
    // is read at once instead of after the cap.
    const step = options.loopWaitMs ?? 3_000;
    const cap = Math.max(step, options.loopWaitCapMs ?? LOOP_WAIT_CAP_MS);
    let waited = 0;
    let loopWait: ReturnType<typeof setTimeout> | undefined;
    const waitForLoop = () => {
      loopWait = setTimeout(() => {
        waited += step;
        const unsure = !this.#catalog || recordedRoom(this.#catalog, room);
        if (unsure && waited + step <= cap) waitForLoop();
        else this.#setLoopKnown();
      }, step);
    };
    if (recordingOf(room) !== undefined) this.#setLoopKnown();
    else waitForLoop();
    this.#subs.push(
      { close: () => clearTimeout(loopWait) },
      watchRoomCatalog(transport, room, (catalog) => {
        this.#catalog = catalog;
        this.#retryArchive();
        this.#listeners.emit();
      }),
      // A catalog track only (the looper repeats it every 2 s): no agent works for it.
      transport.subscribe(teacherPath(room), HANG_CATALOG_TRACK, ({ payload }) => {
        let loop: ReturnType<typeof loopOf>;
        let session: SessionInfo | undefined;
        try {
          const json: unknown = JSON.parse(new TextDecoder().decode(payload));
          loop = loopOf(json);
          session = sessionOf(json);
        } catch {
          return;
        }
        const first = !this.#loop;
        this.#loop = loop ? { loop, seen: this.#now() } : undefined;
        const newSession = session !== undefined && session.id !== this.#session?.id;
        if (session) this.#session = session;
        this.#setLoopKnown();
        if ((first && loop) || newSession) this.#listeners.emit();
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

  /** What tells this room's session apart (session.ts): E, and a demo session's id. */
  sessionKey(): { epoch?: number; session?: string } {
    return { epoch: this.#catalog?.tt.E, session: this.#session?.id };
  }

  /** The room plays demo sessions (decision 0032): each ends, and the next starts from 00:00. */
  hasSessions(): boolean {
    return this.#session !== undefined;
  }

  /**
   * Room ms of the talk clock's 00:00: a demo session's start, or in a looped room the current loop's start; 0 in any
   * other room (room time is the time since the talk began).
   */
  talkOrigin(): number {
    const e = this.#catalog?.tt.E;
    if (e === undefined) return 0;
    const session = this.#session;
    if (session) return sessionOrigin(session, e, shiftOf(this.#catalog?.tt.shift, session.clock));
    const loop = this.#loopInfo();
    const edge = this.liveEdge();
    if (!loop || edge === undefined) return 0;
    const place = loopPlace(loop, edge + e);
    return Math.max(0, edge - place.fileMs);
  }

  /**
   * Whether the room is a looped recording, once that is known (its teacher catalog, or the wait for one). A looped
   * room has no HLS archive (the archiver skips it): nothing should ask the archive for its playlists.
   */
  async looping(): Promise<boolean> {
    await this.#loopKnown;
    return this.#loop !== undefined;
  }

  /** Give the media its elements (from React refs). */
  attach(elements: RoomMediaElements | undefined): void {
    this.#elements = elements;
    if (elements && this.#mode === "live" && this.#wantLive) this.#startLive();
    if (elements) this.#retryArchive();
  }

  /** Start live playback (call from a tap: browsers start sound only after a user gesture). */
  play(): void {
    this.#wantLive = true;
    this.#held = false;
    if (this.#mode === "live") this.#startLive();
    else {
      this.#clock?.play();
      void this.#archive?.element.play().catch(() => {});
    }
  }

  /**
   * The live sound's volume, 0–1 (0 to mute; the audio keeps downloading, so unmuting is instant). The archive
   * element's volume is its owner's (CameraSurface).
   */
  setVolume(volume: number): void {
    this.#volume = Math.min(1, Math.max(0, volume));
    this.#liveVolume?.set(this.#volume);
  }

  /** Stop playing (all sound, live or rewound); the mode stays. */
  pause(): void {
    this.stop();
  }

  /** The rewound archive's playback rate; live plays at 1×. */
  setRate(rate: number): void {
    if (!(rate > 0)) return;
    this.#rate = rate;
    const video = this.#archive?.element;
    if (video) video.playbackRate = rate;
    this.#clock?.setRate(rate);
  }

  /** Stop all sound, live or rewound; the mode stays. */
  stop(): void {
    this.#wantLive = false;
    this.#held = true;
    this.#stopLive();
    this.#archive?.pause();
    this.#clock?.pause();
    // A rewind with no archived media keeps saying so while paused.
    this.#status = this.#clock ? (this.#awaiting ? "loading" : "no-media") : "idle";
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
    // A looper repeats the teacher catalog every 2 s while it plays. A demo session need not: its live media and the
    // room track say whether it is on air.
    if (this.#loop && !this.#session) return this.#now() - this.#loop.seen < STATUS_FRESH_MS;
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
    this.#awaiting = false;
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

  /**
   * The time in the talk to show for room time `ms`. A looped demo room's room clock runs on across loops (it
   * starts at 2026-10-01, so it reads hundreds of hours); each loop is the lecture again, so it shows the time
   * within the loop. Any other room: `ms`, its time since the talk began.
   */
  talkTime(ms: number): number {
    const loop = this.#loopInfo();
    const e = this.#catalog?.tt.E;
    if (this.#session && e !== undefined) return Math.max(0, ms - this.talkOrigin());
    return loop && e !== undefined ? loopPlace(loop, ms + e).fileMs : ms;
  }

  /** The loop on the wall clock, the broadcast's shift included; undefined when the room does not loop. */
  #loopInfo(): LoopInfo | undefined {
    const loop = this.#loop?.loop;
    return loop && loopInfo(loop, shiftOf(this.#catalog?.tt.shift, loop.clock));
  }

  /** One playlist read at a time: refreshes asked for while one waits or runs share it. */
  #loadArchived(): Promise<void> {
    this.#loading ??= this.#readPlaylist().finally(() => (this.#loading = undefined));
    return this.#loading;
  }

  async #readPlaylist(): Promise<void> {
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
      this.#useClock(ms, edge, !video || e === undefined);
      return;
    }
    this.#clock?.close();
    this.#clock = undefined;
    this.#awaiting = false;
    try {
      if (loop) await this.#openLoop(video, loop, ms + e, generation);
      else {
        this.#archive ??= await this.#openArchive(video, this.#archiveUrl);
        if (generation !== this.#archiveGeneration) return;
        await this.#archive.open(ms + e);
      }
    } catch (err) {
      if (generation !== this.#archiveGeneration) return;
      this.#error = err instanceof Error ? err.message : String(err);
      this.#useClock(ms, edge);
      return;
    }
    if (generation !== this.#archiveGeneration) return;
    this.#watchFrames(video, generation);
    video.playbackRate = this.#rate;
    this.#status = "playing";
    this.#error = undefined;
    video.muted = false;
    if (this.#held) {
      // Paused: the frame at the seek point shows, and play() starts it.
      this.#status = "idle";
      this.#listeners.emit();
      return;
    }
    await video.play().catch(() => {
      // Autoplay refused (no tap yet): the element waits for play().
      this.#status = "idle";
    });
    this.#listeners.emit();
  }

  /**
   * Open a looped or session room's rewind at wall time `wallMs`: its lecture file (`archive/<room>/lecture.mp4`). A
   * demo session whose file the archive does not serve (a 404: the media element reports a format error) plays its
   * recording room's HLS instead, the same lecture: session time t is lecture time t, and the recording room's media
   * starts at lecture 00:00 on its own wall clock (its playlist's first PROGRAM-DATE-TIME). Without that fallback the
   * rewind ran on a silent clock: captions moved, with no sound and no picture.
   */
  async #openLoop(video: HTMLVideoElement, loop: LoopInfo, wallMs: number, generation: number): Promise<void> {
    if (!this.#archive && !this.#loopFileMissing) this.#archive = new LoopPlayback(video, this.#loopUrl, loop);
    if (this.#archive) {
      try {
        await this.#archive.open(wallMs);
        return;
      } catch (err) {
        if (!this.#session || !(this.#archive instanceof LoopPlayback) || generation !== this.#archiveGeneration)
          throw err;
        this.#archive.close();
        this.#archive = undefined;
        this.#loopFileMissing = true;
      }
    }
    if (!this.#session) throw new Error("the recording could not be loaded");
    const start = (await archiveState(this.#recordingUrl, this.#fetch))?.ranges[0]?.start;
    if (generation !== this.#archiveGeneration) return;
    if (start === undefined) throw new Error("the recording could not be loaded");
    const shift = loop.wallZeroMs - start;
    // The recording's media time is lecture time: hls.js starts loading at the seek point, not at 00:00.
    const hls = await this.#openArchive(video, this.#recordingUrl, Math.max(0, (wallMs - shift - start) / 1000));
    if (generation !== this.#archiveGeneration) {
      hls.close();
      return;
    }
    this.#archive = new ShiftedPlayback(hls, shift);
    await this.#archive.open(wallMs);
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

  /** A rewind that fell back to the clock while the catalog or the elements were missing opens the archive now. */
  #retryArchive(): void {
    if (!this.#awaiting || this.#closed || this.#mode !== "rewound" || !this.#elements || !this.#catalog) return;
    this.#awaiting = false;
    void this.#seekArchive(this.#clock?.position() ?? 0, this.liveEdge());
  }

  #useClock(ms: number, edge: number | undefined, awaiting = false): void {
    this.#closeArchive();
    this.#clock?.close();
    this.#awaiting = awaiting;
    const status: MediaStatus = awaiting ? "loading" : "no-media";
    const clock = new ClockMedia({ now: this.#now, tickMs: 0, status });
    if (edge !== undefined) clock.setLiveEdge(edge);
    clock.seek(ms);
    clock.setRate(this.#rate);
    if (this.#held) clock.pause();
    this.#clock = clock;
    this.#status = status;
    this.#listeners.emit();
  }

  #startLive(): void {
    const canvas = this.#elements?.canvas;
    if (!canvas || this.#live || this.#closed) return;
    const generation = ++this.#liveGeneration;
    this.#status = "loading";
    // The playhead of an earlier live session (before a seek back) is no news of this one: kept, it would read as
    // live media a minute behind now, so a speaker who left (onAir false), until this player shows a frame.
    this.#lastLive = undefined;
    const cleanup: (() => void)[] = [];
    this.#live = { close: () => cleanup.forEach((fn) => fn()) };
    import("@moq/watch")
      .then((Watch) => {
        if (generation !== this.#liveGeneration || !this.#live) return;
        const volume = new Watch.Signals.Signal(this.#volume);
        this.#liveVolume = volume;
        cleanup.push(() => (this.#liveVolume = undefined));
        const player = new Watch.Player({
          origin: this.#transport.origin,
          name: Watch.Net.Path.from(teacherPath(this.room)),
          canvas,
          catalogFormat: "hang",
          muted: false,
          volume,
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

/**
 * An archive playback whose media sits `shiftMs` earlier on the wall clock than the room it plays for: a demo session's
 * recording room, built once from the same lecture, for the session's own wall clock.
 */
export class ShiftedPlayback implements ArchivePlayback {
  readonly #inner: ArchivePlayback;
  readonly #shift: number;
  constructor(inner: ArchivePlayback, shiftMs: number) {
    this.#inner = inner;
    this.#shift = shiftMs;
  }
  get element(): HTMLVideoElement {
    return this.#inner.element;
  }
  get error(): string | undefined {
    return this.#inner.error;
  }
  open(wallMs: number): Promise<void> {
    return this.#inner.open(wallMs - this.#shift);
  }
  seek(wallMs: number): void {
    this.#inner.seek(wallMs - this.#shift);
  }
  reload(): void {
    this.#inner.reload();
  }
  position(): number | undefined {
    const p = this.#inner.position();
    return p === undefined ? undefined : p + this.#shift;
  }
  buffered(): Range[] {
    return this.#inner.buffered().map((r) => ({ start: r.start + this.#shift, end: r.end + this.#shift }));
  }
  pause(): void {
    this.#inner.pause();
  }
  close(): void {
    this.#inner.close();
  }
}
