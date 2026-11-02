// Pass 3: a Chrome DevTools trace of a watch page. Load, then N seconds of playback with subtitles, then a seek back
// and Go live. The trace (gzipped, loadable in the DevTools Performance panel) is saved; long tasks, the main
// thread's busy share, the frame rate and memory growth are extracted for the report.

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { brandedPath, ensureDir, sleep } from "./util.mjs";

const CATEGORIES = [
  "toplevel",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "blink.user_timing",
  "loading",
  "v8.execute",
];

const LONG_TASK_US = 50_000;

const mark = (page, name) => page.evaluate((n) => performance.mark(n), name);

async function heap(cdp, gc = false) {
  if (gc) await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { usedMB: +(m.JSHeapUsedSize / 1048576).toFixed(2), totalMB: +(m.JSHeapTotalSize / 1048576).toFixed(2), nodes: m.Nodes, listeners: m.JSEventListeners };
}

/** Pulls the numbers out of a Chrome trace: the renderer main thread's tasks between user-timing marks. */
export function analyseTrace(trace) {
  const events = trace.traceEvents ?? trace;
  const mains = new Map();
  for (const e of events)
    if (e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain") mains.set(`${e.pid}:${e.tid}`, { pid: e.pid, tid: e.tid, busy: 0 });
  const isTask = (e) => e.ph === "X" && (e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask");
  for (const e of events) {
    if (!isTask(e)) continue;
    const m = mains.get(`${e.pid}:${e.tid}`);
    if (m) m.busy += e.dur ?? 0;
  }
  // The page's renderer is the busiest main thread (an extension or a spare renderer barely runs).
  const main = [...mains.values()].sort((a, b) => b.busy - a.busy)[0];
  if (!main) return { error: "no renderer main thread in the trace" };
  // Top-level tasks only: a RunTask nested inside another (a nested run loop) would count its time twice.
  const tasks = [];
  let openUntil = -Infinity;
  for (const e of events.filter((x) => isTask(x) && x.pid === main.pid && x.tid === main.tid).sort((a, b) => a.ts - b.ts)) {
    if (e.ts < openUntil) continue;
    tasks.push(e);
    openUntil = e.ts + (e.dur ?? 0);
  }
  const marks = {};
  for (const e of events) if (typeof e.name === "string" && e.name.startsWith("qa:") && e.cat?.includes("user_timing")) marks[e.name] ??= e.ts;
  const frames = events.filter((e) => e.pid === main.pid && (e.name === "DrawFrame" || e.name === "Graphics.Pipeline.DrawAndSwap")).map((e) => e.ts);
  const counters = events
    .filter((e) => e.name === "UpdateCounters" && e.pid === main.pid && e.args?.data?.jsHeapSizeUsed)
    .map((e) => ({ ts: e.ts, mb: e.args.data.jsHeapSizeUsed / 1048576 }));

  // The load window starts at the page's own navigation, not at the about:blank the browser opened first.
  const nav = events.find(
    (e) => e.name === "navigationStart" && e.pid === main.pid && e.args?.data?.isLoadingMainFrame && !/^about:/.test(e.args?.data?.documentLoaderURL ?? ""),
  );
  const first = nav?.ts ?? tasks[0]?.ts ?? 0;
  const last = tasks.at(-1) ? tasks.at(-1).ts + (tasks.at(-1).dur ?? 0) : 0;
  const windows = [
    ["load", first, marks["qa:loaded"]],
    ["playback", marks["qa:play-start"], marks["qa:play-end"]],
    ["seek and go live", marks["qa:seek"], marks["qa:end"]],
    ["whole trace", first, last],
  ];
  const phase = ([name, from, to]) => {
    if (from == null || to == null || to <= from) return { name, missing: true };
    let busy = 0;
    const long = [];
    for (const t of tasks) {
      const s = Math.max(t.ts, from);
      const e = Math.min(t.ts + (t.dur ?? 0), to);
      if (e > s) busy += e - s;
      if (t.ts >= from && t.ts < to && (t.dur ?? 0) >= LONG_TASK_US) long.push(t.dur / 1000);
    }
    const seconds = (to - from) / 1e6;
    const f = frames.filter((ts) => ts >= from && ts < to).length;
    const heapIn = counters.filter((c) => c.ts >= from && c.ts < to);
    return {
      name,
      seconds: +seconds.toFixed(1),
      busyShare: +((busy / (to - from)) * 100).toFixed(1),
      longTasks: long.length,
      longTaskMsTotal: Math.round(long.reduce((a, b) => a + b, 0)),
      longestTaskMs: long.length ? Math.round(Math.max(...long)) : 0,
      compositorFps: f ? +(f / seconds).toFixed(1) : null,
      heapStartMB: heapIn[0] ? +heapIn[0].mb.toFixed(1) : null,
      heapEndMB: heapIn.at(-1) ? +heapIn.at(-1).mb.toFixed(1) : null,
    };
  };
  return { phases: windows.map(phase), marks: Object.keys(marks) };
}

export async function runTrace({ runDir, path, seconds, opts, log }) {
  const dir = ensureDir(join(runDir, "trace"));
  const channel = brandedPath("chrome") ? "chrome" : undefined;
  const browser = await chromium.launch({
    headless: true,
    channel,
    args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const out = { path, seconds, browser: `${channel ?? "chromium"} ${browser.version()}`, steps: [], errors: [] };
  const step = async (name, fn) => {
    try {
      const r = await fn();
      out.steps.push({ name, ok: true, note: r ?? "" });
    } catch (e) {
      out.steps.push({ name, ok: false, note: String(e?.message ?? e).split("\n")[0].slice(0, 200) });
    }
  };
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", locale: "en-US" });
    await context.route("**/api/rooms**", (r) => (r.request().method() === "POST" ? r.abort() : r.continue()));
    const page = await context.newPage();
    page.on("console", (m) => m.type() === "error" && out.errors.push(m.text().slice(0, 300)));
    page.on("pageerror", (e) => out.errors.push(`pageerror: ${String(e.message).slice(0, 300)}`));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");

    await browser.startTracing(page, { categories: CATEGORIES, screenshots: false });
    log(`  trace: load ${path}`);
    await page.goto(new URL(path, opts.base).toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await step("player ready", async () => {
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[aria-label="Time in the talk"]');
          return el && !/^–:––/.test(el.textContent ?? "");
        },
        null,
        { timeout: 30_000 },
      );
    });
    await mark(page, "qa:loaded");
    await step("play", async () => {
      const play = page.getByRole("button", { name: "Play (K)" });
      if (await play.isVisible().catch(() => false)) await play.click();
    });
    await step("subtitles on (original only)", async () => {
      await page.getByRole("button", { name: "Subtitles", exact: true }).click();
      const original = page.getByRole("button", { name: /^Original/ }).first();
      const text = (await original.textContent()) ?? "";
      if (/not in this room yet/.test(text)) throw new Error("no original subtitles in this room");
      await original.click();
      await page.keyboard.press("Escape");
    });
    await sleep(3_000);

    out.heap = [];
    out.heap.push({ t: 0, gc: true, ...(await heap(cdp, true)) });
    await page.evaluate(() => {
      const qa = (window.__qaFrames = { t: [], on: true });
      const f = (t) => {
        if (!qa.on) return;
        qa.t.push(t);
        requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
    });
    await mark(page, "qa:play-start");
    log(`  trace: ${seconds} s of playback`);
    for (let t = 5; t <= seconds; t += 5) {
      await sleep(5_000);
      out.heap.push({ t, ...(await heap(cdp)) });
    }
    await mark(page, "qa:play-end");
    out.heap.push({ t: seconds, gc: true, ...(await heap(cdp, true)) });
    out.raf = await page.evaluate(() => {
      const qa = window.__qaFrames;
      qa.on = false;
      const t = qa.t;
      const gaps = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b);
      const span = (t.at(-1) - t[0]) / 1000;
      return {
        frames: t.length,
        fps: +((t.length - 1) / span).toFixed(1),
        p95FrameMs: +(gaps[Math.floor(gaps.length * 0.95)] ?? 0).toFixed(1),
        framesOver50ms: gaps.filter((g) => g > 50).length,
      };
    });
    out.video = await page.evaluate(() =>
      [...document.querySelectorAll("video")].map((v) => {
        const q = v.getVideoPlaybackQuality?.();
        return { total: q?.totalVideoFrames ?? null, dropped: q?.droppedVideoFrames ?? null, w: v.videoWidth, h: v.videoHeight, paused: v.paused };
      }),
    );
    out.pillDuring = await page.locator(".tt-pill").first().textContent().catch(() => null);

    await mark(page, "qa:seek");
    await step("seek back a minute", async () => {
      await page.getByRole("slider", { name: "Position in the talk" }).focus();
      await page.keyboard.press("PageDown");
      await sleep(5_000);
      return (await page.locator(".tt-pill").first().textContent()) ?? "";
    });
    await mark(page, "qa:golive");
    await step("go live", async () => {
      await page.getByRole("button", { name: /Go live/ }).first().click();
      await sleep(5_000);
      return (await page.locator(".tt-pill").first().textContent()) ?? "";
    });
    await mark(page, "qa:end");
    await sleep(500);
    const buf = await browser.stopTracing();
    const trace = JSON.parse(buf.toString("utf8"));
    out.analysis = analyseTrace(trace);
    // Drop URLs from the trace before it is written: it may carry the deployed host.
    const text = opts.redact(buf.toString("utf8"));
    writeFileSync(join(dir, "watch-trace.json.gz"), gzipSync(text));
    out.file = "trace/watch-trace.json.gz";
    await context.close();
  } catch (e) {
    out.error = String(e?.message ?? e).split("\n")[0];
  } finally {
    await browser.close();
  }
  return out;
}
