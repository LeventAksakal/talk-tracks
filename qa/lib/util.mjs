// Small helpers shared by the three passes: argument parsing, output paths, and redaction of the base host.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";

/** `--key value`, `--key=value` and bare `--flag` into an object; anything else is positional. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

// House rule: no QA run makes a sound on this machine. Every browser the harness launches is muted at launch, so a
// later run cannot forget. Chromium, Chrome and Edge take a flag; Firefox a pref; WebKit has neither, so its pages get
// an init script that mutes every media element and routes Web Audio through a silent gain node.
export const CHROMIUM_MUTE_ARGS = ["--mute-audio"];
export const FIREFOX_MUTE_PREFS = { "media.volume_scale": "0.0" };
export const WEBKIT_MUTE_SCRIPT = () => {
  const mute = (el) => {
    try {
      el.muted = true;
    } catch {}
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) {
    mute(this);
    return play.apply(this, a);
  };
  for (const C of [window.AudioContext, window.webkitAudioContext].filter(Boolean)) {
    const desc = Object.getOwnPropertyDescriptor(C.prototype, "destination") ??
      Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, "destination");
    if (!desc?.get) continue;
    const silent = new WeakMap();
    Object.defineProperty(C.prototype, "destination", {
      configurable: true,
      get() {
        let g = silent.get(this);
        if (!g) {
          g = this.createGain();
          g.gain.value = 0;
          g.connect(desc.get.call(this));
          silent.set(this, g);
        }
        return g;
      },
    });
  }
};

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json", ".txt": "text/plain" };

/**
 * Serve a local build (`web/dist`) in place of the deployed app's own files, under the deployed origin: the relay,
 * the archive and the room service stay the deployed ones, so a change is seen against real rooms before it is
 * deployed. Pages get the deployed document's headers (COOP/COEP) with the local index.html; /api and /archive pass.
 */
export async function overlayBuild(context, base, dist) {
  const origin = new URL(base).origin;
  await context.route(
    (url) => url.origin === origin,
    async (route) => {
      const req = route.request();
      const path = decodeURIComponent(new URL(req.url()).pathname);
      if (path.startsWith("/api/") || path.startsWith("/archive/")) return route.fallback();
      if (req.resourceType() === "document") {
        const res = await route.fetch();
        const headers = { ...res.headers(), "content-type": "text/html", "cache-control": "no-store" };
        for (const h of ["content-length", "content-encoding", "etag", "last-modified"]) delete headers[h];
        return route.fulfill({ status: 200, headers, body: readFileSync(join(dist, "index.html")) });
      }
      const file = join(dist, path);
      if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) return route.fallback();
      const type = TYPES[extname(file)] ?? "application/octet-stream";
      return route.fulfill({ status: 200, headers: { "content-type": type }, body: readFileSync(file) });
    },
  );
}

export const list = (v, fallback) =>
  (typeof v === "string" ? v : fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

export function writeText(path, text) {
  ensureDir(dirname(path));
  writeFileSync(path, text);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True for a base URL served from this machine (a local preview), where nothing needs redacting. */
export function isLocal(base) {
  const host = new URL(base).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
}

/**
 * The deployed hostname must never land in the repo (CLAUDE.md: public repo). Every text the harness writes goes
 * through this: the base origin and its bare hostname become `<TT_BASE_URL>` / `<host>`.
 */
export function makeRedactor(base) {
  if (isLocal(base)) return (s) => s;
  const url = new URL(base);
  const origin = url.origin;
  const host = url.hostname;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reOrigin = new RegExp(esc(origin), "g");
  const reHost = new RegExp(esc(host), "g");
  // Chrome's traces name the site too (scheme + registrable domain, e.g. a process lock "https://example.com/"):
  // the last two labels, which is the registrable domain for the hosts this project uses.
  const site = host.split(".").slice(-2).join(".");
  const reSite = new RegExp(esc(site), "g");
  return (s) =>
    String(s).replace(reOrigin, "<TT_BASE_URL>").replace(reHost, "<host>").replace(reSite, "<site>");
}

/** Rewrite a file already on disk through the redactor (Lighthouse writes its own files). */
export function redactFile(path, redact) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  const out = redact(text);
  if (out !== text) writeFileSync(path, out);
}

/** Branded browsers on this machine; Playwright launches them by channel. */
export const BRANDED = {
  chrome: [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
  ],
  msedge: [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/microsoft-edge",
  ],
};

export const brandedPath = (channel) => BRANDED[channel]?.find((p) => existsSync(p));

/**
 * Which build the base serves: the hashed entry script named in index.html (`index-<hash>.js`). The deployed site
 * can be redeployed mid-run; the report compares this per browser so a run that straddles two builds says so.
 */
export async function buildId(base) {
  try {
    const html = await (await fetch(base, { signal: AbortSignal.timeout(10_000) })).text();
    return /\/assets\/(index-[\w-]+)\.js/.exec(html)?.[1] ?? "unknown";
  } catch {
    return "unreachable";
  }
}

export const stamp =(d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};
