// Builds every brand image in web/public from code, so the assets can be rebuilt after any change:
//   the logomark, wordmark and lockup (SVG, on dark and on light)   -> public/brand/
//   favicon.svg (follows the browser's dark mode), favicon.ico,
//   apple-touch-icon.png, icon-192.png, icon-512.png, icon-maskable-512.png, site.webmanifest -> public/
//   the social card (1200x630)                                    -> public/og.png
//   the demo video's title and end cards (1920x1080)              -> public/brand/video/
//
// The look is the streaming one (decision 0033): the logomark's three lanes in the lane colours on a near-black
// ground. No mascot.
//
// Run from anywhere with Node 23.6 or later (it strips the types itself):
//   node web/scripts/brand/build.ts
// PNGs are screenshots of generated pages in headless Chrome; set CHROME to its path if it is not in the usual
// place. The wordmark and lockup SVGs still draw the older title face's outlines from wordmark.json (wordmark.py);
// the cards set "Talk Tracks" in Atkinson Hyperlegible Next instead.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB = fileURLToPath(new URL("../../", import.meta.url));
const PUBLIC = join(WEB, "public");
const BRAND = join(PUBLIC, "brand");
const VIDEO = join(BRAND, "video");

// Tokens (web/src/theme/tokens.css): the dark ground and text; the "on light" files use the ground as ink.
const GROUND = "#07080d";
const TEXT = "#f2f4f9";
const MUTED = "#a2aabd";
const LANE = ["#ff4f8b", "#4f8bff", "#20d3ae"] as const;

// --- the logomark: a play button cut into three lanes (the Reference Canvas's "Play of lanes") -------------------
// One talk, many tracks. Solid, so it holds at 16 px. Drawn on a 64 grid; the ink spans x 12.5-57.5, y 4.5-59.5.
const MARK_LANES = ["M14 6L33.4 18H14Z", "M14 26H46.3L56 32L46.3 38H14Z", "M14 46H33.4L14 58Z"];
const MARK_D = MARK_LANES.join("");
/** The mark in one colour (`fill`), or in the three lane colours. */
const mark = (fill: string | "lanes") =>
  fill === "lanes"
    ? MARK_LANES.map(
        (d, i) => `<path d="${d}" fill="${LANE[i]}" stroke="${LANE[i]}" stroke-width="3" stroke-linejoin="round"/>`,
      ).join("")
    : `<path d="${MARK_D}" fill="${fill}" stroke="${fill}" stroke-width="3" stroke-linejoin="round"/>`;
const MARK_BOX = { x: 12.5, y: 4.5, w: 45, h: 55 };

// --- the wordmark: "Talk Tracks" as outlines ----------------------------------------------------------------------
interface Wordmark {
  d: string;
  bbox: [number, number, number, number];
}
const WORD: Wordmark = JSON.parse(readFileSync(new URL("./wordmark.json", import.meta.url), "utf8"));
const [wx0, wy0, wx1, wy1] = WORD.bbox;
const WORD_H = wy1 - wy0;

const svgDoc = (viewBox: string, body: string, title = "Talk Tracks") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`;

function logomark(fill: string) {
  return svgDoc("5 2 60 60", mark(fill));
}

function wordmark(fill: string) {
  const pad = 24;
  return svgDoc(
    `${wx0 - pad} ${wy0 - pad} ${wx1 - wx0 + 2 * pad} ${WORD_H + 2 * pad}`,
    `<path d="${WORD.d}" fill="${fill}"/>`,
  );
}

/** The mark as tall as the wordmark's ink, then a gap, then the wordmark; in font units. */
function lockup(fill: string) {
  const s = WORD_H / MARK_BOX.h;
  const markW = MARK_BOX.w * s;
  const gap = 300;
  const tx = markW + gap - wx0;
  const body =
    `<g transform="translate(${r1(-MARK_BOX.x * s)} ${r1(wy0 - MARK_BOX.y * s)}) scale(${r1(s, 1000)})">${mark("lanes")}</g>` +
    `<g transform="translate(${r1(tx)} 0)"><path d="${WORD.d}" fill="${fill}"/></g>`;
  const width = markW + gap + (wx1 - wx0);
  const pad = 24;
  return svgDoc(`${-pad} ${wy0 - pad} ${r1(width + 2 * pad)} ${WORD_H + 2 * pad}`, body);
}
const r1 = (n: number, k = 10) => Math.round(n * k) / k;

/**
 * favicon.svg: on a light browser theme the lane mark sits on a dark tile; on a dark one the tile goes and the mark
 * fills the square on the dark tab strip.
 */
function favicon(followDark = true) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    (followDark
      ? `<style>@media (prefers-color-scheme:dark){.t{display:none}.m{transform:translate(-3px,-4px) scale(1.15)}}</style>`
      : "") +
    `<rect class="t" width="64" height="64" rx="14" fill="${GROUND}"/>` +
    `<g class="m" transform="translate(6 6) scale(.8125)">${mark("lanes")}</g></svg>\n`
  );
}

// --- pages rendered to PNG -------------------------------------------------------------------------------------
const font = (file: string) =>
  `url(data:font/woff2;base64,${readFileSync(join(PUBLIC, "fonts", file)).toString("base64")})`;
const FONTS = `
@font-face{font-family:"Atkinson Hyperlegible Next";src:${font("atkinson-next-400.woff2")};font-weight:400}
@font-face{font-family:"Atkinson Hyperlegible Next";src:${font("atkinson-next-600.woff2")};font-weight:600}
@font-face{font-family:"Atkinson Hyperlegible Next";src:${font("atkinson-next-700.woff2")};font-weight:700}`;
/** The hub's ground: near-black lit by the three lanes. */
const GLOW = `radial-gradient(900px 520px at 85% -10%, rgb(79 139 255 / .32), transparent 62%),
  radial-gradient(800px 500px at -10% 70%, rgb(255 79 139 / .22), transparent 60%),
  radial-gradient(900px 600px at 60% 120%, rgb(32 211 174 / .16), transparent 62%), ${GROUND}`;
const page = (w: number, h: number, body: string, bg = "transparent") =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${FONTS}
html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${bg}}
body{font-family:"Atkinson Hyperlegible Next",sans-serif;color:${TEXT}}
.title{font-weight:700;letter-spacing:-0.03em;line-height:1}
.glass{background:rgb(24 28 42 / .55);border:1px solid rgb(255 255 255 / .12);box-shadow:inset 0 1px 0 rgb(255 255 255 / .16)}
</style></head><body>${body}</body></html>`;

/** An app icon: the lane mark on the dark ground. `inset` is the mark's share of the side. */
function iconPage(size: number, { rounded, inset }: { rounded: boolean; inset: number }) {
  const side = size * inset;
  const scale = side / MARK_BOX.h;
  const ox = (size - MARK_BOX.w * scale) / 2 - MARK_BOX.x * scale + size * 0.015; // optical nudge: a play leans left
  const oy = (size - MARK_BOX.h * scale) / 2 - MARK_BOX.y * scale;
  return page(
    size,
    size,
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block">` +
      `<rect width="${size}" height="${size}" rx="${rounded ? size * 0.22 : 0}" fill="${GROUND}"/>` +
      `<g transform="translate(${r1(ox)} ${r1(oy)}) scale(${r1(scale, 1000)})">${mark("lanes")}</g></svg>`,
  );
}

/** The mark and the name in a row, `h` px tall. */
const brandRow = (h: number) =>
  `<div style="display:flex;align-items:center;gap:${r1(h * 0.32)}px">
    <svg width="${r1((h * MARK_BOX.w) / MARK_BOX.h)}" height="${h}" viewBox="${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.w} ${MARK_BOX.h}" overflow="visible" style="filter:drop-shadow(0 0 ${r1(h / 4)}px rgb(79 139 255 / .5))">${mark("lanes")}</svg>
    <span class="title" style="font-size:${r1(h * 0.95)}px">Talk Tracks</span>
  </div>`;

/** The hero's timeline, drawn: lanes of clips running up to a live edge. */
function tracksPanel(w: number) {
  const rows: [string, string, number[]][] = [
    ["Speaker", "rgb(255 255 255 / .55)", []],
    ["Captions", LANE[1], [0.05, 0.2, 0.26, 0.44, 0.5, 0.71, 0.77, 0.95]],
    ["Español", LANE[2], [0.1, 0.24, 0.3, 0.52, 0.58, 0.8, 0.86, 0.98]],
    ["العربية", LANE[0], [0.02, 0.18, 0.24, 0.4, 0.48, 0.66, 0.74, 0.9]],
    ["Slides", "rgb(255 255 255 / .85)", [0.14, 0.3, 0.62, 0.78]],
  ];
  const lane = w * 0.6;
  const strip = (color: string, spans: number[]) =>
    spans.length
      ? spans
          .reduce<number[][]>((acc, x, i) => (i % 2 ? (acc.at(-1)!.push(x), acc) : [...acc, [x]]), [])
          .map(
            ([a, b]) =>
              `<span style="position:absolute;top:3px;bottom:3px;left:${r1(a! * 100)}%;width:${r1((b! - a!) * 100)}%;border-radius:4px;background:${color}"></span>`,
          )
          .join("")
      : `<span style="position:absolute;inset:3px 0;background:repeating-linear-gradient(90deg,${color} 0 2px,transparent 2px 5px)"></span>`;
  return `<div class="glass" style="width:${w}px;padding:${r1(w * 0.06)}px;border-radius:${r1(w * 0.06)}px;box-sizing:border-box">
    <div style="display:flex;justify-content:space-between;font-size:${r1(w * 0.034)}px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};margin-bottom:${r1(w * 0.04)}px"><span>Tracks in this talk</span><span style="color:#ff8a83">Live edge</span></div>
    ${rows
      .map(
        ([
          name,
          color,
          spans,
        ]) => `<div style="display:flex;align-items:center;gap:${r1(w * 0.04)}px;margin-top:${r1(w * 0.028)}px">
      <span style="width:${r1(w * 0.3)}px;font-size:${r1(w * 0.04)}px;color:${MUTED}">${name}</span>
      <span style="position:relative;display:block;width:${r1(lane)}px;height:${r1(w * 0.045)}px;border-radius:99px;background:rgb(255 255 255 / .06);overflow:hidden">${strip(color, spans)}<span style="position:absolute;right:0;top:0;bottom:0;width:3px;background:#ff5b52;box-shadow:0 0 12px 3px rgb(255 91 82 / .7)"></span></span>
    </div>`,
      )
      .join("")}
  </div>`;
}

const TAGLINE =
  "Live lectures you can rewind, with AI tracks you pick: subtitles in your language, chapters and slide descriptions.";

function socialCard() {
  return page(
    1200,
    630,
    `<div style="position:absolute;left:84px;top:92px;width:560px">
      ${brandRow(74)}
      <p style="margin:44px 0 0;font-size:31px;line-height:1.38;color:${TEXT}">${TAGLINE}</p>
    </div>
    <div style="position:absolute;left:700px;top:150px">${tracksPanel(430)}</div>`,
    GLOW,
  );
}

function titleCard() {
  return page(
    1920,
    1080,
    `<div style="position:absolute;left:180px;top:330px;width:880px">
      ${brandRow(120)}
      <p style="margin:60px 0 0;font-size:46px;line-height:1.36">${TAGLINE}</p>
    </div>
    <div style="position:absolute;left:1160px;top:320px">${tracksPanel(600)}</div>`,
    GLOW,
  );
}

/** The public repository, on the end card. */
const REPO = "github.com/LeventAksakal/talk-tracks";
/** The live site, on the end card. */
const SITE = "talk-tracks.leventaksakal.com";

function endCard() {
  return page(
    1920,
    1080,
    `<div style="position:absolute;left:0;right:0;top:200px;text-align:center">
      <p class="title" style="margin:0;font-size:150px">Thanks for watching</p>
    </div>
    <div style="position:absolute;left:0;right:0;top:470px;display:flex;flex-direction:column;align-items:center">
      ${brandRow(96)}
      <p style="margin:44px 0 0;font-size:40px;color:${MUTED}">Live talks over Media over QUIC, with AI tracks.</p>
      <p style="margin:34px 0 0;font-size:52px;color:${TEXT}">${SITE}</p>
      <p style="margin:16px 0 0;font-size:40px;color:${MUTED}">${REPO}</p>
    </div>
    <div style="position:absolute;left:0;right:0;top:1000px;height:6px;background:linear-gradient(90deg,${LANE[0]},${LANE[1]} 52%,${LANE[2]})"></div>`,
    GLOW,
  );
}

// --- rendering ---------------------------------------------------------------------------------------------------
const CHROME =
  process.env.CHROME ??
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((p) => existsSync(p));
if (!CHROME) throw new Error("No Chrome found: set CHROME to the browser's path.");

const tmp = mkdtempSync(join(tmpdir(), "tt-brand-"));
let n = 0;
function shoot(html: string, w: number, h: number, out: string, transparent = false) {
  const src = join(tmp, `p${n++}.html`);
  writeFileSync(src, html);
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${w},${h}`,
    `--screenshot=${out}`,
    ...(transparent ? ["--default-background-color=00000000"] : []),
    pathToFileURL(src).href,
  ];
  const run = spawnSync(CHROME!, args, { encoding: "utf8" });
  if (run.status !== 0 || !existsSync(out)) throw new Error(`Chrome failed on ${out}: ${run.stderr}`);
  const png = readFileSync(out);
  const [pw, ph] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  if (pw !== w || ph !== h) throw new Error(`${out} is ${pw}x${ph}, expected ${w}x${h}`);
  return png;
}

/** A .ico holding PNG images (every current browser reads PNG entries). */
function ico(pngs: { size: number; data: Buffer }[]) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

const manifest = {
  name: "Talk Tracks",
  short_name: "Talk Tracks",
  description: "Live talks with AI tracks: subtitles, translations, slide descriptions, chapters.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: GROUND,
  theme_color: GROUND,
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

mkdirSync(VIDEO, { recursive: true });
const write = (path: string, data: string | Buffer) => {
  writeFileSync(path, data);
  console.log(`${path.slice(WEB.length).replaceAll("\\", "/").padEnd(40)} ${statSync(path).size.toLocaleString()} B`);
};

try {
  write(join(BRAND, "logomark-on-dark.svg"), logomark("lanes"));
  write(join(BRAND, "logomark-on-light.svg"), logomark("lanes"));
  write(join(BRAND, "wordmark-on-dark.svg"), wordmark(TEXT));
  write(join(BRAND, "wordmark-on-light.svg"), wordmark(GROUND));
  write(join(BRAND, "lockup-on-dark.svg"), lockup(TEXT));
  write(join(BRAND, "lockup-on-light.svg"), lockup(GROUND));
  write(join(PUBLIC, "favicon.svg"), favicon());

  // The .ico cannot follow the browser's theme: it is always the tile.
  const fav = (size: number) =>
    shoot(
      page(
        size,
        size,
        `<img src="data:image/svg+xml;base64,${Buffer.from(favicon(false)).toString("base64")}" width="${size}" height="${size}" style="display:block">`,
      ),
      size,
      size,
      join(tmp, `fav${size}.png`),
      true,
    );
  write(join(PUBLIC, "favicon.ico"), ico([16, 32].map((size) => ({ size, data: fav(size) }))));
  write(
    join(PUBLIC, "apple-touch-icon.png"),
    shoot(iconPage(180, { rounded: false, inset: 0.6 }), 180, 180, join(tmp, "a.png")),
  );
  write(
    join(PUBLIC, "icon-192.png"),
    shoot(iconPage(192, { rounded: true, inset: 0.6 }), 192, 192, join(tmp, "i192.png"), true),
  );
  write(
    join(PUBLIC, "icon-512.png"),
    shoot(iconPage(512, { rounded: true, inset: 0.6 }), 512, 512, join(tmp, "i512.png"), true),
  );
  // Maskable: full bleed; the mark stays inside the 80 % safe circle.
  write(
    join(PUBLIC, "icon-maskable-512.png"),
    shoot(iconPage(512, { rounded: false, inset: 0.46 }), 512, 512, join(tmp, "m512.png")),
  );
  write(join(PUBLIC, "site.webmanifest"), JSON.stringify(manifest, null, 2) + "\n");
  write(join(PUBLIC, "og.png"), shoot(socialCard(), 1200, 630, join(tmp, "og.png")));
  write(join(VIDEO, "title.png"), shoot(titleCard(), 1920, 1080, join(tmp, "title.png")));
  write(join(VIDEO, "end.png"), shoot(endCard(), 1920, 1080, join(tmp, "end.png")));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
