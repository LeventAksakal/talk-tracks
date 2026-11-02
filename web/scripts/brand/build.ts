// Builds every brand image in web/public from code, so the assets can be rebuilt after any change:
//   the logomark, wordmark and lockup (SVG, on dark and on light)   -> public/brand/
//   Chalky as a still SVG                                         -> public/brand/chalky.svg
//   favicon.svg (follows the browser's dark mode), favicon.ico,
//   apple-touch-icon.png, icon-192.png, icon-512.png, icon-maskable-512.png, site.webmanifest -> public/
//   the social card (1200x630)                                    -> public/og.png
//   the demo video's title and end cards (1920x1080)              -> public/brand/video/
//
// Run from anywhere with Node 23.6 or later (it strips the types itself):
//   node web/scripts/brand/build.ts
// PNGs are screenshots of generated pages in headless Chrome; set CHROME to its path if it is not in the usual
// place. The wordmark's outlines come from wordmark.json (wordmark.py). Chalky is the app's own rig (chalkyRig.ts).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CHALKY_VIEWBOX, type ChalkyPose, chalkyMarkup } from "../../src/brand/chalkyRig.ts";

const WEB = fileURLToPath(new URL("../../", import.meta.url));
const PUBLIC = join(WEB, "public");
const BRAND = join(PUBLIC, "brand");
const VIDEO = join(BRAND, "video");

// Tokens (web/src/theme/tokens.css): Blackboard; the "on light" files use Blackboard ink for Paper.
const BOARD = "#1b2420";
const BOARD_LINE = "#3a4842";
const CHALK_TEXT = "#f1ede2";
const MUTED = "#aab5ae";
const INK = { rose: "#ff6fae", sky: "#5fb3ff", sun: "#ffd84a" };

// --- the logomark: a play button cut into three lanes (the Reference Canvas's "Play of lanes") -------------------
// One talk, many tracks. Solid, so it holds at 16 px; round joins soften it into chalk. Drawn on a 64 grid; the ink
// spans x 12.5-57.5, y 4.5-59.5.
const MARK_D = "M14 6L33.4 18H14ZM14 26H46.3L56 32L46.3 38H14ZM14 46H33.4L14 58Z";
const mark = (fill: string, attrs = "") =>
  `<path d="${MARK_D}" fill="${fill}" stroke="${fill}" stroke-width="3" stroke-linejoin="round"${attrs}/>`;
const MARK_BOX = { x: 12.5, y: 4.5, w: 45, h: 55 };

// A chalk edge for large renders only (the pilot's filter): a faint displacement of the outline.
const CHALK_FILTER = `<filter id="chalk" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="4" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="1.4" xChannelSelector="R" yChannelSelector="G"/></filter>`;

// --- the wordmark: "Talk Tracks" in Cabin Sketch Bold, as outlines --------------------------------------------
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
function lockupBody(fill: string, markAttrs = "") {
  const s = WORD_H / MARK_BOX.h;
  const markW = MARK_BOX.w * s;
  const gap = 300;
  const tx = markW + gap - wx0;
  return {
    body:
      `<g transform="translate(${r1(-MARK_BOX.x * s)} ${r1(wy0 - MARK_BOX.y * s)}) scale(${r1(s, 1000)})">${mark(fill, markAttrs)}</g>` +
      `<g transform="translate(${r1(tx)} 0)"><path d="${WORD.d}" fill="${fill}"/></g>`,
    width: markW + gap + (wx1 - wx0),
  };
}
function lockup(fill: string) {
  const { body, width } = lockupBody(fill);
  const pad = 24;
  return svgDoc(`${-pad} ${wy0 - pad} ${r1(width + 2 * pad)} ${WORD_H + 2 * pad}`, body);
}
const r1 = (n: number, k = 10) => Math.round(n * k) / k;

/**
 * favicon.svg: on a light browser theme the chalk mark sits on a Blackboard tile; on a dark one the tile goes and
 * the mark fills the square, chalk on the dark tab strip.
 */
function favicon(followDark = true) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    (followDark
      ? `<style>@media (prefers-color-scheme:dark){.t{display:none}.m{transform:translate(-3px,-4px) scale(1.15)}}</style>`
      : "") +
    `<rect class="t" width="64" height="64" rx="14" fill="${BOARD}"/>` +
    `<g class="m" transform="translate(6 6) scale(.8125)">${mark(CHALK_TEXT)}</g></svg>\n`
  );
}

/** Chalky as a standalone SVG, every colour inline. */
function chalkySvg(pose: ChalkyPose, title: string) {
  return svgDoc(CHALKY_VIEWBOX, chalkyMarkup(pose), title);
}
/** Chalky inline in a page, at a height in px, standing on a ledge line at `ground` px from the top. */
const standing = (pose: ChalkyPose, height: number, left: number, ground: number) =>
  `<div style="position:absolute;left:${left}px;top:${Math.round(ground - (height * 172) / 182)}px">${chalkyInline(pose, height)}</div>`;
/** Chalky inline in a page, at a height in px. */
const chalkyInline = (pose: ChalkyPose, height: number) =>
  `<svg viewBox="${CHALKY_VIEWBOX}" height="${height}" width="${Math.round((height * 128) / 182)}" overflow="visible" style="--chalky-line:${BOARD};--chalky-mark:${CHALK_TEXT}">${chalkyMarkup(pose)}</svg>`;

// --- pages rendered to PNG -------------------------------------------------------------------------------------
const font = (file: string) =>
  `url(data:font/woff2;base64,${readFileSync(join(PUBLIC, "fonts", file)).toString("base64")})`;
const FONTS = `
@font-face{font-family:"Talk Tracks Title";src:${font("tt-title-700.woff2")};font-weight:700}
@font-face{font-family:"Atkinson Hyperlegible Next";src:${font("atkinson-next-400.woff2")};font-weight:400}
@font-face{font-family:"Atkinson Hyperlegible Next";src:${font("atkinson-next-600.woff2")};font-weight:600}`;
const page = (w: number, h: number, body: string, bg = "transparent") =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${FONTS}
html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${bg}}
body{font-family:"Atkinson Hyperlegible Next",sans-serif;color:${CHALK_TEXT}}
.title{font-family:"Talk Tracks Title",sans-serif;font-weight:700}
</style></head><body>${body}</body></html>`;

/** An app icon: the chalk mark on Blackboard, with the chalk edge. `inset` is the mark's share of the side. */
function iconPage(size: number, { rounded, inset }: { rounded: boolean; inset: number }) {
  const side = size * inset;
  const scale = side / MARK_BOX.h;
  const ox = (size - MARK_BOX.w * scale) / 2 - MARK_BOX.x * scale + size * 0.015; // optical nudge: a play leans left
  const oy = (size - MARK_BOX.h * scale) / 2 - MARK_BOX.y * scale;
  return page(
    size,
    size,
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block"><defs>${CHALK_FILTER}</defs>` +
      `<rect width="${size}" height="${size}" rx="${rounded ? size * 0.22 : 0}" fill="${BOARD}"/>` +
      `<g transform="translate(${r1(ox)} ${r1(oy)}) scale(${r1(scale, 1000)})">${mark(CHALK_TEXT, ' filter="url(#chalk)"')}</g></svg>`,
  );
}

/** The three-lane stroke from Chalky's back, in the chalk box's rose, sky and sun. */
const lanes = (w: number) =>
  `<svg width="${w}" height="${w * 0.42}" viewBox="0 0 30 12.6" style="display:block" stroke-width="3" stroke-linecap="round"><path d="M1.5 1.5h27" stroke="${INK.rose}"/><path d="M1.5 6.3h27" stroke="${INK.sky}"/><path d="M1.5 11.1h18" stroke="${INK.sun}"/></svg>`;

/** The lockup inline, as wide as asked, with the chalk edge on the mark. */
function lockupInline(width: number) {
  const { body, width: w } = lockupBody(CHALK_TEXT, ' filter="url(#chalk)"');
  const h = (width * WORD_H) / w;
  return `<svg width="${width}" height="${r1(h)}" viewBox="0 ${wy0} ${r1(w)} ${WORD_H}" overflow="visible" style="display:block"><defs>${CHALK_FILTER}</defs>${body}</svg>`;
}

const TAGLINE =
  "Live lectures you can rewind, with AI tracks you pick: subtitles in your language, chapters and slide descriptions.";

function socialCard() {
  return page(
    1200,
    630,
    `<div style="position:absolute;inset:0;padding:84px 0 0 88px;box-sizing:border-box">
      ${lockupInline(620)}
      <div style="margin:34px 0 0 4px">${lanes(64)}</div>
      <p style="margin:30px 0 0;width:560px;font-size:31px;line-height:1.38;color:${CHALK_TEXT}">${TAGLINE}</p>
    </div>
    <div style="position:absolute;left:0;right:0;top:540px;border-top:2px solid ${BOARD_LINE}"></div>
    ${standing({ cycle: "talk" }, 440, 790, 541)}`,
    BOARD,
  );
}

function titleCard() {
  return page(
    1920,
    1080,
    `<div style="position:absolute;left:0;right:0;top:850px;border-top:3px solid ${BOARD_LINE}"></div>
    ${standing({ cycle: "wave" }, 620, 250, 852)}
    <div style="position:absolute;left:760px;top:330px">
      ${lockupInline(900)}
      <div style="margin:44px 0 0 6px">${lanes(90)}</div>
      <p style="margin:40px 0 0;width:860px;font-size:44px;line-height:1.36">${TAGLINE}</p>
    </div>`,
    BOARD,
  );
}

/** The public repository, on the end card. */
const REPO = "github.com/LeventAksakal/talk-tracks";

function endCard() {
  return page(
    1920,
    1080,
    `<div style="position:absolute;left:0;right:0;top:850px;border-top:3px solid ${BOARD_LINE}"></div>
    <div style="position:absolute;left:0;right:0;top:206px;text-align:center">
      <p class="title" style="margin:0;font-size:150px;line-height:1">Thanks for watching</p>
    </div>
    ${standing({ cycle: "wave", face: "laugh" }, 460, 300, 852)}
    <div style="position:absolute;left:770px;top:470px">
      ${lockupInline(820)}
      <p style="margin:34px 0 0;font-size:40px;color:${MUTED}">Live talks over Media over QUIC, with AI tracks.</p>
      <p style="margin:22px 0 0;font-size:44px;color:${CHALK_TEXT}">${REPO}</p>
    </div>`,
    BOARD,
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
  background_color: BOARD,
  theme_color: BOARD,
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
  write(join(BRAND, "logomark-on-dark.svg"), logomark(CHALK_TEXT));
  write(join(BRAND, "logomark-on-light.svg"), logomark(BOARD));
  write(join(BRAND, "wordmark-on-dark.svg"), wordmark(CHALK_TEXT));
  write(join(BRAND, "wordmark-on-light.svg"), wordmark(BOARD));
  write(join(BRAND, "lockup-on-dark.svg"), lockup(CHALK_TEXT));
  write(join(BRAND, "lockup-on-light.svg"), lockup(BOARD));
  write(join(BRAND, "chalky.svg"), chalkySvg({ cycle: "still" }, "Chalky, the Talk Tracks mascot"));
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
