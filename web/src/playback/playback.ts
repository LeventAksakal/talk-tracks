// One room's playback: the speaker media and every opted-in AI track on one media clock. Seek moves
// both; Go live returns both to the relay and says what was skipped.

import { AiTracks, type AiTracksOptions, type AiTracksView } from "./aiTracks";
import type { SpeakerMedia } from "./media";
import type { HistorySource } from "./source";
import { buildTimeline, chaptersIn, type Missed, MISSED_MIN_MS, type TimelineView } from "./timeline";

export interface PlaybackView {
  timeline: TimelineView;
  tracks: AiTracksView;
  missed: Missed | undefined;
}

export interface PlaybackOptions extends AiTracksOptions {
  /** Rewound media this close to live, with nothing more archived, goes live by itself, ms. */
  catchUpMs?: number;
  /** Run on close, after everything else (to stop whatever drives a fake room). */
  onClose?: () => void;
}

export class Playback {
  readonly tracks: AiTracks;
  readonly media: SpeakerMedia;
  #catchUpMs: number;
  #missed: Missed | undefined;
  #awayFrom: number | undefined;
  #listeners = new Set<() => void>();
  #view: PlaybackView | undefined;
  #disposers: (() => void)[] = [];
  #onClose: (() => void) | undefined;
  /** The outline track switched on only to list the chapters missed; switched off on dismiss. */
  #outlineForMissed: string | undefined;

  constructor(source: HistorySource, media: SpeakerMedia, room: string, options: PlaybackOptions = {}) {
    this.media = media;
    this.tracks = new AiTracks(source, room, options);
    this.#catchUpMs = options.catchUpMs ?? 8_000;
    this.#onClose = options.onClose;
    this.#disposers.push(this.tracks.subscribe(() => this.#changed()));
    this.#disposers.push(media.onChange(() => this.#onMedia()));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): PlaybackView => (this.#view ??= this.#buildView());

  /** Rewind (or move) the speaker media and every opted-in track to media time `ms`. */
  seek(ms: number): void {
    const edge = this.liveEdge();
    const target = Math.max(0, edge === undefined ? ms : Math.min(ms, edge));
    if (edge !== undefined && edge - target < 1_000) return this.goLive();
    this.#missed = undefined;
    this.media.seek(target);
    this.tracks.seek(target);
  }

  /** Move by `deltaMs` from the playhead (negative: back). */
  seekBy(deltaMs: number): void {
    const from = this.position() ?? this.liveEdge();
    if (from !== undefined) this.seek(from + deltaMs);
  }

  /** Back to the relay: live media and live tracks. Whatever was skipped becomes "what you missed". */
  goLive(): void {
    const from = this.media.mode() === "rewound" ? this.position() : undefined;
    const to = this.liveEdge();
    this.media.goLive();
    this.tracks.goLive();
    if (from !== undefined) this.#setMissed(from, to, "rewound");
    this.#changed();
  }

  /** The tab was hidden (true) or shown again (false); time spent away while live counts as missed. */
  setAway(away: boolean): void {
    if (this.media.mode() !== "live") return;
    if (away) {
      this.#awayFrom = this.liveEdge();
      return;
    }
    const from = this.#awayFrom;
    this.#awayFrom = undefined;
    if (from !== undefined) this.#setMissed(from, this.liveEdge(), "away");
  }

  dismissMissed(): void {
    this.#missed = undefined;
    if (this.#outlineForMissed) this.tracks.setEnabled(this.#outlineForMissed, false);
    this.#outlineForMissed = undefined;
    this.#changed();
  }

  /** Fetch the captions over the missed range (one FETCH per slice, on request only). */
  async loadMissedTranscript(): Promise<void> {
    const missed = this.#missed;
    const captions = this.tracks.getSnapshot().tracks.find((t) => t.kind === "captions");
    if (!missed || !captions) return;
    this.#missed = { ...missed, transcriptLoading: true };
    this.#changed();
    const lines = await this.tracks.transcript(captions.id, missed.fromMs, missed.toMs);
    if (this.#missed?.fromMs !== missed.fromMs) return;
    this.#missed = { ...this.#missed, transcript: lines, transcriptLoading: false };
    this.#changed();
  }

  position(): number | undefined {
    return this.media.mode() === "rewound"
      ? (this.media.position() ?? this.tracks.getSnapshot().position)
      : this.media.position();
  }

  liveEdge(): number | undefined {
    return this.media.liveEdge() ?? this.tracks.getSnapshot().liveEdgeMs;
  }

  close(): void {
    for (const fn of this.#disposers) fn();
    this.tracks.close();
    this.media.close();
    this.#listeners.clear();
    this.#onClose?.();
  }

  #onMedia(): void {
    const edge = this.media.liveEdge();
    this.tracks.setLiveEdge(edge);
    if (this.media.mode() === "rewound") {
      const pos = this.media.position();
      if (pos !== undefined) this.tracks.setPosition(pos);
      if (pos !== undefined && edge !== undefined && this.#caughtUp(pos, edge)) this.goLive();
    }
    this.#changed();
  }

  /**
   * Rewound playback reached live: the playhead is at the edge, or it played out the archive (which
   * trails live by a segment or two) and is within `catchUpMs` of the edge plus that lag.
   */
  #caughtUp(pos: number, edge: number): boolean {
    if (pos >= edge - 250) return true;
    const archivedEnd = this.media.available().at(-1)?.end;
    if (archivedEnd === undefined || this.media.status() === "no-media") return false;
    return pos >= archivedEnd - 500 && edge - archivedEnd < this.#catchUpMs + 12_000;
  }

  #setMissed(from: number, to: number | undefined, reason: Missed["reason"]): void {
    if (to === undefined || to - from < MISSED_MIN_MS) return;
    const outlineTrack = this.tracks.getSnapshot().tracks.find((t) => t.kind === "outline");
    // The chapters come from the outline's latest snapshot: subscribe for it while the summary shows.
    if (outlineTrack?.announced && !outlineTrack.enabled) {
      this.#outlineForMissed = outlineTrack.id;
      this.tracks.setEnabled(outlineTrack.id, true);
    }
    this.#missed = {
      fromMs: from,
      toMs: to,
      reason,
      chapters: chaptersIn(outlineTrack?.outline, from, to),
      outlineOn: outlineTrack?.enabled ?? false,
      transcript: undefined,
      transcriptLoading: false,
    };
    this.#changed();
  }

  #changed(): void {
    this.#view = undefined;
    for (const fn of [...this.#listeners]) fn();
  }

  #buildView(): PlaybackView {
    const tracks = this.tracks.getSnapshot();
    const timeline = buildTimeline({
      mode: this.media.mode(),
      position: this.position(),
      liveEdge: this.liveEdge(),
      available: this.media.available(),
      buffered: this.media.buffered(),
      held: tracks.tracks.filter((t) => t.enabled).map((t) => t.held),
      mediaStatus: this.media.status(),
    });
    // The chapters list follows outline revisions that arrive after going live.
    let missed = this.#missed;
    if (missed) {
      const outline = tracks.tracks.find((t) => t.kind === "outline");
      missed = {
        ...missed,
        chapters: chaptersIn(outline?.outline, missed.fromMs, missed.toMs),
        outlineOn: outline?.enabled ?? false,
      };
    }
    return { timeline, tracks, missed };
  }
}
