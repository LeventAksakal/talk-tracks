// Microphone and camera on talk/<room>/teacher with @moq/publish (decision 0018): one hang broadcast
// whose catalog.json carries the root `clock`, track `audio` (Opus, legacy container: what the captions
// agent reads) and track `video` (H.264, a keyframe every 2 s, so every 4 s slice of the archive's HLS
// starts on one). The devices open in pre-flight, for the level meter and the self-view, before
// anything is published; Go on air adds the broadcast and the encoders on the same capture. Encoders
// run only while someone subscribes. Loaded on demand: the library is large.

import { AUDIO_TRACK, teacherPath } from "../contracts/names";
import type { MoqTransport } from "../transport/moq";

/** The camera's rendition in the hang catalog (as the demo lectures name it). */
export const VIDEO_TRACK = "video";
/** ≤ 4 s, so the archive cuts every slice of the HLS on a keyframe (lane briefs, Day-1 checks). */
export const KEYFRAME_MS = 2_000;

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
}

export interface SpeakerMedia {
  snapshot(): MediaSnapshot;
  onChange(fn: (s: MediaSnapshot) => void): () => void;
  setMic(on: boolean): void;
  setCamera(on: boolean): void;
  chooseMic(deviceId: string): void;
  chooseCamera(deviceId: string): void;
  /** Publish the broadcast (announce it and attach the encoders). */
  goOnAir(): void;
  /** Withdraw the broadcast; the devices stay open. */
  goOffAir(): void;
  close(): void;
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

export async function createSpeakerMedia(transport: MoqTransport, room: string): Promise<SpeakerMedia> {
  const Publish = await import("@moq/publish");
  const { Signal, Computed } = Publish.Signals;
  const micOn = new Signal(false);
  const cameraOn = new Signal(false);
  const onAir = new Signal(false);
  const microphone = new Publish.Source.Microphone({ enabled: micOn });
  const camera = new Publish.Source.Camera({ enabled: cameraOn });
  const audioSource = new Computed((effect) => effect.get(microphone.out.source)?.audio);
  const videoSource = new Computed((effect) => effect.get(camera.out.source)?.video);
  const listeners = new Set<(s: MediaSnapshot) => void>();

  let live:
    | {
        broadcast: InstanceType<typeof Publish.Broadcast>;
        audioCapture: InstanceType<typeof Publish.Audio.Capture>;
        audio: InstanceType<typeof Publish.Audio.Encoder>;
        videoCapture: InstanceType<typeof Publish.Video.Capture>;
        video: InstanceType<typeof Publish.Video.Encoder>;
      }
    | undefined;

  const snapshot = (): MediaSnapshot => ({
    micOn: micOn.peek(),
    cameraOn: cameraOn.peek(),
    micTrack: micOn.peek() ? trackOf(audioSource.peek()) : undefined,
    cameraTrack: cameraOn.peek() ? trackOf(videoSource.peek()) : undefined,
    micError: message(microphone.out.error.peek()),
    cameraError: message(camera.out.error.peek()),
    micDevices: microphone.device.out.available.peek() ?? [],
    cameraDevices: camera.device.out.available.peek() ?? [],
    micDevice: microphone.device.out.active.peek() ?? microphone.device.preferred.peek(),
    cameraDevice: camera.device.out.active.peek() ?? camera.device.preferred.peek(),
    onAir: onAir.peek(),
  });
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
  const disposers = [
    micOn.subscribe(emit),
    cameraOn.subscribe(emit),
    onAir.subscribe(emit),
    audioSource.subscribe(emit),
    videoSource.subscribe(emit),
    microphone.out.error.subscribe(emit),
    camera.out.error.subscribe(emit),
    microphone.device.out.available.subscribe(emit),
    camera.device.out.available.subscribe(emit),
    microphone.device.out.active.subscribe(emit),
    camera.device.out.active.subscribe(emit),
  ];

  let closed = false;
  const offAir = () => {
    if (!live) return;
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
    goOnAir() {
      if (live) return;
      const broadcast = new Publish.Broadcast({
        origin: transport.origin,
        enabled: true,
        announce: true,
        name: Publish.Net.Path.from(teacherPath(room)),
      });
      const audioCapture = new Publish.Audio.Capture({ source: audioSource, channelCount: 1 });
      const audio = new Publish.Audio.Encoder(AUDIO_TRACK, { broadcast, capture: audioCapture, enabled: micOn });
      const videoCapture = new Publish.Video.Capture({ source: videoSource });
      const video = new Publish.Video.Encoder(VIDEO_TRACK, {
        broadcast,
        capture: videoCapture,
        enabled: cameraOn,
        config: { codec: "avc1", keyframeInterval: Publish.Net.Time.Milli(KEYFRAME_MS) },
      });
      live = { broadcast, audioCapture, audio, videoCapture, video };
      onAir.set(true);
    },
    goOffAir: offAir,
    close() {
      if (closed) return;
      closed = true;
      offAir();
      for (const d of disposers) d();
      listeners.clear();
      audioSource.close();
      videoSource.close();
      microphone.close();
      camera.close();
    },
  };
}
