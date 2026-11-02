import { describe, expect, it } from "vitest";
import { ScreenShare } from "./screen";

/** A capture track as getDisplayMedia hands it out: stop() ends it quietly; the browser's own bar fires "ended". */
class FakeTrack extends EventTarget {
  readyState: "live" | "ended" = "live";
  contentHint = "";
  constructor(readonly kind: "video" | "audio") {
    super();
  }
  stop() {
    this.readyState = "ended";
  }
  /** The browser's "Stop sharing" bar. */
  endFromBrowser() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

function fakeStream(...tracks: FakeTrack[]): MediaStream {
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
  } as unknown as MediaStream;
}

describe("sharing a screen", () => {
  it("shares the picture and, when asked, the tab's sound; the browser's own stop ends it", async () => {
    const video = new FakeTrack("video");
    const audio = new FakeTrack("audio");
    const asked: DisplayMediaStreamOptions[] = [];
    const share = new ScreenShare(async (options) => (asked.push(options), fakeStream(video, audio)));
    let changes = 0;
    share.onChange(() => changes++);

    expect(await share.start(true)).toBe(true);
    expect(asked[0]?.audio).toBe(true);
    expect(share.state().capture).toEqual({ video, audio });

    video.endFromBrowser();
    expect(share.state().capture).toBeUndefined();
    expect(audio.readyState).toBe("ended"); // the sound stops with the picture
    expect(changes).toBeGreaterThan(1);
  });

  it("leaves the sound out unless asked, and stops every track on Stop sharing", async () => {
    const video = new FakeTrack("video");
    const audio = new FakeTrack("audio");
    const share = new ScreenShare(async () => fakeStream(video, audio));
    await share.start(false);
    expect(share.state().capture).toEqual({ video, audio: undefined });
    expect(audio.readyState).toBe("ended"); // offered anyway: not kept

    share.stop();
    expect(share.state().capture).toBeUndefined();
    expect(video.readyState).toBe("ended");
  });

  it("keeps the picture when only the tab's sound ends", async () => {
    const video = new FakeTrack("video");
    const audio = new FakeTrack("audio");
    const share = new ScreenShare(async () => fakeStream(video, audio));
    await share.start(true);
    audio.endFromBrowser();
    expect(share.state().capture).toEqual({ video, audio: undefined });
  });

  it("treats a cancelled picker as no share and no error, and says why when capture fails", async () => {
    const cancelled = new ScreenShare(async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });
    expect(await cancelled.start(false)).toBe(false);
    expect(cancelled.state()).toEqual({ capture: undefined, starting: false, error: undefined });

    const broken = new ScreenShare(async () => {
      throw new DOMException("Could not start video source", "NotReadableError");
    });
    expect(await broken.start(false)).toBe(false);
    expect(broken.state().error).toBeTruthy();
  });

  it("drops a picture that arrives after Stop sharing was pressed while the picker was open", async () => {
    const video = new FakeTrack("video");
    let resolve!: (s: MediaStream) => void;
    const share = new ScreenShare(() => new Promise((r) => (resolve = r)));
    const started = share.start(false);
    expect(share.state().starting).toBe(true);
    share.stop();
    resolve(fakeStream(video));
    expect(await started).toBe(false);
    expect(share.state().capture).toBeUndefined();
    expect(video.readyState).toBe("ended");
  });
});
