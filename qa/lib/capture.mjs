// Pass 1: walk the journeys in each browser, in the dark and the light theme, and screenshot every state.
//
// This pass captures; it never gates. A failed step is recorded in the report and the walk goes on, and nothing
// here asserts on pixels. A screenshot is evidence for a reviewer, not a test oracle: adding assertions would make
// the harness stop at the first surprise, which is exactly when the next frames matter most.

import { chromium, firefox, webkit } from "playwright";
import { join } from "node:path";
import { JOURNEYS } from "./journeys.mjs";
import { brandedPath, ensureDir, sleep } from "./util.mjs";

const FAKE_MEDIA = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];
const CHROMIUM_ARGS = [...FAKE_MEDIA, "--autoplay-policy=no-user-gesture-required"];

/** The browsers the harness knows; branded ones only when installed on this machine. */
export const BROWSERS = {
  chromium: { type: chromium, launch: { args: CHROMIUM_ARGS } },
  chrome: { type: chromium, launch: { channel: "chrome", args: CHROMIUM_ARGS }, branded: "chrome" },
  msedge: { type: chromium, launch: { channel: "msedge", args: CHROMIUM_ARGS }, branded: "msedge" },
  firefox: {
    type: firefox,
    launch: {
      firefoxUserPrefs: {
        "media.navigator.streams.fake": true,
        "media.navigator.permission.disabled": true,
        "media.autoplay.default": 0,
        "media.autoplay.blocking_policy": 0,
      },
    },
  },
  webkit: { type: webkit, launch: {} },
};

/** Waits until the frame is settled enough to read: fonts loaded, two frames painted, a short quiet beat. */
async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await sleep(250);
}

/**
 * Runs every selected journey in one browser and theme. Returns the captures and failed steps it recorded.
 * `record` is shared across the run so the report can list everything in one place.
 */
async function runTheme({ name, browser, theme, journeys, opts, outDir, record }) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: theme,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "Europe/Istanbul",
    permissions: name === "firefox" || name === "webkit" ? [] : ["camera", "microphone"],
  });
  // Never create a room on the deployed site: no journey submits a valid form, and this aborts one if it did.
  await context.route("**/api/rooms**", (route) => {
    if (route.request().method() === "POST") {
      record.failures.push({ browser: name, theme, journey: "guard", step: "room creation blocked", error: "a POST to /api/rooms was attempted and aborted" });
      return route.abort();
    }
    return route.continue();
  });

  for (const journey of journeys) {
    const page = await context.newPage();
    let errors = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text().slice(0, 400));
    });
    page.on("pageerror", (e) => errors.push(`pageerror: ${String(e.message ?? e).slice(0, 400)}`));

    const j = {
      page,
      opts,
      go: (path) => page.goto(new URL(path, opts.base).toString(), { waitUntil: "domcontentloaded", timeout: 30_000 }),
      async shot(state, intent, { fullPage = false } = {}) {
        const file = `${journey.id}-${state}-${theme}.png`;
        await settle(page).catch(() => {});
        await page.screenshot({ path: join(outDir, file), fullPage, animations: "disabled", caret: "hide" });
        record.captures.push({ browser: name, theme, journey: journey.id, state, file: `${name}/${file}`, intent, errors });
        errors = [];
      },
      async step(stepName, fn) {
        try {
          await fn();
        } catch (e) {
          const msg = String(e?.message ?? e).split("\n")[0].slice(0, 300);
          const skipped = msg.startsWith("skipped:");
          record.failures.push({ browser: name, theme, journey: journey.id, step: stepName, error: msg, skipped });
        }
      },
    };

    const t0 = Date.now();
    try {
      await journey.run(j);
    } catch (e) {
      record.failures.push({ browser: name, theme, journey: journey.id, step: "(journey)", error: String(e?.message ?? e).split("\n")[0].slice(0, 300) });
    }
    if (errors.length) record.captures.push({ browser: name, theme, journey: journey.id, state: "(after last capture)", file: "", intent: "", errors });
    record.timings.push({ browser: name, theme, journey: journey.id, seconds: Math.round((Date.now() - t0) / 1000) });
    await page.close();
  }
  await context.close();
}

export async function captureJourneys({ runDir, browsers, themes, journeyIds, opts, log }) {
  const record = { captures: [], failures: [], timings: [], browsers: [] };
  const journeys = JOURNEYS.filter((j) => journeyIds.includes(j.id));
  // One browser at a time: other lanes share this machine.
  for (const name of browsers) {
    const spec = BROWSERS[name];
    if (!spec) {
      record.browsers.push({ name, status: "unknown browser name" });
      continue;
    }
    if (spec.branded && !brandedPath(spec.branded)) {
      record.browsers.push({ name, status: "not installed" });
      log(`  ${name}: not installed, skipped`);
      continue;
    }
    let browser;
    try {
      browser = await spec.type.launch({ headless: true, ...spec.launch });
    } catch (e) {
      record.browsers.push({ name, status: `launch failed: ${String(e.message).split("\n")[0]}` });
      log(`  ${name}: launch failed`);
      continue;
    }
    record.browsers.push({ name, status: "ran", version: browser.version() });
    const outDir = ensureDir(join(runDir, name));
    for (const theme of themes) {
      log(`  ${name} ${theme}: ${journeys.map((j) => j.id).join(", ")}`);
      await runTheme({ name, browser, theme, journeys, opts, outDir, record });
    }
    await browser.close();
  }
  return record;
}
