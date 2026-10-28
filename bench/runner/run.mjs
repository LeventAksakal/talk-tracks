// The benchmark runner: serves the viewer page (bench/web, built into ./dist) and drives headless Google Chrome
// through N fresh joins per protocol, round-robin, one new browser context (no shared connection or cache) per join.
// Each join is one JSON line in /results/<label>.jsonl; bench/analyze.py turns them into the results tables.
//
//   node run.mjs --proto moq,moq-ws,moq-text,hls,webrtc --runs 10 --seconds 20 [--delay 500] [--label local]
import { createReadStream, existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const { values: opt } = parseArgs({
  options: {
    proto: { type: "string", default: "moq,hls,webrtc" },
    runs: { type: "string", default: "10" },
    seconds: { type: "string", default: "20" },
    delay: { type: "string", default: "500" },
    label: { type: "string", default: process.env.BENCH_LABEL ?? "local" },
    out: { type: "string", default: "/results" },
    relay: { type: "string", default: "http://relay:4443/" },
    mediamtx: { type: "string", default: "http://mediamtx" },
    "no-isolation": { type: "boolean", default: false },
    // Extra viewer page parameters, for experiments: for example "muted=1".
    query: { type: "string", default: "" },
  },
});

const DIST = new URL("./dist/", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm" };

// The viewer as production serves it (deploy/Caddyfile): cross-origin isolated, which gives @moq/watch's audio
// SharedArrayBuffer.
const server = createServer((req, res) => {
  const path = normalize(new URL(req.url, "http://x").pathname).replace(/^(\.\.[/\\])+/, "");
  let file = join(DIST, path === "/" ? "index.html" : path);
  if (!existsSync(file)) file = join(DIST, "index.html");
  const headers = { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" };
  if (!opt["no-isolation"]) {
    headers["Cross-Origin-Opener-Policy"] = "same-origin";
    headers["Cross-Origin-Embedder-Policy"] = "require-corp";
  }
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(8080, "127.0.0.1", resolve));

const protos = opt.proto.split(",");
const runs = Number(opt.runs);
const seconds = Number(opt.seconds);
mkdirSync(opt.out, { recursive: true });
const outFile = join(opt.out, `${opt.label}.jsonl`);
const network = { delayMs: Number(process.env.BENCH_DELAY_MS ?? 0), lossPct: Number(process.env.BENCH_LOSS_PCT ?? 0) };

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
console.log(`chrome ${browser.version()}; ${runs} runs x ${protos.join(", ")}, ${seconds} s each -> ${outFile}`);

// Bytes into this container over every interface but loopback: the same count for every protocol, headers and
// retransmissions included. Joins run one at a time, so the difference over a join is that join's traffic.
const rxBytes = () => {
  try {
    return readFileSync("/proc/net/dev", "utf8")
      .split("\n")
      .slice(2)
      .map((l) => l.trim().split(/[:\s]+/))
      .filter((f) => f.length > 2 && f[0] !== "lo")
      .reduce((sum, f) => sum + Number(f[1]), 0);
  } catch {
    return undefined;
  }
};

const pct = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

for (let run = 1; run <= runs; run++) {
  for (const proto of protos) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    // `moq-text` is MoQ subscribed to the text track alone: what a captions-only viewer receives.
    const query = new URLSearchParams({
      proto: proto === "moq-text" ? "moq" : proto,
      media: proto === "moq-text" ? "0" : "1",
      seconds: String(seconds),
      delay: opt.delay,
      relay: opt.relay,
      mediamtx: opt.mediamtx,
    });
    for (const [k, v] of new URLSearchParams(opt.query)) query.set(k, v);
    const started = new Date().toISOString();
    const rx0 = rxBytes();
    const t0 = performance.now();
    let result;
    try {
      await page.goto(`http://127.0.0.1:8080/?${query}`);
      await page.waitForFunction(() => window.__bench?.done, null, { timeout: (seconds + 40) * 1000, polling: 250 });
      result = await page.evaluate(() => window.__bench.result);
    } catch (e) {
      result = { proto, frames: [], text: [], errors: [String(e)] };
    }
    const rx1 = rxBytes();
    const rxMs = Math.round(performance.now() - t0);
    await context.close();
    const line = { label: opt.label, run, started, chrome: browser.version(), network, ...result, proto, rxBytes: rx0 === undefined ? undefined : rx1 - rx0, rxMs, consoleErrors: consoleErrors.slice(0, 5) };
    appendFileSync(outFile, JSON.stringify(line) + "\n");
    const lat = result.frames.map(([, l]) => l);
    const txt = (result.text ?? []).map(([, l]) => l);
    console.log(
      `run ${run} ${proto.padEnd(7)} ${result.transport ?? "-"}: join ${result.joinMs?.toFixed(0) ?? "-"} ms, ` +
        `latency p50 ${pct(lat, 50)} p95 ${pct(lat, 95)} ms (${lat.length} frames, ${result.unreadable ?? 0} unreadable)` +
        (rx0 !== undefined ? `, ${(((rx1 - rx0) * 8) / rxMs).toFixed(0)} kbit/s on the wire` : "") +
        (txt.length ? `, text p50 ${pct(txt, 50)} p95 ${pct(txt, 95)} ms` : "") +
        (result.errors?.length ? `, errors: ${result.errors.join("; ")}` : ""),
    );
  }
}

await browser.close();
server.close();
