// Development only (/talk/<room>?offline): the microphone, camera and screen from the browser, with nothing
// published, so the console can be seen and tried with no relay. "On air" is a flag here.

import type { MediaSnapshot, SpeakerMedia } from "./media";

export async function createPreviewMedia(): Promise<SpeakerMedia> {
  const listeners = new Set<(s: MediaSnapshot) => void>();
  let mic: MediaStreamTrack | undefined;
  let cam: MediaStreamTrack | undefined;
  let screen: MediaStreamTrack | undefined;
  let s: MediaSnapshot = {
    micOn: false,
    cameraOn: false,
    micTrack: undefined,
    cameraTrack: undefined,
    micError: undefined,
    cameraError: undefined,
    micDevices: [],
    cameraDevices: [],
    micDevice: undefined,
    cameraDevice: undefined,
    onAir: false,
  };
  const set = (patch: Partial<MediaSnapshot>) => {
    s = { ...s, ...patch };
    for (const fn of listeners) fn(s);
  };
  const devices = async () => {
    const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    set({
      micDevices: all.filter((d) => d.kind === "audioinput"),
      cameraDevices: all.filter((d) => d.kind === "videoinput"),
    });
  };
  const open = async (kind: "audio" | "video") => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ [kind]: true });
      return stream.getTracks()[0];
    } catch (e) {
      set(kind === "audio" ? { micError: String(e) } : { cameraError: String(e) });
      return undefined;
    }
  };
  void devices();
  return {
    snapshot: () => s,
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setMic: (on) => {
      set({ micOn: on });
      if (on && !mic) void open("audio").then((t) => set({ micTrack: (mic = t) }));
      if (!on) {
        mic?.stop();
        set({ micTrack: (mic = undefined) });
      }
    },
    setCamera: (on) => {
      set({ cameraOn: on });
      if (on && !cam) void open("video").then((t) => set({ cameraTrack: (cam = t) }));
      if (!on) {
        cam?.stop();
        set({ cameraTrack: (cam = undefined) });
      }
    },
    chooseMic: (id) => set({ micDevice: id }),
    chooseCamera: (id) => set({ cameraDevice: id }),
    shareScreen: async (withAudio) => {
      set({ screenStarting: true });
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: withAudio });
        screen = stream.getVideoTracks()[0];
        screen?.addEventListener("ended", () => set({ screenTrack: (screen = undefined) }));
        set({ screenTrack: screen, screenAudio: withAudio && stream.getAudioTracks().length > 0 });
      } catch (e) {
        set({ screenError: String(e) });
      } finally {
        set({ screenStarting: false });
      }
    },
    stopScreen: () => {
      screen?.stop();
      set({ screenTrack: (screen = undefined), screenAudio: false });
    },
    goOnAir: () => set({ onAir: true }),
    goOffAir: () => set({ onAir: false }),
    close: () => {
      for (const t of [mic, cam, screen]) t?.stop();
    },
  };
}
