// The benchmark viewer: plays the source over one protocol and measures every rendered frame.
//
//   ?proto=moq      Talk Tracks' path: @moq/watch over WebTransport (WebSocket only if WebTransport fails)
//   ?proto=moq-ws   the same with WebTransport removed, as Safari runs it (WebSocket over TCP)
//   ?proto=hls      LL-HLS from MediaMTX through hls.js in low-latency mode
//   ?proto=webrtc   WebRTC from MediaMTX through a plain WHEP client
//   &media=0        MoQ only: subscribe to the text track alone (selective subscription), no audio or video
//   ?proto=fetch    history (decision 0012): subscribe to the sliced track `bench/history` live, then `fetchGroup`
//                   archive slices the relay has never seen (from the origin), each again (from the relay's cache),
//                   and the previous live slice (cached by live delivery); &fetches=N rounds
//
// Each frame carries the time it was made as a barcode (bench/source.sh); latency is this page's clock minus it.
// The result lands in `window.__bench` for the Playwright runner (bench/runner/run.mjs).
import type * as MoqNet from "@moq/net";
import Hls from "hls.js";

type Proto = "moq" | "moq-ws" | "hls" | "webrtc" | "fetch";

/** One timed `fetchGroup`: until the first object, until the group's end, and what it carried. */
interface Fetched {
  group: number;
  firstMs: number;
  ms: number;
  objects: number;
  bytes: number;
}

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
  /** Bytes received over the measured span (after the first frame), as the transport counts them. */
  bytes?: number;
  measuredMs?: number;
  /** proto=fetch: one entry per round. */
  fetches?: { uncached?: Fetched; cached?: Fetched; recent?: Fetched; errors?: string[] }[];
  /**
   * proto=fetch: the slice that was open when the viewer joined, fetched twice: as soon as it arrives live, while
   * still open (bounded at 10 s, beyond the slice's end), and again after the rounds, long after its end.
   * liveObjects and liveEndMs: what the live subscription delivered of it, and when it ended, ms after the open fetch
   * started.
   */
  joinSlice?: {
    group: number;
    liveObjects?: number;
    liveEndMs?: number;
    open?: Fetched;
    openError?: string;
    fetched?: Fetched;
    error?: string;
    /** The same, after the rounds, from a second session that never subscribed. */
    fresh?: Fetched;
    freshError?: string;
  };
  /** proto=fetch: each complete live slice as received, [group, objects, payload bytes]. */
  slices?: [number, number, number][];
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
const media = params.get("media") !== "0";

/** The transport's received-bytes counter, set by each player. */
let bytesReceived: () => Promise<number | undefined> = () => Promise.resolve(undefined);
let bytesAtStart: Promise<number | undefined> | undefined;

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
    result.width = width;
    started(at, `latency ${latency} ms`);
  }
  result.frames.push([Math.round(at - firstFrameAt!), latency]);
}

function onText(t: number) {
  const at = now();
  if (firstFrameAt === undefined) {
    if (media) return; // count text only while the media plays
    started(at, "text only");
  }
  result.text.push([Math.round(at - firstFrameAt!), Math.round((at - t) * 10) / 10]);
}

/** The first frame (or, text only, the first text object): the join ends and the measured span begins. */
function started(at: number, note: string) {
  firstFrameAt = at;
  result.joinMs = performance.now() - result.startMs;
  result.joinFromNavMs = performance.now();
  bytesAtStart = bytesReceived();
  log(`${proto}: first frame after ${result.joinMs.toFixed(0)} ms, ${note}`);
  finishTimer = setTimeout(() => void finish(), seconds * 1000);
}

let finishing = false;
async function finish() {
  clearTimeout(finishTimer);
  if (finishing) return;
  finishing = true;
  if (firstFrameAt !== undefined) {
    const [start, end] = await Promise.all([bytesAtStart, bytesReceived()]).catch(() => [undefined, undefined]);
    if (start !== undefined && end !== undefined) result.bytes = end - start;
    result.measuredMs = Math.round(now() - firstFrameAt);
  }
  log(`${proto}: done, ${result.frames.length} frames, ${result.text.length} text objects, ${result.bytes ?? "?"} bytes`);
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
  bytesReceived = async () => (await connection.stats())?.bytesReceived;

  if (media) startMoqPlayer(Watch, origin);
  subscribeText(Moq, origin);
}

function startMoqPlayer(Watch: typeof import("@moq/watch"), origin: MoqNet.Origin.Producer) {
  const player = new Watch.Player({
    origin,
    name: Watch.Net.Path.from("bench/live"),
    canvas,
    catalogFormat: "hang",
    muted: params.get("muted") === "1",
    visible: "always",
    delay: Watch.Net.Time.Milli(moqDelayMs),
  });
  player.renderer.out.frame.subscribe((frame) => {
    if (frame) onFrame(frame, frame.displayWidth);
  });
}

function subscribeText(Moq: typeof MoqNet, origin: MoqNet.Origin.Producer) {
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
  // Media bytes only (fragments and parts); playlist requests are small and not counted.
  let loaded = 0;
  hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
    loaded += data.payload.byteLength;
  });
  bytesReceived = () => Promise.resolve(loaded);
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
  bytesReceived = async () => {
    let sum = 0;
    (await pc.getStats()).forEach((r: { type: string; bytesReceived?: number }) => {
      if (r.type === "transport") sum += r.bytesReceived ?? 0;
    });
    return sum;
  };
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

/** proto=fetch: the history track, live and past (wiki/design/moq-track-system.md §4, decision 0012). */
async function startFetch() {
  const Moq = await import("@moq/net");
  const rounds = Number(params.get("fetches") ?? "5");
  result.startMs = performance.now();
  result.fetches = [];
  result.slices = [];
  // A private origin gives each connection its own session, not the pooled one.
  const openHistory = async () => {
    const origin = new Moq.Origin.Producer();
    const connection = new Moq.Connection({
      url: new URL(relay),
      consume: origin,
      websocket: { enabled: true },
      delay: { timeout: Moq.Time.Milli(0) },
    });
    const requesting = origin.request(Moq.Path.from("bench/history"), { announced: true });
    let broadcast = requesting.active.peek();
    for (let i = 0; !broadcast && i < 200; i++) {
      await sleep(50);
      broadcast = requesting.active.peek();
    }
    if (!broadcast) throw new Error("bench/history never announced");
    return { connection, track: broadcast.track("items") };
  };
  const { connection, track } = await openHistory();
  result.transport = connection.transport.peek(); // already connected: subscribe() reports only later changes
  connection.transport.subscribe((t) => {
    if (t) result.transport = t;
  });

  // The whole fetch is bounded, not only its start: a group whose stream never ends counts as a failure.
  const timed = (seq: number, limitMs = 6000, from = track): Promise<Fetched> =>
    Promise.race([
      fetchOne(seq, from),
      sleep(limitMs).then(() => Promise.reject(new Error(`fetchGroup ${seq}: no end of group in ${limitMs / 1000} s`))),
    ]);
  const fetchOne = async (seq: number, from: typeof track): Promise<Fetched> => {
    const t = performance.now();
    const group = await from.fetchGroup(seq);
    let firstMs = NaN;
    let objects = 0;
    let bytes = 0;
    for (;;) {
      const frame = await group.readFrame();
      if (!frame) break;
      if (objects === 0) firstMs = performance.now() - t;
      objects++;
      bytes += frame.payload.byteLength;
    }
    group.close();
    return { group: seq, firstMs: Math.round(firstMs * 10) / 10, ms: Math.round((performance.now() - t) * 10) / 10, objects, bytes };
  };

  // Live, as a viewer with the track switched on: the current slice first, then each new one.
  const live = track.subscribe({ maxAge: Moq.Time.Milli(0) });
  let archive = 0;
  let joinSlice = -1;
  /** The newest slice received live from its carry-in to its end: complete at the relay, not the join slice. */
  let lastWhole = -1;
  let openAt = 0;
  let openFetch: Promise<void> | undefined;
  const firstGroup = new Promise<void>((resolve) => {
    void (async () => {
      for (;;) {
        const group = await live.recvGroup().catch(() => undefined);
        if (!group) return;
        void (async () => {
          let objects = 0;
          let bytes = 0;
          try {
            for (;;) {
              const frame = await group.readFrame();
              if (!frame) break;
              if (objects === 0) {
                // The join slice starts mid-way, with an item; every later one with its carry-in.
                const first = JSON.parse(new TextDecoder().decode(frame.payload)) as { kind: string; archive?: number };
                if (first.kind === "carry" && first.archive !== undefined) archive = first.archive;
                if (joinSlice < 0) {
                  joinSlice = group.sequence;
                  result.joinSlice = { group: joinSlice };
                  openAt = performance.now();
                  const js = result.joinSlice;
                  openFetch = timed(joinSlice, 10000).then(
                    (f) => void (js.open = f),
                    (e) => void (js.openError = String(e)),
                  );
                }
                if (firstFrameAt === undefined) started(now(), `live slice ${group.sequence}`);
                if (archive > 0) resolve();
              }
              objects++;
              bytes += frame.payload.byteLength;
            }
            result.slices!.push([group.sequence, objects, bytes]);
            if (group.sequence === joinSlice && result.joinSlice) {
              result.joinSlice.liveObjects = objects;
              result.joinSlice.liveEndMs = Math.round(performance.now() - openAt);
            }
            if (group.sequence !== joinSlice) lastWhole = Math.max(lastWhole, group.sequence);
          } catch {
            // a slice the relay reset
          } finally {
            group.close();
          }
        })();
      }
    })();
  });
  await firstGroup;
  clearTimeout(finishTimer); // this row ends after its fetch rounds, not after --seconds

  // A slice received whole after the join, so "recent" has something to fetch: at most two slices (8 s).
  for (let i = 0; lastWhole < 0 && i < 200; i++) await sleep(50);
  await openFetch;
  for (let i = 0; i < rounds; i++) {
    const round: NonNullable<Result["fetches"]>[number] = {};
    const step = async (key: "uncached" | "cached" | "recent", seq: number) => {
      try {
        round[key] = await timed(seq);
      } catch (e) {
        (round.errors ??= []).push(`${key} ${seq}: ${String(e)}`);
      }
    };
    // An archive slice picked at random: the relay has not seen it, unless an earlier join fetched the same one
    // within the relay's ~30 s cache life (the origin logs every FETCH it serves, to check).
    const old = Math.floor(Math.random() * archive);
    await step("uncached", old);
    await step("cached", old);
    if (lastWhole >= 0) await step("recent", lastWhole);
    result.fetches.push(round);
    await sleep(500);
  }
  // The join slice again, long after its end. Measured once per join, apart from the rounds.
  result.joinSlice ??= { group: joinSlice };
  try {
    result.joinSlice.fetched = await timed(joinSlice);
  } catch (e) {
    result.joinSlice.error = String(e);
  }
  // And from a second session that never subscribed: whether the relay's copy of the group is at fault, or this
  // session's subscription.
  try {
    const other = await openHistory();
    try {
      result.joinSlice.fresh = await timed(joinSlice, 6000, other.track);
    } finally {
      other.connection.close();
    }
  } catch (e) {
    result.joinSlice.freshError = String(e);
  }
  await finish();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  canvas.hidden = !proto.startsWith("moq") || proto === "fetch";
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
    else if (proto === "fetch") await startFetch();
    else if (proto === "hls") await startHls();
    else if (proto === "webrtc") await startWebRtc();
    else throw new Error(`unknown proto ${String(proto)}`);
  } catch (e) {
    result.errors.push(String(e));
    finish();
  }
}

void main();
