// Contact sheet for one QA run: every captured frame as a labelled thumbnail, so a human can scan the run at a glance.
//   node qa/contact-sheet.mjs <run folder | run name under qa/out>     (also called from run.mjs at the end of a run)
// Writes contact-sheet-<browser>[-pN].jpg per browser and contact-sheet[-pN].jpg for everything, into the run folder,
// and links them from report.md and index.html when those exist. Renders an HTML grid in headless Chromium (Playwright,
// already a dependency) and screenshots it. Muted by construction: no page here plays media.

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { CHROMIUM_MUTE_ARGS } from "./lib/util.mjs";

const BROWSERS = ["chromium", "chrome", "msedge", "firefox", "webkit"];
const COLS = 8;
const THUMB_W = 300;
const THUMB_H = 188; // 1440x900 is 16:10
const LABEL_H = 44;
const GAP = 10;
const PAD = 16;
const HEAD_H = 40;
const MAX_H = 8000;
const ROW_H = THUMB_H + LABEL_H + GAP;
const SHEET_W = COLS * (THUMB_W + GAP) - GAP + PAD * 2;

/** Every frame on disk: { browser, name, step, theme, file }. Reads the PNGs, not the summary, so nothing is missed. */
export function listFrames(runDir) {
  const frames = [];
  for (const browser of BROWSERS) {
    const dir = join(runDir, browser);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.toLowerCase().endsWith(".png")).sort()) {
      const stem = f.replace(/\.png$/i, "");
      const m = stem.match(/^(.*)-(dark|light)$/);
      frames.push({ browser, name: stem, step: (m ? m[1] : stem).replace(/-/g, " "), theme: m ? m[2] : "", file: join(dir, f) });
    }
  }
  return frames;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function pageHtml(frames, title, mixed) {
  const cells = frames
    .map(
      (f) =>
        `<figure><img src="${pathToFileURL(f.file).href}"><figcaption><b>${esc(f.step)}</b><span class="${f.theme}">${f.theme || "-"}</span>${
          mixed ? `<i>${f.browser}</i>` : ""
        }</figcaption></figure>`,
    )
    .join("");
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#16171a;color:#e8e6e1;font:13px/1.25 system-ui,Segoe UI,sans-serif}
#sheet{width:${SHEET_W}px;padding:${PAD}px;box-sizing:border-box}
h1{margin:0 0 ${HEAD_H - 26}px;font-size:18px;height:26px;line-height:26px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(${COLS},${THUMB_W}px);gap:${GAP}px}
figure{margin:0;height:${THUMB_H + LABEL_H}px;overflow:hidden}
img{display:block;width:${THUMB_W}px;height:${THUMB_H}px;object-fit:cover;object-position:top;outline:1px solid #3a3d44}
figcaption{height:${LABEL_H}px;padding-top:3px;overflow:hidden}
b{font-weight:600;font-size:13px;margin-right:6px;word-break:break-word}
span{font-size:11px;padding:0 5px;border-radius:3px}.dark{background:#000;color:#fff;border:1px solid #666}.light{background:#f1f1ee;color:#111}
i{display:block;font-style:normal;color:#9aa;font-size:11px}
</style><div id="sheet"><h1>${esc(title)}</h1><div class="grid">${cells}</div></div>`;
}

/** Writes the sheet pages for one set of frames; returns [{ file, count }]. */
async function render(browser, frames, base, title, mixed, runDir) {
  const perPage = COLS * Math.floor((MAX_H - PAD * 2 - HEAD_H) / ROW_H);
  const pages = Math.max(1, Math.ceil(frames.length / perPage));
  const out = [];
  const ctx = await browser.newContext({ viewport: { width: SHEET_W, height: 1000 } });
  const tmp = join(tmpdir(), `tt-contact-${process.pid}.html`);
  for (let p = 0; p < pages; p++) {
    const chunk = frames.slice(p * perPage, (p + 1) * perPage);
    const t = `${title} · ${chunk.length} frames${pages > 1 ? ` · page ${p + 1} of ${pages}` : ""}`;
    writeFileSync(tmp, pageHtml(chunk, t, mixed));
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(tmp).href);
    await page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? 0 : new Promise((r) => ((i.onload = i.onerror = r)))))));
    const shown = await page.evaluate(() => [...document.images].filter((i) => i.naturalWidth > 0).length);
    if (shown !== chunk.length) throw new Error(`${base} page ${p + 1}: ${shown} of ${chunk.length} thumbnails decoded`);
    const file = `${base}${pages > 1 ? `-p${p + 1}` : ""}.jpg`;
    await page.locator("#sheet").screenshot({ path: join(runDir, file), type: "jpeg", quality: 82 });
    await page.close();
    out.push({ file, count: chunk.length });
  }
  rmSync(tmp, { force: true });
  await ctx.close();
  return out;
}

const MARK = "<!-- contact-sheets -->";

function linkBlock(sheets, md) {
  const items = sheets.map((s) => (md ? `[${s.file}](${s.file})` : `<a href="${s.file}">${s.file}</a>`));
  return md
    ? `${MARK}\n## Contact sheets\n\nEvery frame as a labelled thumbnail: ${items.join(" · ")}\n${MARK}\n`
    : `${MARK}<p>Contact sheets: ${items.join(" · ")}</p>${MARK}`;
}

function relink(path, sheets, md) {
  if (!existsSync(path)) return;
  let s = readFileSync(path, "utf8").replace(new RegExp(`${MARK}[\\s\\S]*?${MARK}\\n?`), "");
  const block = linkBlock(sheets, md);
  if (md) s = s.replace(/^(# .*\n)/, `$1\n${block}\n`);
  else s = s.includes("</header>") ? s.replace("</header>", `${block}</header>`) : s.replace("<body>", `<body>${block}`);
  writeFileSync(path, s);
}

/** Build every sheet for a run folder, link them from report.md / index.html, and return the list. */
export async function writeContactSheets(runDir, { log = console.log } = {}) {
  const frames = listFrames(runDir);
  if (!frames.length) {
    log("contact sheet: no frames found");
    return [];
  }
  for (const f of readdirSync(runDir)) if (/^contact-sheet.*\.jpg$/.test(f)) rmSync(join(runDir, f));
  const run = basename(runDir);
  const browser = await chromium.launch({ args: CHROMIUM_MUTE_ARGS });
  const sheets = [];
  try {
    // Everything first: same step and theme side by side across browsers, so a browser difference reads as a row.
    const all = [...frames].sort((a, c) => (a.name < c.name ? -1 : a.name > c.name ? 1 : BROWSERS.indexOf(a.browser) - BROWSERS.indexOf(c.browser)));
    sheets.push(...(await render(browser, all, "contact-sheet", `${run} · all browsers`, true, runDir)));
    for (const b of BROWSERS) {
      const fr = frames.filter((f) => f.browser === b);
      if (fr.length) sheets.push(...(await render(browser, fr, `contact-sheet-${b}`, `${run} · ${b}`, false, runDir)));
    }
  } finally {
    await browser.close();
  }
  relink(join(runDir, "report.md"), sheets, true);
  relink(join(runDir, "index.html"), sheets, false);
  log(`contact sheet: ${frames.length} frames in ${sheets.length} images (${sheets.map((s) => `${s.file}:${s.count}`).join(", ")})`);
  return sheets;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: node qa/contact-sheet.mjs <run folder | run name under qa/out>");
    process.exit(2);
  }
  const dir = existsSync(arg) ? resolve(arg) : resolve(fileURLToPath(new URL("./out", import.meta.url)), arg);
  if (!existsSync(dir)) {
    console.error(`no such run folder: ${dir}`);
    process.exit(2);
  }
  const t = Date.now();
  await writeContactSheets(dir);
  console.log(`done in ${((Date.now() - t) / 1000).toFixed(1)} s`);
}
