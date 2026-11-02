// The speaker's shared screen in the player: the teacher broadcast's `screen` rendition (decision 0018's broadcast,
// one more video track). Live, its own @moq/watch player paints it on its own canvas, muted (the speaker's sound,
// a shared tab's mixed in, is the camera player's). Rewound, the archive's screen.m3u8 plays on its own video element,
// following the main playhead (the camera's, through PROGRAM-DATE-TIME). The playback engine is untouched: this only
// reads RoomMedia's mode, frame time and catalog.
//
// Whether the screen is on the stage: live, the teacher's hang catalog names a `screen` rendition (it does exactly
// while the speaker shares); rewound, the screen playlist covers the frame on screen.
//
// A 404 for the playlist means no share is archived (a recording room, or a talk nobody shared a screen in): the
// playlist is not asked for again until a share ends, and then until it is there.

import { HANG_CATALOG_TRACK, SCREEN_TRACK, teacherPath } from "../contracts/names";
import type { Mode } from "../playback/aiTracks";
import { type ArchivePlayback, archiveState, openArchive } from "../playback/hlsArchive";
import type { RoomMedia } from "../playback/media";
import type { Range } from "../playback/slices";
import { MoqTransport } from "../transport/moq";
import type { Closable, Transport } from "../transport/types";

/** The room's screen playlist, beside index.m3u8 (archive/hls.py). */
export const screenUrl = (room: string, base = "/archive") => `${base.replace(/\/$/, "")}/${room}/screen.m3u8`;

/** The rewound screen is moved to the playhead when it drifts this far, ms. */
export const SCREEN_DRIFT_MS = 400;

/** A teacher hang catalog names a shared screen. */
export function hangHasScreen(catalog: unknown): boolean {
  const video = (catalog as { video?: { renditions?: Record<string, unknown> } } | null)?.video;
  return !!video?.renditions && SCREEN_TRACK in video.renditions;
}

/** Whether the screen is on the stage: live, while shared; rewound, where the archive holds it at the frame shown. */
export function screenShown(
  mode: Mode,
  liveShared: boolean,
  ranges: readonly Range[],
  at: number | undefined,
): boolean {
  if (mode === "live") return liveShared;
  return at !== undefined && ranges.some((r) => at >= r.start && at < r.end);
}

export interface ScreenElements {
  canvas: HTMLCanvasElement;
  video: HTMLVideoElement;
}

export interface ScreenMediaOptions {
  archiveBase?: string;
  fetchFn?: typeof fetch;
  /** How often the screen playlist is read again, ms. */
  refreshMs?: number;
  /** How often the rewound screen follows the playhead, ms; 0: never (tests drive `follow`). */
  tickMs?: number;
}

export class ScreenMedia {
  readonly room: string;
  #transport: Transport | undefined;
  #media: RoomMedia;
  #url: string;
  #fetch: typeof fetch;
  #liveShared = false;
  /** The screen playlist as wall-time ranges (Unix ms). */
  #wallRanges: Range[] = [];
  #listeners = new Set<() => void>();
  #subs: Closable[] = [];
  #timers: ReturnType<typeof setInterval>[] = [];
  #elements: ScreenElements | undefined;
  #live: { close(): void } | undefined;
  #liveGeneration = 0;
  #archive: ArchivePlayback | undefined;
  #archiveOpening = false;
  #refreshing: Promise<void> | undefined;
  #closed = false;
  /** The archive answered 404 for the playlist: no share archived. The periodic read stops. */
  #absent = false;
  /** A share ended, so its playlist is due: read on, through 404s, until it is there. */
  #due = false;

  constructor(transport: Transport | undefined, room: string, media: RoomMedia, options: ScreenMediaOptions = {}) {
    this.room = room;
    this.#transport = transport;
    this.#media = media;
    this.#url = screenUrl(room, options.archiveBase);
    this.#fetch = options.fetchFn ?? ((...args) => fetch(...args));
    if (transport) {
      this.#subs.push(
        transport.subscribe(teacherPath(room), HANG_CATALOG_TRACK, ({ payload }) => {
          let shared: boolean;
          try {
            shared = hangHasScreen(JSON.parse(new TextDecoder().decode(payload)));
          } catch {
            return;
          }
          if (shared === this.#liveShared) return;
          this.#liveShared = shared;
          // A share that ended is in the archive now (or soon): read the playlist again until it is.
          if (!shared) {
            this.#due = true;
            void this.refresh();
          }
          this.#emit();
        }),
      );
    }
    this.#timers.push(
      setInterval(() => {
        if (!this.#absent || this.#due) void this.refresh();
      }, options.refreshMs ?? 10_000),
    );
    const tick = options.tickMs ?? 250;
    if (tick > 0) this.#timers.push(setInterval(() => this.follow(), tick));
    void this.refresh();
  }

  /** The speaker shares a screen now (the hang catalog says so). */
  liveShared(): boolean {
    return this.#liveShared;
  }

  /** Room time the archive holds a shared screen for. */
  ranges(): Range[] {
    const e = this.#media.catalog()?.tt.E;
    return e === undefined ? [] : this.#wallRanges.map((r) => ({ start: r.start - e, end: r.end - e }));
  }

  /** The screen is on the stage at the frame shown. */
  shown(): boolean {
    const mode = this.#media.mode();
    return screenShown(mode, this.#liveShared, this.ranges(), mode === "live" ? undefined : this.#media.frameTime());
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Give the screen its canvas and video element (from React refs). */
  attach(elements: ScreenElements | undefined): void {
    this.#elements = elements;
    if (!elements) {
      this.#stopLive();
      this.#closeArchive();
    }
    this.follow();
  }

  /** Read the screen playlist again. */
  refresh(): Promise<void> {
    // One read at a time: refreshes asked for while one waits (to know whether the room loops) or runs share it.
    this.#refreshing ??= this.#read().finally(() => (this.#refreshing = undefined));
    return this.#refreshing;
  }

  async #read(): Promise<void> {
    // A looped room has no archive (the archiver skips the demo rooms): never ask it for a screen playlist.
    if (await this.#media.looping()) return;
    try {
      let status: number | undefined;
      const probe = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await this.#fetch(input, init);
        status ??= response.status; // the screen playlist's own answer, the first request
        return response;
      }) as typeof fetch;
      const state = await archiveState(this.#url, probe);
      if (this.#closed) return;
      this.#absent = status === 404;
      if (state) this.#due = false;
      const before = JSON.stringify(this.#wallRanges);
      this.#wallRanges = state?.ranges ?? [];
      if (JSON.stringify(this.#wallRanges) !== before) this.#emit();
    } catch {
      // No archive here (development, a looped room): no rewound screen.
    }
  }

  /** Live: the live screen player while shared. Rewound: the archive's screen at the playhead, playing as it plays. */
  follow(): void {
    if (this.#closed) return;
    const elements = this.#elements;
    const mode = this.#media.mode();
    if (!elements || mode === "live") {
      this.#closeArchive();
      if (elements && this.#liveShared) this.#startLive(elements.canvas);
      else this.#stopLive();
      return;
    }
    this.#stopLive();
    const e = this.#media.catalog()?.tt.E;
    const at = this.#media.frameTime();
    if (e === undefined || at === undefined || !this.shown()) {
      this.#archive?.pause();
      return;
    }
    if (!this.#archive) {
      void this.#openArchive(elements.video, at + e);
      return;
    }
    const position = this.#archive.position();
    if (position === undefined || Math.abs(position - (at + e)) > SCREEN_DRIFT_MS) this.#archive.seek(at + e);
    const video = this.#archive.element;
    if (this.#media.status() === "playing") {
      if (video.paused) void video.play().catch(() => undefined);
    } else if (!video.paused) video.pause();
  }

  close(): void {
    this.#closed = true;
    this.#timers.forEach(clearInterval);
    this.#subs.forEach((s) => s.close());
    this.#stopLive();
    this.#closeArchive();
    this.#listeners.clear();
  }

  async #openArchive(video: HTMLVideoElement, wallMs: number): Promise<void> {
    if (this.#archiveOpening) return;
    this.#archiveOpening = true;
    try {
      video.muted = true; // the speaker's sound is the camera's
      const archive = await openArchive(video, this.#url);
      if (this.#closed || this.#media.mode() === "live" || this.#elements?.video !== video) {
        archive.close();
        return;
      }
      this.#archive = archive;
      await archive.open(wallMs);
    } catch (e) {
      console.warn("screen archive", e);
    } finally {
      this.#archiveOpening = false;
    }
  }

  #closeArchive(): void {
    this.#archive?.close();
    this.#archive = undefined;
  }

  #startLive(canvas: HTMLCanvasElement): void {
    const transport = this.#transport;
    if (this.#live || !(transport instanceof MoqTransport)) return;
    const generation = ++this.#liveGeneration;
    const cleanup: (() => void)[] = [];
    this.#live = { close: () => cleanup.forEach((fn) => fn()) };
    import("@moq/watch")
      .then((Watch) => {
        if (generation !== this.#liveGeneration || !this.#live) return;
        const player = new Watch.Player({
          origin: transport.origin,
          name: Watch.Net.Path.from(teacherPath(this.room)),
          canvas,
          catalogFormat: "hang",
          muted: true,
          // The screen rendition, not the camera. Once the share ends the catalog drops it and `follow` closes this
          // player (the stage hides the screen at the same moment).
          target: { name: SCREEN_TRACK },
          delay: Watch.Net.Time.Milli(500),
        });
        cleanup.push(() => player.close());
      })
      .catch((e: unknown) => console.warn("live screen", e));
  }

  #stopLive(): void {
    this.#liveGeneration++;
    this.#live?.close();
    this.#live = undefined;
  }

  #emit(): void {
    for (const fn of [...this.#listeners]) fn();
  }
}
