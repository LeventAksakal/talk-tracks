// Microphone, camera and a shared screen on talk/<room>/teacher with @moq/publish (decision 0018): one hang
// broadcast whose catalog.json carries the root `clock`, track `audio` (Opus, legacy container: what the captions
// agent reads), track `video` (the camera, H.264, a keyframe every 2 s, so every 4 s slice of the archive's HLS
// starts on one) and, only while the speaker shares, track `screen` (the shared screen, H.264 on the same keyframe
// grid). A shared tab's sound is mixed into `audio`: listeners, the archive and the captions hear one speaker sound.
// The devices open in pre-flight, for the level meter and the self-view, before anything is published; Go on air adds
// the broadcast and the encoders on the same capture. Encoders run only while someone subscribes. Loaded on demand:
// the library is large. The speaker token's publish path is the broadcast, so the screen needs nothing new from it.

import type * as PublishTypes from "@moq/publish";
import { AUDIO_TRACK, SCREEN_TRACK, VIDEO_TRACK, teacherPath } from "../contracts/names";
import type { MoqTransport } from "../transport/moq";
import { type DisplayMedia, ScreenShare } from "./screen";

export { VIDEO_TRACK };
/** ≤ 4 s, so the archive cuts every slice of the HLS on a keyframe (lane briefs, Day-1 checks). */
export const KEYFRAME_MS = 2_000;
/** A shared screen is sent at most this big (about 1080p): text stays readable, upload stays sane. */
export const SCREEN_MAX_PIXELS = 1920 * 1080;

export interface MediaSnapshot {
  micOn: boolean;
  cameraOn: boolean;
  /** The live capture tracks, for the level meter and the self-view. */
  micTrack: MediaStreamTrack | undefined;
  cameraTrack: MediaStreamTrack | undefined;
  micError: string | undefined;
  cameraError: string | undefined;
  micDevices: MediaDeviceInfo[];
  cameraDevices: MediaDeviceInfo[];
  micDevice: string | undefined;
  cameraDevice: string | undefined;
  onAir: boolean;
  /** The shared screen's picture, for the console's preview; undefined while nothing is shared. */
  screenTrack?: MediaStreamTrack | undefined;
  /** The shared tab's or screen's sound goes out with the speaker's. */
  screenAudio?: boolean;
  /** The browser's picker is open. */
  screenStarting?: boolean;
  screenError?: string | undefined;
}

export interface SpeakerMedia {
  snapshot(): MediaSnapshot;
  onChange(fn: (s: MediaSnapshot) => void): () => void;
  setMic(on: boolean): void;
  setCamera(on: boolean): void;
  chooseMic(deviceId: string): void;
  chooseCamera(deviceId: string): void;
  /**
   * Share a screen, window or tab (call from a click: it opens the browser's picker), with its sound when `withAudio`
   * and the browser offers it. On air it goes out at once; before, from Go on air. Absent where screens cannot be
   * shared.
   */
  shareScreen?(withAudio: boolean): Promise<void>;
  /** Stop sharing: the `screen` track ends and leaves the catalog. */
  stopScreen?(): void;
  /** Publish the broadcast (announce it and attach the encoders). */
  goOnAir(): void;
  /** Withdraw the broadcast; the devices stay open. */
  goOffAir(): void;
  close(): void;
}

export interface SpeakerMediaOptions {
  /** getDisplayMedia (tests give a fake). */
  displayMedia?: DisplayMedia;
}

function trackOf(source: unknown): MediaStreamTrack | undefined {
  if (!source) return undefined;
  if (typeof MediaStreamTrack !== "undefined" && source instanceof MediaStreamTrack) return source;
  const track = (source as { track?: unknown }).track;
  return typeof MediaStreamTrack !== "undefined" && track instanceof MediaStreamTrack ? track : undefined;
}

const message = (e: Error | undefined) =>
  !e
    ? undefined
    : e.name === "NotAllowedError"
      ? "Access was refused. Allow it in the address bar's site settings, then turn it on again."
      : e.name === "NotFoundError"
        ? "No such device is connected."
        : e.name === "NotReadableError"
          ? "Another app is using it. Close that app, then turn it on again."
          : e.message;

/** One sound from several tracks (the microphone and a shared tab), through Web Audio. */
function mixTracks(tracks: MediaStreamTrack[]): { track: MediaStreamTrack; close(): void } {
  const ctx = new AudioContext();
  const out = ctx.createMediaStreamDestination();
  const inputs = tracks.map((t) => {
    const node = ctx.createMediaStreamSource(new MediaStream([t]));
    node.connect(out);
    return node;
  });
  void ctx.resume().catch(() => undefined);
  const track = out.stream.getAudioTracks()[0]!;
  return {
    track,
    close() {
      for (const node of inputs) node.disconnect();
      track.stop();
      void ctx.close().catch(() => undefined);
    },
  };
}

export async function createSpeakerMedia(
  transport: MoqTransport,
  room: string,
  options: SpeakerMediaOptions = {},
): Promise<SpeakerMedia> {
  const Publish = await import("@moq/publish");
  const { Signal, Computed } = Publish.Signals;
  const micOn = new Signal(false);
  const cameraOn = new Signal(false);
  const onAir = new Signal(false);
  const microphone = new Publish.Source.Microphone({ enabled: micOn });
  const camera = new Publish.Source.Camera({ enabled: cameraOn });
  const screen = new ScreenShare(options.displayMedia);
  const tabAudio = new Signal<MediaStreamTrack | undefined>(undefined);
  const screenVideo = new Signal<PublishTypes.Video.Source | undefined>(undefined);
  // The speaker's sound: the microphone, mixed with a shared tab's sound while there is one.
  const audioSource = new Computed<PublishTypes.Audio.Source | undefined>((effect) => {
    const mic = effect.get(microphone.out.source)?.audio;
    const tab = effect.get(tabAudio);
    if (!tab) return mic;
    const sources = [trackOf(mic), tab].filter((t): t is MediaStreamTrack => !!t);
    if (sources.length === 1) return tab as PublishTypes.Audio.Source;
    const mix = mixTracks(sources);
    effect.cleanup(() => mix.close());
    return mix.track as PublishTypes.Audio.Source;
  });
  // The sound goes out while the microphone is on or a shared tab's sound is mixed in.
  const soundOn = new Signal(false);
  const syncSound = () => soundOn.set(micOn.peek() || tabAudio.peek() !== undefined);
  const videoSource = new Computed((effect) => effect.get(camera.out.source)?.video);
  const listeners = new Set<(s: MediaSnapshot) => void>();

  let live:
    | {
        broadcast: InstanceType<typeof Publish.Broadcast>;
        audioCapture: InstanceType<typeof Publish.Audio.Capture>;
        audio: InstanceType<typeof Publish.Audio.Encoder>;
        videoCapture: InstanceType<typeof Publish.Video.Capture>;
        video: InstanceType<typeof Publish.Video.Encoder>;
        /** Only while a screen is shared: registered on share, closed (out of the catalog) on stop. */
        screen?: {
          capture: InstanceType<typeof Publish.Video.Capture>;
          encoder: InstanceType<typeof Publish.Video.Encoder>;
        };
      }
    | undefined;

  const snapshot = (): MediaSnapshot => {
    const shared = screen.state();
    return {
      micOn: micOn.peek(),
      cameraOn: cameraOn.peek(),
      micTrack: micOn.peek() ? trackOf(microphone.out.source.peek()?.audio) : undefined,
      cameraTrack: cameraOn.peek() ? trackOf(videoSource.peek()) : undefined,
      micError: message(microphone.out.error.peek()),
      cameraError: message(camera.out.error.peek()),
      micDevices: microphone.device.out.available.peek() ?? [],
      cameraDevices: camera.device.out.available.peek() ?? [],
      micDevice: microphone.device.out.active.peek() ?? microphone.device.preferred.peek(),
      cameraDevice: camera.device.out.active.peek() ?? camera.device.preferred.peek(),
      onAir: onAir.peek(),
      screenTrack: shared.capture?.video,
      screenAudio: !!shared.capture?.audio,
      screenStarting: shared.starting,
      screenError: shared.error,
    };
  };
  let queued = false;
  const emit = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const s = snapshot();
      for (const fn of [...listeners]) fn(s);
    });
  };

  /** The `screen` rendition exists exactly while the broadcast is up and a screen is shared. */
  const syncScreen = () => {
    const capture = screen.state().capture;
    screenVideo.set(capture?.video as PublishTypes.Video.Source | undefined);
    tabAudio.set(capture?.audio);
    if (live && capture && !live.screen) {
      const screenCapture = new Publish.Video.Capture({ source: screenVideo });
      const encoder = new Publish.Video.Encoder(SCREEN_TRACK, {
        broadcast: live.broadcast,
        capture: screenCapture,
        enabled: true,
        config: {
          codec: "avc1",
          keyframeInterval: Publish.Net.Time.Milli(KEYFRAME_MS),
          maxPixels: SCREEN_MAX_PIXELS,
        },
      });
      live.screen = { capture: screenCapture, encoder };
    } else if (live?.screen && !capture) {
      live.screen.encoder.close();
      live.screen.capture.close();
      live.screen = undefined;
    }
  };

  const disposers = [
    micOn.subscribe(syncSound),
    tabAudio.subscribe(syncSound),
    micOn.subscribe(emit),
    cameraOn.subscribe(emit),
    onAir.subscribe(emit),
    microphone.out.source.subscribe(emit),
    audioSource.subscribe(emit),
    videoSource.subscribe(emit),
    microphone.out.error.subscribe(emit),
    camera.out.error.subscribe(emit),
    microphone.device.out.available.subscribe(emit),
    camera.device.out.available.subscribe(emit),
    microphone.device.out.active.subscribe(emit),
    camera.device.out.active.subscribe(emit),
    screen.onChange(() => {
      syncScreen();
      emit();
    }),
  ];

  let closed = false;
  const offAir = () => {
    if (!live) return;
    live.screen?.encoder.close();
    live.screen?.capture.close();
    live.audio.close();
    live.audioCapture.close();
    live.video.close();
    live.videoCapture.close();
    live.broadcast.close();
    live = undefined;
    onAir.set(false);
  };

  return {
    snapshot,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setMic: (on) => micOn.set(on),
    setCamera: (on) => cameraOn.set(on),
    chooseMic: (id) => microphone.device.preferred.set(id),
    chooseCamera: (id) => camera.device.preferred.set(id),
    async shareScreen(withAudio) {
      if (closed) return;
      await screen.start(withAudio);
    },
    stopScreen: () => screen.stop(),
    goOnAir() {
      if (live) return;
      const broadcast = new Publish.Broadcast({
        origin: transport.origin,
        enabled: true,
        announce: true,
        name: Publish.Net.Path.from(teacherPath(room)),
      });
      const audioCapture = new Publish.Audio.Capture({ source: audioSource, channelCount: 1 });
      const audio = new Publish.Audio.Encoder(AUDIO_TRACK, { broadcast, capture: audioCapture, enabled: soundOn });
      const videoCapture = new Publish.Video.Capture({ source: videoSource });
      const video = new Publish.Video.Encoder(VIDEO_TRACK, {
        broadcast,
        capture: videoCapture,
        enabled: cameraOn,
        config: { codec: "avc1", keyframeInterval: Publish.Net.Time.Milli(KEYFRAME_MS) },
      });
      live = { broadcast, audioCapture, audio, videoCapture, video };
      onAir.set(true);
      syncScreen();
    },
    goOffAir: offAir,
    close() {
      if (closed) return;
      closed = true;
      offAir();
      screen.stop();
      for (const d of disposers) d();
      listeners.clear();
      audioSource.close();
      videoSource.close();
      microphone.close();
      camera.close();
    },
  };
}
