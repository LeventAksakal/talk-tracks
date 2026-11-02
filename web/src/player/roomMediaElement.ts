// The room as a media element (decision 0031): `<tt-room-media slot="media">` gives Media Chrome the
// HTMLMediaElement shape it drives (play, pause, currentTime, duration, seekable, playbackRate, volume, muted,
// textTracks and their events) over our own playback: live MoQ, rewound archive and the AI tracks on one room clock.
// It has no shadow root: the stage (slides, camera, overlays) is its light DOM, rendered by React.
//
// Times are the talk's clock in seconds: room ms minus the talk's 00:00 (`origin`, the start of a demo session),
// so Media Chrome's time display and range read like any player. A live room is a DVR stream: duration Infinity,
// seekable from the archive's start to the live edge; an ended talk is a recording, duration its length.

import type { Playback } from "../playback/playback";

/** A subtitle choice offered as a text track: the original or a translation. */
export interface SubtitleChoice {
  /** "original" or the BCP 47 tag of a translation. */
  id: string;
  label: string;
  language: string;
}

/** A chapter as Media Chrome's time range shows it, room ms. */
export interface ChapterCue {
  startMs: number;
  endMs: number;
  title: string;
}

/** How the talk's clock sits on room time, and whether the talk is over. */
export interface TalkSpan {
  /** Room ms of the talk clock's 00:00. */
  origin: number;
  /** The talk has ended: its recording, room ms (an on-demand stream). */
  recording: { start: number; end: number } | undefined;
}

/** Paused live for longer than this, play resumes where it paused (rewound) instead of at the live edge. */
export const RESUME_BEHIND_MS = 10_000;

/** A live position this close to the edge counts as the edge (Media Chrome's live button seeks to seekable.end). */
const AT_EDGE_MS = 1_500;

const HAVE_NOTHING = 0;
const HAVE_CURRENT_DATA = 2;
const HAVE_ENOUGH_DATA = 4;

class Ranges implements TimeRanges {
  readonly #r: [number, number][];
  constructor(ranges: [number, number][]) {
    this.#r = ranges;
  }
  get length() {
    return this.#r.length;
  }
  start(i: number) {
    const r = this.#r[i];
    if (!r) throw new RangeError("index out of range");
    return r[0];
  }
  end(i: number) {
    const r = this.#r[i];
    if (!r) throw new RangeError("index out of range");
    return r[1];
  }
}

interface Cue {
  startTime: number;
  endTime: number;
  text: string;
}

/** A TextTrack-like object: Media Chrome reads kind, label, language and mode, and sets mode. */
export class RoomTextTrack extends EventTarget {
  readonly id: string;
  readonly kind: "subtitles" | "chapters";
  readonly label: string;
  readonly language: string;
  cues: Cue[] = [];
  #mode: TextTrackMode = "disabled";
  #onMode: (track: RoomTextTrack) => void;

  constructor(
    init: { id: string; kind: "subtitles" | "chapters"; label: string; language: string },
    onMode: (track: RoomTextTrack) => void,
  ) {
    super();
    this.id = init.id;
    this.kind = init.kind;
    this.label = init.label;
    this.language = init.language;
    this.#onMode = onMode;
  }
  get mode(): TextTrackMode {
    return this.#mode;
  }
  set mode(mode: TextTrackMode) {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#onMode(this);
  }
  /** Set by the player (no change event back to it). */
  setModeQuietly(mode: TextTrackMode): boolean {
    if (mode === this.#mode) return false;
    this.#mode = mode;
    return true;
  }
  get activeCues(): Cue[] {
    return [];
  }
}

/** A TextTrackList-like list: iterable, indexed, with addtrack, removetrack and change events. */
export class RoomTextTrackList extends EventTarget {
  #tracks: RoomTextTrack[] = [];
  [index: number]: RoomTextTrack;

  get length(): number {
    return this.#tracks.length;
  }
  [Symbol.iterator](): Iterator<RoomTextTrack> {
    return this.#tracks[Symbol.iterator]();
  }
  getTrackById(id: string): RoomTextTrack | null {
    return this.#tracks.find((t) => t.id === id) ?? null;
  }
  list(): readonly RoomTextTrack[] {
    return this.#tracks;
  }
  /** Replace the tracks, telling listeners what was added and removed. */
  set(tracks: RoomTextTrack[]): void {
    const removed = this.#tracks.filter((t) => !tracks.includes(t));
    const added = tracks.filter((t) => !this.#tracks.includes(t));
    for (let i = 0; i < Math.max(this.#tracks.length, tracks.length); i++) {
      if (i < tracks.length) this[i] = tracks[i]!;
      else delete this[i];
    }
    this.#tracks = tracks;
    for (const track of removed) this.dispatchEvent(Object.assign(new Event("removetrack"), { track }));
    for (const track of added) this.dispatchEvent(Object.assign(new Event("addtrack"), { track }));
  }
  changed(): void {
    this.dispatchEvent(new Event("change"));
  }
}

/** Events the element sends to the player (bubbling CustomEvents). */
export interface RoomMediaEvents {
  /** A subtitle choice was picked through Media Chrome (the captions button or C): its id, or null for off. */
  ttsubtitles: CustomEvent<string | null>;
  /** Volume or mute changed through Media Chrome. */
  ttvolume: CustomEvent<{ volume: number; muted: boolean }>;
}

const sameRange = (a: [number, number] | undefined, b: [number, number] | undefined) =>
  a?.[0] === b?.[0] && a?.[1] === b?.[1];

export class RoomMediaElement extends HTMLElement {
  #playback: Playback | undefined;
  #off: (() => void) | undefined;
  #span: TalkSpan = { origin: 0, recording: undefined };
  #paused = true;
  /** Paused while live: the room ms it paused at (the display holds there). */
  #pausedAt: number | undefined;
  /** A seek's target until the media reports a position. */
  #seekTo: number | undefined;
  #rate = 1;
  #volume = 1;
  #muted = false;
  #ended = false;
  #last: {
    duration: number;
    stream: string;
    seekable: [number, number] | undefined;
    ready: number;
    rate: number;
  } = { duration: NaN, stream: "unknown", seekable: undefined, ready: HAVE_NOTHING, rate: 1 };
  readonly textTracks = new RoomTextTrackList();
  #subtitleTracks = new Map<string, RoomTextTrack>();
  #chapters: RoomTextTrack;
  #pipVideo: HTMLVideoElement | undefined;
  #pipSource: (() => HTMLVideoElement | HTMLCanvasElement | undefined) | undefined;

  constructor() {
    super();
    this.#chapters = new RoomTextTrack({ id: "chapters", kind: "chapters", label: "Chapters", language: "" }, () => {});
    this.#chapters.setModeQuietly("hidden");
  }

  // --- what the player sets -------------------------------------------------------------------

  /** What picture-in-picture shows: the archive's video, or the live canvas as a stream. */
  setPipSource(source: (() => HTMLVideoElement | HTMLCanvasElement | undefined) | undefined): void {
    this.#pipSource = source;
  }

  /** The room's playback. A new one (a new demo session) starts where the old one left: paused or playing. */
  get playback(): Playback | undefined {
    return this.#playback;
  }
  set playback(playback: Playback | undefined) {
    this.bind(playback);
  }
  /** Same as setting `playback`. */
  bind(playback: Playback | undefined): void {
    if (playback === this.#playback) return;
    this.#off?.();
    this.#off = undefined;
    const wasPlaying = !this.#paused;
    this.#playback = playback;
    this.#pausedAt = undefined;
    this.#seekTo = undefined;
    this.#ended = false;
    this.#fire("emptied");
    if (!playback) return;
    this.#off = playback.subscribe(() => this.#onChange());
    playback.media.setRate?.(this.#rate);
    this.#fire("loadstart");
    if (wasPlaying) {
      playback.media.play?.();
      this.#fire("play");
    }
    this.#onChange();
  }

  /** The talk's 00:00 and, once it has ended, its recording. */
  setSpan(span: TalkSpan): void {
    if (span.origin === this.#span.origin && sameRange(rangeOf(span.recording), rangeOf(this.#span.recording))) return;
    this.#span = span;
    this.#onChange();
  }

  /** The subtitle choices and the one shown (undefined: off). Mode changes made here send no event back. */
  setSubtitles(choices: readonly SubtitleChoice[], showing: string | undefined): void {
    const next: RoomTextTrack[] = [];
    let changed = false;
    for (const c of choices) {
      let track = this.#subtitleTracks.get(c.id);
      if (!track || track.label !== c.label || track.language !== c.language) {
        track = new RoomTextTrack({ id: c.id, kind: "subtitles", label: c.label, language: c.language }, (t) =>
          this.#onSubtitleMode(t),
        );
        this.#subtitleTracks.set(c.id, track);
      }
      next.push(track);
    }
    for (const id of [...this.#subtitleTracks.keys()])
      if (!choices.some((c) => c.id === id)) this.#subtitleTracks.delete(id);
    for (const track of next) changed = track.setModeQuietly(track.id === showing ? "showing" : "disabled") || changed;
    const list = [...next, this.#chapters];
    const current = this.textTracks.list();
    if (list.length !== current.length || list.some((t, i) => t !== current[i])) this.textTracks.set(list);
    else if (changed) this.textTracks.changed();
  }

  /** The chapters, for the time range's segments and the preview's chapter name. */
  setChapters(chapters: readonly ChapterCue[]): void {
    const origin = this.#span.origin;
    const cues = chapters.map((c) => ({
      startTime: (c.startMs - origin) / 1000,
      endTime: (c.endMs - origin) / 1000,
      text: c.title,
    }));
    const old = this.#chapters.cues;
    if (
      old.length === cues.length &&
      old.every(
        (c, i) => c.startTime === cues[i]!.startTime && c.endTime === cues[i]!.endTime && c.text === cues[i]!.text,
      )
    )
      return;
    this.#chapters.cues = cues;
    this.textTracks.changed();
    // Media Chrome reads chapter cues on loadedmetadata.
    this.#fire("loadedmetadata");
  }

  /** The device's volume preference, without an event back. */
  setVolumeQuietly(volume: number, muted: boolean): void {
    if (volume === this.#volume && muted === this.#muted) return;
    this.#volume = volume;
    this.#muted = muted;
    this.#fire("volumechange");
  }

  // --- HTMLMediaElement ------------------------------------------------------------------------

  get paused(): boolean {
    return this.#paused;
  }

  play(): Promise<void> {
    const pb = this.#playback;
    if (!pb) return Promise.resolve();
    const resumeAt = this.#pausedAt;
    this.#pausedAt = undefined;
    if (this.#ended) {
      this.#ended = false;
      const start = this.#span.recording?.start;
      if (start !== undefined) pb.seek(start);
    } else if (resumeAt !== undefined && pb.media.mode() === "live") {
      const edge = pb.liveEdge();
      if (edge !== undefined && edge - resumeAt > RESUME_BEHIND_MS) {
        this.#seekTo = resumeAt;
        pb.seek(resumeAt);
      }
    }
    pb.media.play?.();
    if (this.#paused) {
      this.#paused = false;
      this.#fire("play");
    }
    this.#fire("playing");
    return Promise.resolve();
  }

  pause(): void {
    const pb = this.#playback;
    if (this.#paused || !pb) return;
    if (pb.media.mode() === "live") this.#pausedAt = pb.position() ?? pb.liveEdge();
    pb.media.pause?.();
    this.#paused = true;
    this.#fire("pause");
    this.#onChange();
  }

  /** Room ms of the playhead: held while paused live; a seek's target until the media reports one. */
  roomTime(): number | undefined {
    const pb = this.#playback;
    if (!pb) return undefined;
    if (this.#pausedAt !== undefined) return this.#pausedAt;
    const pos = pb.media.mode() === "live" ? (pb.position() ?? pb.liveEdge()) : pb.position();
    return pos ?? this.#seekTo;
  }

  get currentTime(): number {
    const t = this.roomTime();
    return t === undefined ? 0 : Math.max(0, (t - this.#span.origin) / 1000);
  }
  set currentTime(seconds: number) {
    const pb = this.#playback;
    if (!pb || !Number.isFinite(seconds)) return;
    const ms = seconds * 1000 + this.#span.origin;
    const edge = this.#span.recording ? undefined : pb.liveEdge();
    this.#pausedAt = undefined;
    this.#ended = false;
    this.#fire("seeking");
    if (edge !== undefined && edge - ms < AT_EDGE_MS) {
      this.#seekTo = undefined;
      pb.goLive();
    } else {
      this.#seekTo = ms;
      pb.seek(ms);
    }
    // A seek plays, as it always has here (the archive opens playing): the state says so.
    if (this.#paused) void this.play();
    this.#fire("seeked");
    this.#fire("timeupdate");
  }

  /** Back to the live edge (Go live, G). */
  goLive(): void {
    const pb = this.#playback;
    if (!pb) return;
    this.#pausedAt = undefined;
    this.#seekTo = undefined;
    pb.goLive();
    if (this.#paused) void this.play();
    this.#fire("timeupdate");
  }

  get duration(): number {
    const rec = this.#span.recording;
    if (rec) return Math.max(0, (rec.end - this.#span.origin) / 1000);
    return this.#playback?.liveEdge() === undefined ? NaN : Infinity;
  }

  get seekable(): TimeRanges {
    const r = this.#seekableRange();
    return new Ranges(r ? [r] : []);
  }

  get buffered(): TimeRanges {
    const t = this.#playback?.getSnapshot().timeline;
    const origin = this.#span.origin;
    return new Ranges(
      (t?.buffered ?? []).map((r) => [Math.max(0, (r.start - origin) / 1000), Math.max(0, (r.end - origin) / 1000)]),
    );
  }

  /** "live" while the talk runs (a DVR stream), "on-demand" once it is a recording. */
  get streamType(): "live" | "on-demand" | "unknown" {
    if (this.#span.recording) return "on-demand";
    return this.#playback?.liveEdge() === undefined ? "unknown" : "live";
  }
  /** The whole talk so far can be sought. */
  get targetLiveWindow(): number {
    return this.streamType === "live" ? Infinity : NaN;
  }
  /** At the live edge while playing live; never while rewound or paused. */
  get liveEdgeStart(): number {
    const pb = this.#playback;
    if (!pb || this.streamType !== "live" || pb.media.mode() !== "live" || this.#pausedAt !== undefined) return NaN;
    return this.currentTime;
  }

  get ended(): boolean {
    return this.#ended;
  }
  get readyState(): number {
    const pb = this.#playback;
    if (!pb || pb.liveEdge() === undefined) return HAVE_NOTHING;
    return pb.media.status() === "loading" ? HAVE_CURRENT_DATA : HAVE_ENOUGH_DATA;
  }
  get seeking(): boolean {
    return this.#playback?.media.status() === "loading" && this.#seekTo !== undefined;
  }
  get error(): MediaError | null {
    return null;
  }
  get src(): string {
    return this.#playback ? "room" : "";
  }
  get preload(): string {
    return "auto";
  }

  /** Live plays at 1×; a recording or a rewind at the picked rate. */
  get playbackRate(): number {
    return this.#playback?.media.mode() === "live" && !this.#span.recording ? 1 : this.#rate;
  }
  set playbackRate(rate: number) {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.#rate = rate;
    this.#playback?.media.setRate?.(rate);
    this.#fire("ratechange");
  }
  get defaultPlaybackRate(): number {
    return 1;
  }

  get volume(): number {
    return this.#volume;
  }
  set volume(volume: number) {
    const v = Math.min(1, Math.max(0, Number(volume)));
    if (!Number.isFinite(v) || v === this.#volume) return;
    this.#volume = v;
    this.#volumeChanged();
  }
  get muted(): boolean {
    return this.#muted;
  }
  set muted(muted: boolean) {
    if (!!muted === this.#muted) return;
    this.#muted = !!muted;
    this.#volumeChanged();
  }

  /** Picture-in-picture shows the speaker's video: the archive element, or the live canvas as a stream. */
  get disablePictureInPicture(): boolean {
    return false;
  }
  async requestPictureInPicture(): Promise<PictureInPictureWindow> {
    const source = this.#pipSource?.();
    if (!source) throw new DOMException("No video to show in picture-in-picture", "InvalidStateError");
    let video: HTMLVideoElement;
    if (source instanceof HTMLVideoElement) video = source;
    else {
      video = this.#pipVideo ??= this.#makePipVideo();
      video.srcObject = source.captureStream();
      await video.play().catch(() => {});
    }
    const onEnter = () => this.#fire("enterpictureinpicture");
    const onLeave = () => {
      this.#fire("leavepictureinpicture");
      video.removeEventListener("enterpictureinpicture", onEnter);
      video.removeEventListener("leavepictureinpicture", onLeave);
      if (video === this.#pipVideo) video.srcObject = null;
    };
    video.addEventListener("enterpictureinpicture", onEnter);
    video.addEventListener("leavepictureinpicture", onLeave);
    return video.requestPictureInPicture();
  }

  disconnectedCallback(): void {
    if (document.pictureInPictureElement && this.contains(document.pictureInPictureElement))
      void document.exitPictureInPicture().catch(() => {});
  }

  // --- inside -------------------------------------------------------------------------------------

  #makePipVideo(): HTMLVideoElement {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.className = "tt-pip-video";
    video.setAttribute("aria-hidden", "true");
    this.append(video);
    return video;
  }

  #seekableRange(): [number, number] | undefined {
    const pb = this.#playback;
    if (!pb) return undefined;
    const t = pb.getSnapshot().timeline;
    const origin = this.#span.origin;
    const rec = this.#span.recording;
    const end = rec?.end ?? t.liveEdge;
    if (end === undefined) return undefined;
    const start = Math.max(origin, rec?.start ?? t.start);
    return [Math.max(0, (start - origin) / 1000), Math.max(0, (end - origin) / 1000)];
  }

  #onSubtitleMode(track: RoomTextTrack): void {
    // One subtitle track shows at a time; Media Chrome turns the others off itself, and the player redraws.
    if (track.mode === "showing")
      for (const t of this.#subtitleTracks.values()) if (t !== track) t.setModeQuietly("disabled");
    const showing = [...this.#subtitleTracks.values()].find((t) => t.mode === "showing");
    this.textTracks.changed();
    this.dispatchEvent(new CustomEvent("ttsubtitles", { detail: showing?.id ?? null, bubbles: true }));
  }

  #volumeChanged(): void {
    this.#fire("volumechange");
    this.dispatchEvent(
      new CustomEvent("ttvolume", { detail: { volume: this.#volume, muted: this.#muted }, bubbles: true }),
    );
  }

  #onChange(): void {
    const pb = this.#playback;
    if (!pb) return;
    if (this.#seekTo !== undefined && pb.position() !== undefined) this.#seekTo = undefined;
    // The recording played to its end.
    const rec = this.#span.recording;
    const t = this.roomTime();
    if (rec && !this.#paused && t !== undefined && t >= rec.end - 250 && pb.media.mode() === "rewound") {
      this.#ended = true;
      this.#paused = true;
      pb.media.pause?.();
      this.#fire("pause");
      this.#fire("ended");
    }
    const now = {
      duration: this.duration,
      stream: this.streamType,
      seekable: this.#seekableRange(),
      ready: this.readyState,
      rate: this.playbackRate,
    };
    const last = this.#last;
    this.#last = now;
    if (!Object.is(now.duration, last.duration)) this.#fire("durationchange");
    if (now.stream !== last.stream) {
      this.#fire("streamtypechange");
      this.#fire("targetlivewindowchange");
    }
    if (!sameRange(now.seekable, last.seekable)) {
      this.#fire("seekablechange");
      this.#fire("progress");
    }
    if (now.ready !== last.ready) {
      if (now.ready < HAVE_ENOUGH_DATA) this.#fire("waiting");
      else {
        if (last.ready === HAVE_NOTHING) this.#fire("loadedmetadata");
        if (!this.#paused) this.#fire("playing");
      }
    }
    if (now.rate !== last.rate) this.#fire("ratechange");
    this.#fire("timeupdate");
  }

  #fire(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}

function rangeOf(r: { start: number; end: number } | undefined): [number, number] | undefined {
  return r ? [r.start, r.end] : undefined;
}

export const ROOM_MEDIA_TAG = "tt-room-media";

if (typeof customElements !== "undefined" && !customElements.get(ROOM_MEDIA_TAG))
  customElements.define(ROOM_MEDIA_TAG, RoomMediaElement);
