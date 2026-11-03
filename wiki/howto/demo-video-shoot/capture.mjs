// Storyboard frames and viewer-side wait times for the demo video (wiki/submission-video.md), from the live site.
//
// Re-run it on the final build and only the images (and timings.json) change; the script and runbook name each frame
// by its beat, never by what it looked like on the day it was taken.
//
//   node wiki/howto/demo-video-shoot/capture.mjs                     # every frame, both language picks
//   node wiki/howto/demo-video-shoot/capture.mjs --no-pay            # no language pick at all ($0)
//   node wiki/howto/demo-video-shoot/capture.mjs --only b03,b04      # some beats
//
// Playwright comes from the QA harness (TT_QA_DIR, default C:/Code/tt-gate-ink/qa, or any checkout's qa/ after
// `npm ci --prefix qa`). The browser is headless and muted (--mute-audio); it never signs in, never starts a talk,
// never enters an access code, and aborts any POST to /api/rooms.
//
// Cost: the only paid steps are the two language picks in a recording room (--lang1, --lang2): Muse Spark back-fills
// the slices the player fetches, about $0.008 a minute of lecture per language. A full run plays about 1.5 minutes
// with a translation on, so it costs about $0.02, and less on a re-run: a slice made once is served again from the
// archive. Live rooms are only watched (no language picked there).

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const QA = resolve(arg("qa", process.env.TT_QA_DIR ?? "C:/Code/tt-gate-ink/qa"));
const require = createRequire(join(QA, "package.json"));
const { chromium } = require("playwright");
const { CHROMIUM_MUTE_ARGS } = await import(pathToFileURL(join(QA, "lib/util.mjs")).href);

const BASE = (arg("base", process.env.TT_BASE_URL ?? "https://talk-tracks.leventaksakal.com")).replace(/\/$/, "");
const OUT = resolve(arg("out", here));
const LIVE = arg("live", "dataviz"); // a demo live session: watched only, nothing picked
const REC = arg("recording", "dataviz-recording");
const LANG1 = arg("lang1", "Turkish");
const LANG2 = arg("lang2", "Japanese");
const PAY = !flag("no-pay");
const ONLY = arg("only", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const want = (id) => ONLY.length === 0 || ONLY.includes(id);
// The console pre-flight frame (no token, nothing on air) from a QA run; the speaker's on-air console is shot live.
const CONSOLE_PNG = arg("console", "C:/Code/tt-gate-ink/qa/out/20261103-counted-0769d3d/chromium/console-preflight-dark.png");

mkdirSync(OUT, { recursive: true });
const timings = { base: "<TT_BASE_URL>", taken: new Date().toISOString(), live: LIVE, recording: REC, waits: {}, notes: [] };
let paidSeconds = 0; // seconds of lecture played with a translation on: the spend estimate
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ args: CHROMIUM_MUTE_ARGS });

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
  await ctx.route("**/api/rooms**", (r) => (r.request().method() === "POST" ? r.abort() : r.continue()));
  return ctx.newPage();
}

async function shot(page, id) {
  const path = join(OUT, `${id}.jpg`);
  await page.screenshot({ path, type: "jpeg", quality: 72 });
  log(`  frame ${id}.jpg`);
}

/** Open a room and wait until the player has a timeline; returns the wait in ms. */
async function open(page, room) {
  const t0 = Date.now();
  await page.goto(`${BASE}/watch/${room}`);
  await page.locator("media-controller").waitFor({ state: "visible", timeout: 25_000 });
  await page.waitForFunction(() => (document.querySelector("tt-room-media")?.readyState ?? 0) >= 1, null, { timeout: 30_000 });
  return Date.now() - t0;
}

/** Headless Chromium blocks autoplay: press the big play button if it shows. */
async function play(page) {
  const big = page.getByRole("button", { name: /^Play the talk$|^Play$/ });
  if (await big.first().isVisible().catch(() => false)) await big.first().click();
  else {
    const p = page.getByRole("button", { name: "play", exact: true });
    if (await p.isVisible().catch(() => false)) await p.click();
  }
}

async function blur(page) {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
}

async function closeMenus(page) {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape");
    await sleep(250);
  }
}

async function openSubtitles(page) {
  await page.getByRole("button", { name: "Subtitles", exact: true }).click();
  await sleep(500);
}

/**
 * Type a language into the menu's search box; the frame of the filtered list is beat 3's "before".
 * Three letters, capital first, as the friends are told to: on the 11-03 build the player's keys still fire while
 * the box has focus, so a lowercase k or a space pauses the talk and a lowercase j jumps 10 s back.
 */
async function searchLanguage(page, name) {
  await openSubtitles(page);
  const box = page.getByPlaceholder("Search any language");
  await box.click();
  await box.pressSequentially(name.slice(0, 3), { delay: 90 });
  await sleep(500);
}

/** Pick the language; returns ms until its first subtitle line is on the stage (or null after 45 s). */
async function pickLanguage(page, name) {
  const choice = page.getByRole("group", { name: "Languages" }).getByRole("button").filter({ hasText: new RegExp(name, "i") });
  const t0 = Date.now();
  await choice.first().click();
  await closeMenus(page);
  return waitForTranslation(page, t0);
}

async function waitForTranslation(page, t0 = Date.now(), timeout = 45_000) {
  const ok = await page
    .waitForFunction(
      () => [...document.querySelectorAll(".tt-subs .tt-sub-line")].some((l) => l.lang && !l.lang.startsWith("en") && l.textContent.trim()),
      null,
      { timeout, polling: 200 },
    )
    .then(() => true)
    .catch(() => false);
  return ok ? Date.now() - t0 : null;
}

async function seekTo(page, fraction) {
  const range = page.locator("media-time-range").first();
  const box = await range.boundingBox();
  await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
  await page.mouse.move(960, 400);
}

async function openTab(page, name) {
  const toggle = page.getByRole("button", { name: "Side panel (S)" });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await sleep(300);
  const t0 = Date.now();
  await page.getByRole("tab", { name, exact: true }).click();
  return t0;
}

/** Turn a still into a 1920x1080 JPG frame (letterboxed on black). */
async function still(id, file) {
  if (!existsSync(file)) {
    timings.notes.push(`${id}: ${file} not found, frame not made`);
    return;
  }
  const page = await newPage();
  const data = readFileSync(file).toString("base64");
  await page.setContent(
    `<body style="margin:0;background:#000;display:grid;place-items:center;height:1080px"><img src="data:image/png;base64,${data}" style="max-width:1920px;max-height:1080px;width:100%;height:100%;object-fit:contain"></body>`,
  );
  await sleep(300);
  await shot(page, id);
  await page.context().close();
}

/** An edit-layout mock: a POV in the top 75 % and a terminal band of illustrative Meta-call lines below. */
async function layout(id, povFile, label, lines) {
  const page = await newPage();
  const pov = existsSync(povFile) ? `data:image/jpeg;base64,${readFileSync(povFile).toString("base64")}` : "";
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const rows = lines.map(([c, t]) => `<div style="color:${c}">${esc(t)}</div>`).join("");
  await page.setContent(`<body style="margin:0;width:1920px;height:1080px;background:#0b0d12;font-family:Segoe UI,sans-serif;position:relative;overflow:hidden">
  <img src="${pov}" style="position:absolute;left:0;top:0;width:1440px;height:810px;object-fit:cover">
  <div style="position:absolute;left:1440px;top:0;width:480px;height:810px;background:#151924;color:#8a93a6;display:grid;place-items:center;font-size:22px;text-align:center;padding:24px;box-sizing:border-box">${esc(label)}</div>
  <div style="position:absolute;left:0;top:810px;width:1920px;height:270px;background:#0c0c0c;border-top:2px solid #2a2f3a;padding:14px 22px;box-sizing:border-box;font:22px/1.45 Cascadia Mono,Consolas,monospace;white-space:pre;overflow:hidden">${rows}</div>
  <div style="position:absolute;right:16px;top:820px;color:#666;font:14px Segoe UI">storyboard mock: terminal lines are illustrative, the shoot records the real ones</div>
</body>`);
  await sleep(300);
  await shot(page, id);
  await page.context().close();
}

const G = "#7fd67f", C = "#5fd7e8", M = "#d78ae8", Y = "#e8d26a", D = "#9aa3b2";

try {
  // b01 title card, b10 end card: the brand stills.
  if (want("b01")) await still("b01-title", join(repo, "web/public/brand/video/title.png"));
  if (want("b11")) await still("b11-end", join(repo, "web/public/brand/video/end.png"));
  // b02 the speaker: the console (pre-flight; on air it adds the live stage). Shot live on the night.
  if (want("b02")) await still("b02-speaker-console", CONSOLE_PNG);

  // b03, b04, b09: a recording room with real language picks (paid, cents).
  if (PAY && (want("b03") || want("b04") || want("b06") || want("b08") || want("b10") || want("b05"))) {
    log(`recording ${REC}: ${LANG1}`);
    const a = await newPage();
    timings.waits.recordingOpenMs = await open(a, REC);
    await play(a);
    await sleep(4_000);
    await searchLanguage(a, LANG1);
    await shot(a, "b03-search-language");
    const t1 = await pickLanguage(a, LANG1);
    timings.waits[`firstLine_${LANG1}_fromStart_ms`] = t1;
    log(`  ${LANG1} first line after ${t1} ms`);
    await sleep(4_000);
    await shot(a, "b03-subtitles-picked");
    // Play on so the first minute exists, then measure a made part and an unmade part.
    await sleep(20_000);
    paidSeconds += 30 + (t1 ?? 45_000) / 1000;
    const t0 = Date.now();
    await seekTo(a, 0.012); // about 0:13 of an 18:58 lecture: made a moment ago
    await sleep(150);
    timings.waits[`madePartAfterSeek_${LANG1}_ms`] = await waitForTranslation(a, t0, 20_000);
    log(`  made part after seek: ${timings.waits[`madePartAfterSeek_${LANG1}_ms`]} ms`);
    const t2 = Date.now();
    await seekTo(a, 0.5);
    await sleep(150);
    await a.waitForFunction(() => !document.querySelector(".tt-subs .tt-sub-line"), null, { timeout: 3_000 }).catch(() => {});
    timings.waits[`unmadePartAfterSeek_${LANG1}_ms`] = await waitForTranslation(a, t2, 45_000);
    log(`  unmade part after seek: ${timings.waits[`unmadePartAfterSeek_${LANG1}_ms`]} ms`);
    paidSeconds += 25;
    await sleep(3_000);
    await shot(a, "b10-recording");
    // Chapters and transcript of the recording: time to the first item.
    let tt = await openTab(a, "Chapters");
    await a.getByRole("tabpanel").getByRole("button").first().waitFor({ timeout: 15_000 }).catch(() => {});
    timings.waits.recordingChaptersMs = Date.now() - tt;
    await sleep(800);
    await shot(a, "b08-chapters");
    const views = await a.getByRole("tabpanel").getByRole("button", { name: /^Slides$/ }).count();
    if (views) {
      tt = Date.now();
      await a.getByRole("tabpanel").getByRole("button", { name: /^Slides$/ }).first().click();
      await sleep(2_500);
      timings.waits.recordingSlidesViewMs = Date.now() - tt;
      await shot(a, "b06-slide-descriptions");
    } else timings.notes.push("b06: no Slides view button in the Chapters tab");
    tt = await openTab(a, "Transcript");
    await sleep(1_200);
    timings.waits.recordingTranscriptMs = Date.now() - tt;
    await a.context().close();

    // b04: a second viewer, a second language, the same moment of the lecture.
    log(`recording ${REC}: ${LANG2}`);
    const b = await newPage();
    await open(b, REC);
    await play(b);
    await sleep(2_000);
    await openSubtitles(b);
    const box = b.getByPlaceholder("Search any language");
    await box.click();
    await box.pressSequentially(LANG2.slice(0, 3), { delay: 90 });
    await sleep(400);
    const t3 = await pickLanguage(b, LANG2);
    timings.waits[`firstLine_${LANG2}_fromStart_ms`] = t3;
    log(`  ${LANG2} first line after ${t3} ms`);
    await sleep(4_000);
    paidSeconds += 10 + (t3 ?? 45_000) / 1000;
    await shot(b, "b04-second-language");
    await b.context().close();
  }

  // b07, b08: a demo live session, watched only (no language picked).
  if (want("b02") || want("b07") || want("b09")) {
    log(`live ${LIVE}`);
    const l = await newPage();
    timings.waits.liveOpenMs = await open(l, LIVE);
    const tp = Date.now();
    await play(l);
    await l.waitForFunction(() => (document.querySelector("tt-room-media")?.readyState ?? 0) >= 2, null, { timeout: 20_000 }).catch(() => {});
    timings.waits.livePlayToPictureMs = Date.now() - tp;
    await sleep(6_000);
    await shot(l, "b02-viewer-live");
    await blur(l);
    const tr = Date.now();
    for (let i = 0; i < 3; i++) {
      await l.keyboard.press("j");
      await sleep(120);
    }
    await l.waitForFunction(() => { const m = document.querySelector("tt-room-media"); return m && !m.seeking && m.readyState >= 2; }, null, { timeout: 20_000 }).catch(() => {});
    timings.waits.liveRewind30sMs = Date.now() - tr;
    await sleep(2_000);
    await l.mouse.move(700, 600);
    await l.mouse.move(720, 620); // wake the dock so the behind pill and Go live show
    await sleep(600);
    await shot(l, "b07-rewound");
    const tg = Date.now();
    await l.getByRole("button", { name: /Go live/ }).first().click().catch(() => timings.notes.push("b07: no Go live button"));
    await l.waitForFunction(() => { const m = document.querySelector("tt-room-media"); return m && !m.seeking && m.readyState >= 2; }, null, { timeout: 20_000 }).catch(() => {});
    timings.waits.liveGoLiveMs = Date.now() - tg;
    await sleep(1_500);
    await blur(l);
    await l.keyboard.press("i");
    await sleep(2_500);
    await shot(l, "b09-stats");
    await l.context().close();
  }

  // b05: the edit's layout with the terminal band (mock lines; the real ones are recorded on the night).
  if (want("b05") || want("b06")) {
    await layout("b05-terminal-band", join(OUT, "b03-subtitles-picked.jpg"), "viewer 2 POV, or the speaker's console", [
      [D, "Meta model calls · room lecture · Ctrl-C to stop"],
      [G, "21:14:02  captions        muse-voice-transcribe-1.0           turn  “Every AI job in this talk is its own track.”"],
      [C, "21:14:03  translate tr    muse-spark-1.3               ~1s $0.0004"],
      [C, "          “Every AI job in this talk is its own track.” → “Bu konuşmadaki her yapay zekâ işi kendi parçası.”"],
      [C, "21:14:04  translate ja    muse-spark-1.3               ~1s $0.0003"],
      [C, "          “Every AI job in this talk is its own track.” → “この講演のすべてのAIジョブは独自のトラックです。”"],
    ]);
    await layout("b06-terminal-describe", join(OUT, "b06-slide-descriptions.jpg"), "speaker POV: the page just turned", [
      [D, "Meta model calls · room lecture · Ctrl-C to stop"],
      [M, "21:15:10  describe slide  muse-spark-1.3               ~4s $0.0030"],
      [M, "          “A diagram: the speaker, a relay and three agents, each publishing its own track.”"],
      [Y, "21:15:12  chapters        muse-spark-1.3               ~3s $0.0080"],
      [Y, "          3 chapters, 5 glossary terms · latest: “Tracks, not features”"],
    ]);
  }
} finally {
  await browser.close();
  // Spend estimate: about $0.008 per minute of lecture per language (wiki/howto/lazy-agents.md); a re-run of the same
  // slices costs nothing (they are served from the archive).
  timings.estimatedSpendUsd = Number(((paidSeconds / 60) * 0.008).toFixed(4));
  writeFileSync(join(OUT, "timings.json"), JSON.stringify(timings, null, 2) + "\n");
  log(JSON.stringify(timings, null, 2));
}
