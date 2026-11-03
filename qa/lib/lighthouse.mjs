// Pass 2: Lighthouse, desktop preset, on the hub, a demo watch page and the offline demo. JSON and HTML are saved
// per page (redacted of the deployed host) and the four category scores go into the report.

import lighthouse from "lighthouse";
import desktopConfig from "lighthouse/core/config/desktop-config.js";
import * as chromeLauncher from "chrome-launcher";
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHROMIUM_MUTE_ARGS, brandedPath, ensureDir, redactFile } from "./util.mjs";

const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];

export async function runLighthouse({ runDir, pages, opts, redact, log }) {
  const dir = ensureDir(join(runDir, "lighthouse"));
  // Branded Chrome when installed (it decodes H.264 like a viewer's browser), else Playwright's Chromium.
  const chromePath = brandedPath("chrome") ?? chromium.executablePath();
  const results = [];
  for (const { id, path } of pages) {
    const url = new URL(path, opts.base).toString();
    log(`  lighthouse ${id}`);
    let chrome;
    try {
      chrome = await chromeLauncher.launch({
        chromePath,
        chromeFlags: [...CHROMIUM_MUTE_ARGS, "--headless=new", "--no-first-run", "--autoplay-policy=no-user-gesture-required"],
      });
      const runner = await lighthouse(
        url,
        { port: chrome.port, output: ["json", "html"], logLevel: "error", onlyCategories: CATEGORIES, maxWaitForLoad: 45_000 },
        desktopConfig,
      );
      const [json, html] = runner.report;
      const jsonPath = join(dir, `${id}.json`);
      const htmlPath = join(dir, `${id}.html`);
      writeFileSync(jsonPath, json);
      writeFileSync(htmlPath, html);
      redactFile(jsonPath, redact);
      redactFile(htmlPath, redact);
      const lhr = runner.lhr;
      const score = (c) => (lhr.categories[c]?.score == null ? null : Math.round(lhr.categories[c].score * 100));
      const audit = (a) => lhr.audits[a]?.displayValue ?? "";
      results.push({
        id,
        path,
        scores: Object.fromEntries(CATEGORIES.map((c) => [c, score(c)])),
        metrics: {
          lcp: audit("largest-contentful-paint"),
          cls: audit("cumulative-layout-shift"),
          tbt: audit("total-blocking-time"),
          fcp: audit("first-contentful-paint"),
        },
        warnings: (lhr.runWarnings ?? []).map((w) => redact(String(w)).slice(0, 300)),
        runtimeError: lhr.runtimeError ? redact(lhr.runtimeError.message) : undefined,
        failing: Object.values(lhr.audits)
          .filter((a) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== "informative" && a.scoreDisplayMode !== "manual" && a.scoreDisplayMode !== "notApplicable")
          .map((a) => ({ id: a.id, title: a.title, score: a.score }))
          .slice(0, 40),
        files: { json: `lighthouse/${id}.json`, html: `lighthouse/${id}.html` },
        browser: chromePath.includes("ms-playwright") ? "chromium" : "chrome",
      });
    } catch (e) {
      results.push({ id, path, error: redact(String(e?.message ?? e).split("\n")[0]) });
    } finally {
      await chrome?.kill();
    }
  }
  return results;
}
