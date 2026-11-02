// The speaker's shared screen (getDisplayMedia): a screen, window or tab the speaker picks, and, when asked and the
// browser offers it (a tab, or a whole screen on Windows and ChromeOS), its sound. media.ts publishes the picture as
// the teacher broadcast's `screen` rendition and mixes the sound into `audio`. The share ends from the console's
// Stop sharing, or from the browser's own "Stop sharing" bar (the video track ends): both land in stop().

export interface ScreenCapture {
  video: MediaStreamTrack;
  /** The shared tab's or screen's sound; undefined when not asked for or not offered. */
  audio: MediaStreamTrack | undefined;
}

export interface ScreenState {
  capture: ScreenCapture | undefined;
  /** The browser's picker is open. */
  starting: boolean;
  error: string | undefined;
}

export type DisplayMedia = (options: DisplayMediaStreamOptions) => Promise<MediaStream>;

const defaultDisplayMedia: DisplayMedia = (options) => {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("This browser cannot share a screen.");
  return navigator.mediaDevices.getDisplayMedia(options);
};

function message(e: unknown): string | undefined {
  const name = e instanceof Error || e instanceof DOMException ? e.name : undefined;
  // Cancelling the picker is a choice, not an error.
  if (name === "NotAllowedError" || name === "AbortError") return undefined;
  if (name === "NotReadableError") return "The screen could not be captured. Close what holds it, then try again.";
  if (name === "NotFoundError") return "There was nothing to share.";
  return e instanceof Error ? e.message : String(e);
}

export class ScreenShare {
  #displayMedia: DisplayMedia;
  #state: ScreenState = { capture: undefined, starting: false, error: undefined };
  #listeners = new Set<() => void>();
  #generation = 0;

  constructor(displayMedia: DisplayMedia = defaultDisplayMedia) {
    this.#displayMedia = displayMedia;
  }

  state(): ScreenState {
    return this.#state;
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Open the browser's picker (call from a click). True once something is shared. */
  async start(withAudio: boolean): Promise<boolean> {
    if (this.#state.capture || this.#state.starting) return !!this.#state.capture;
    const generation = ++this.#generation;
    this.#set({ starting: true, error: undefined });
    let stream: MediaStream;
    try {
      stream = await this.#displayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: withAudio,
        // Chrome's hints: the console's own tab is never offered, the speaker may switch what is shared.
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
        systemAudio: withAudio ? "include" : "exclude",
      } as DisplayMediaStreamOptions);
    } catch (e) {
      if (generation === this.#generation) this.#set({ starting: false, error: message(e) });
      return false;
    }
    const video = stream.getVideoTracks()[0];
    const audio = withAudio ? stream.getAudioTracks()[0] : undefined;
    for (const t of stream.getTracks()) if (t !== video && t !== audio) t.stop();
    if (generation !== this.#generation || !video || video.readyState === "ended") {
      video?.stop();
      audio?.stop();
      if (generation === this.#generation)
        this.#set({ starting: false, error: video ? undefined : "No picture was shared." });
      return false;
    }
    // Text and code stay sharp rather than smooth.
    if ("contentHint" in video) video.contentHint = "detail";
    // The browser's own Stop sharing ends the picture: the share is over. A tab's sound can end alone.
    video.addEventListener("ended", () => {
      if (this.#state.capture?.video === video) this.stop();
    });
    audio?.addEventListener("ended", () => {
      const capture = this.#state.capture;
      if (capture?.audio === audio) this.#set({ capture: { ...capture, audio: undefined } });
    });
    this.#set({ starting: false, capture: { video, audio } });
    return true;
  }

  /** End the share: the picture and its sound stop, and the browser's sharing bar goes. */
  stop(): void {
    this.#generation++;
    const capture = this.#state.capture;
    capture?.video.stop();
    capture?.audio?.stop();
    if (capture || this.#state.starting) this.#set({ capture: undefined, starting: false });
  }

  #set(patch: Partial<ScreenState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const fn of [...this.#listeners]) fn();
  }
}
