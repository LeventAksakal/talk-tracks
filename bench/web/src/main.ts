// The benchmark viewer: plays the source over one protocol and measures every rendered frame.
//
//   ?proto=moq      Talk Tracks' path: @moq/watch over WebTransport (WebSocket only if WebTransport fails)
//   ?proto=moq-ws   the same with WebTransport removed, as Safari runs it (WebSocket over TCP)
//   ?proto=hls      LL-HLS from MediaMTX through hls.js in low-latency mode
//   ?proto=webrtc   WebRTC from MediaMTX through a plain WHEP client
//
// Each frame carries the time it was made as a barcode (bench/source.sh); latency is this page's clock minus it.
// The result lands in `window.__bench` for the Playwright runner (bench/runner/run.mjs).
import type * as MoqNet from "@moq/net";
import Hls from "hls.js";

type Proto = "moq" | "moq-ws" | "hls" | "webrtc";

interface Result {
  proto: Proto;
  params: Record<string, string>;
  /** performance.now() when the player was created; navigation start is 0. */
  startMs: number;
  /** First decoded frame, from the player's creation and from navigation start. */
  joinMs?: number;
  joinFromNavMs?: number;
  /** One entry per rendered frame: [ms since the first frame, glass-to-glass latency in ms]. */
  frames: [number, number][];
  /** One entry per text object: [ms since the first frame, publish-to-receive latency in ms]. */
  text: [number, number][];
  /** Frames whose barcode did not decode to a plausible time. */
  unreadable: number;
  transport?: string;
  width?: number;
  errors: string[];
}

declare global {
  interface Window {
    __bench: { done: boolean; result: Result };
  }
}

const params = new URLSearchParams(location.search);
const proto = (params.get("proto") ?? "moq") as Proto;
const seconds = Number(params.get("seconds") ?? "20");
const moqDelayMs = Number(params.get("delay") ?? "500"); // the viewer's setting in web/src/viewer/TeacherMedia.tsx
const relay = params.get("relay") ?? "http://relay:4443/";
const mediamtx = params.get("mediamtx") ?? "http://mediamtx";

const result: Result = {
  proto,
  params: Object.fromEntries(params),
  startMs: 0,
  frames: [],
  text: [],
  unreadable: 0,
  errors: [],
};
window.__bench = { done: false, result };

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const video = document.getElementById("video") as HTMLVideoElement;
const logEl = document.getElementById("log") as HTMLPreElement;
const log = (line: string) => {
  logEl.textContent += line + "\n";
  console.log(line);
};

const now = () => performance.timeOrigin + performance.now();

// --- the barcode -------------------------------------------------------------------------------------------------

const strip = new OffscreenCanvas(1280, 80).getContext("2d", { willReadFrequently: true })!;

/** The frame's birth time (Unix ms modulo 2^32), or undefined when the blocks don't read cleanly. */
function readBarcode(source: CanvasImageSource, width: number): number | undefined {
  const scale = width / 1280;
  strip.drawImage(source, 0, 0, 1280 * scale, 80 * scale, 0, 0, 1280, 80);
  const { data } = strip.getImageData(0, 0, 1280, 80);
  let value = 0;
  for (let i = 0; i < 32; i++) {
    const x0 = (i % 16) * 80 + 30;
    const y0 = Math.floor(i / 16) * 40 + 15;
    let sum = 0;
    for (let y = y0; y < y0 + 10; y++) for (let x = x0; x < x0 + 20; x++) sum += data[(y * 1280 + x) * 4];
    const mean = sum / 200;
    if (mean > 64 && mean < 192) return undefined; // neither black nor white: a smeared or mid-transition frame
    if (mean >= 192) value += 2 ** i;
  }
  return value;
}

let firstFrameAt: number | undefined;
let finishTimer: ReturnType<typeof setTimeout> | undefined;

function onFrame(source: CanvasImageSource, width: number) {
  const at = now();
  const born = readBarcode(source, width);
  const latency = born === undefined ? undefined : (((Math.floor(at) - born) % 2 ** 32) + 2 ** 32) % 2 ** 32;
  if (latency === undefined || latency > 60_000) {
    result.unreadable++;
    return;
  }
  if (firstFrameAt === undefined) {
    firstFrameAt = at;
    result.width = width;
    result.joinMs = performance.now() - result.startMs;
    result.joinFromNavMs = performance.now();
    log(`${proto}: first frame after ${result.joinMs.toFixed(0)} ms, latency ${latency} ms`);
    finishTimer = setTimeout(finish, seconds * 1000);
  }
  result.frames.push([Math.round(at - firstFrameAt), latency]);
}

function onText(t: number) {
  if (firstFrameAt === undefined) return; // count text only while the media plays
  const at = now();
  result.text.push([Math.round(at - firstFrameAt), Math.round((at - t) * 10) / 10]);
}

function finish() {
  clearTimeout(finishTimer);
  if (window.__bench.done) return;
  log(`${proto}: done, ${result.frames.length} frames, ${result.text.length} text objects`);
  window.__bench.done = true;
}

/** Frames of a <video> element as they are presented. */
function watchVideoElement() {
  const onVideoFrame = () => {
    if (video.videoWidth) onFrame(video, video.videoWidth);
    video.requestVideoFrameCallback(onVideoFrame);
  };
  video.requestVideoFrameCallback(onVideoFrame);
}

// --- the players -------------------------------------------------------------------------------------------------

async function startMoq(forceWebSocket: boolean) {
  // @moq/net races WebTransport against WebSocket; without the constructor it goes straight to WebSocket.
  if (forceWebSocket) Reflect.deleteProperty(globalThis, "WebTransport");
  const Moq = await import("@moq/net");
  const Watch = await import("@moq/watch");
  result.startMs = performance.now();

  // As web/src/transport/moq.ts connects: one reconnecting connection with a private origin.
  const origin = new Moq.Origin.Producer();
  const connection = new Moq.Connection({
    url: new URL(relay),
    publish: origin.consume(),
    consume: origin,
    websocket: { enabled: true },
    delay: { timeout: Moq.Time.Milli(0) },
  });
  connection.transport.subscribe((t) => {
    if (t) result.transport = t;
  });

  const player = new Watch.Player({
    origin,
    name: Watch.Net.Path.from("bench/live"),
    canvas,
    catalogFormat: "hang",
    muted: false,
    visible: "always",
    delay: Watch.Net.Time.Milli(moqDelayMs),
  });
  player.renderer.out.frame.subscribe((frame) => {
    if (frame) onFrame(frame, frame.displayWidth);
  });

  // The text track, read as web/src/transport/moq.ts reads an agent's state track.
  const requesting = origin.request(Moq.Path.from("bench/text"), { announced: true });
  let current: { close(): void } | undefined;
  const attach = (broadcast: MoqNet.Broadcast.Consumer | undefined) => {
    current?.close();
    if (!broadcast) return;
    const subscriber = broadcast.track("state").subscribe({ maxAge: Moq.Time.Milli(0) });
    current = subscriber;
    void (async () => {
      for (;;) {
        const group = await subscriber.recvGroup().catch(() => undefined);
        if (!group) return;
        void (async () => {
          try {
            for (;;) {
              const frame = await group.readFrame();
              if (!frame) return;
              if (frame.payload.byteLength === 0) continue;
              onText((JSON.parse(new TextDecoder().decode(frame.payload)) as { t: number }).t);
            }
          } catch {
            // a group the relay reset
          } finally {
            group.close();
          }
        })();
      }
    })();
  };
  requesting.active.subscribe(attach);
  attach(requesting.active.peek());
}

async function startHls() {
  result.startMs = performance.now();
  result.transport = "http/1.1";
  // hls.js defaults except low-latency mode, which LL-HLS needs: the player holds back by the playlist's
  // PART-HOLD-BACK (3 parts, 0.6 s here) behind the live edge.
  const hls = new Hls({ lowLatencyMode: true });
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (data.fatal) result.errors.push(`hls: ${data.type} ${data.details}`);
  });
  hls.loadSource(`${mediamtx}:8888/bench/index.m3u8`);
  hls.attachMedia(video);
  watchVideoElement();
  await video.play().catch((e: unknown) => result.errors.push(`play: ${String(e)}`));
}

async function startWebRtc() {
  result.startMs = performance.now();
  result.transport = "webrtc";
  const pc = new RTCPeerConnection();
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });
  const stream = new MediaStream();
  pc.ontrack = (e) => {
    stream.addTrack(e.track);
    video.srcObject = stream;
  };
  await pc.setLocalDescription(await pc.createOffer());
  // No STUN or TURN on the benchmark network: host candidates only, gathered in a few ms. Send them all at once.
  await new Promise<void>((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && resolve());
    setTimeout(resolve, 2000);
  });
  const res = await fetch(`${mediamtx}:8889/bench/whep`, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: pc.localDescription!.sdp,
  });
  if (!res.ok) throw new Error(`WHEP ${res.status}`);
  await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
  watchVideoElement();
  await video.play().catch((e: unknown) => result.errors.push(`play: ${String(e)}`));
}

async function main() {
  canvas.hidden = !proto.startsWith("moq");
  video.hidden = proto.startsWith("moq");
  // Give up when nothing plays: the runner records the run as failed.
  setTimeout(
    () => {
      if (firstFrameAt === undefined) result.errors.push("no frame decoded");
      finish();
    },
    (seconds + 20) * 1000,
  );
  try {
    if (proto === "moq" || proto === "moq-ws") await startMoq(proto === "moq-ws");
    else if (proto === "hls") await startHls();
    else if (proto === "webrtc") await startWebRtc();
    else throw new Error(`unknown proto ${String(proto)}`);
  } catch (e) {
    result.errors.push(String(e));
    finish();
  }
}

void main();
