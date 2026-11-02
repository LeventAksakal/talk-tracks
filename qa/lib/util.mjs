// Small helpers shared by the three passes: argument parsing, output paths, and redaction of the base host.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
  return (s) => String(s).replace(reOrigin, "<TT_BASE_URL>").replace(reHost, "<host>");
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
