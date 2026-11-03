#!/usr/bin/env node
// Talk Tracks QA harness: journey screenshots across browsers, Lighthouse, and a Chrome performance trace, against
// one base URL. See qa/README.md. The base URL comes from --base or TT_BASE_URL; the deployed hostname is never
// written to the repo, and every text output is redacted of it.

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureJourneys } from "./lib/capture.mjs";
import { JOURNEYS } from "./lib/journeys.mjs";
import { runLighthouse } from "./lib/lighthouse.mjs";
import { writeReport } from "./lib/report.mjs";
import { writeContactSheets } from "./contact-sheet.mjs";
import { runTrace } from "./lib/trace.mjs";
import { buildId, ensureDir, isLocal, list, makeRedactor, parseArgs, stamp } from "./lib/util.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`usage: npm run qa -- [--base <url>] [options]

  --base <url>          the app's base URL (default: $TT_BASE_URL)
  --run <name>          output folder name under qa/out/ (default: <yyyymmdd-hhmm>-<local|deployed>)
  --browsers <list>     chromium,firefox,webkit,chrome,msedge (default: all; branded ones only if installed)
  --themes <list>       dark,light (default: both)
  --journeys <list>     ${JOURNEYS.map((j) => j.id).join(",")} (default: all)
  --offline             only what needs no relay: journeys demo, hub, create; Lighthouse and trace on /demo
  --room <name>         the demo room to watch (default: dataviz)
  --recording <name>    the recording the recording journey plays (default: <room>-recording)
  --overlay <dir>       serve this local build (web/dist) in place of the site's own files, under its origin:
                        a change seen against the deployed relay and rooms before it is deployed (journeys only)
  --translation <name>  the translation to pick, only if the room lists it as running (default: none, the step is
                        skipped: every translation is lazy and paid, decision 0035)
  --trace-path <path>   the page to trace (default: /watch/<room>, or /demo with --offline)
  --trace-seconds <n>   seconds of playback in the trace (default: 60)
  --lighthouse-pages <list>  hub,watch,demo (default: all three; watch is dropped with --offline)
  --deck <pdf>          a PDF the console journey loads as slides (default: none, the step is skipped)
  --skip-capture | --skip-lighthouse | --skip-trace`);
  process.exit(0);
}

const base = args.base ?? process.env.TT_BASE_URL;
if (!base) {
  console.error("No base URL: pass --base <url> or set TT_BASE_URL.");
  process.exit(2);
}
const baseUrl = new URL(base).toString();
const redact = makeRedactor(baseUrl);
const offline = Boolean(args.offline);
const room = args.room ?? "dataviz";
const journeyIds = list(args.journeys, offline ? "demo,hub,create" : JOURNEYS.map((j) => j.id).join(","));
const tracePath = args["trace-path"] ?? (offline ? "/demo" : `/watch/${room}`);
const lhPages = list(args["lighthouse-pages"], offline ? "hub,demo" : "hub,watch,demo");
const run = args.run ?? `${stamp()}-${isLocal(baseUrl) ? "local" : "deployed"}`;
const runDir = ensureDir(resolve(here, "out", run));
const overlay = args.overlay ? resolve(args.overlay) : undefined;
const deck = args.deck ? resolve(args.deck) : undefined;
const opts = { base: baseUrl, room, recording: args.recording, overlay, redact, translation: args.translation, deck };
const log = (s) => console.log(redact(s));

// A base that does not answer would turn every step into the same failure: stop with one clear line instead.
try {
  const res = await fetch(baseUrl, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (e) {
  console.error(redact(`The base URL does not answer (${e.message}): ${baseUrl}`));
  process.exit(2);
}

const started = new Date();
const buildStart = await buildId(baseUrl);
log(`QA run ${run} against ${baseUrl} (build ${buildStart})`);
log(`  output: ${runDir}`);
if (overlay) log(`  overlay: the journeys load the local build in ${overlay}; the build ids above are the site's`);

let capture, lighthouse, trace;
if (!args["skip-capture"]) {
  log("1/3 journeys");
  capture = await captureJourneys({
    runDir,
    browsers: list(args.browsers, "chromium,chrome,msedge,firefox,webkit"),
    themes: list(args.themes, "dark,light"),
    journeyIds,
    opts,
    log,
  });
}
const builds = { start: buildStart };
if (!args["skip-lighthouse"]) {
  log("2/3 lighthouse");
  builds.lighthouse = await buildId(baseUrl);
  const paths = { hub: "/", watch: `/watch/${room}`, demo: "/demo" };
  lighthouse = await runLighthouse({ runDir, pages: lhPages.map((id) => ({ id, path: paths[id] })), opts, redact, log });
}
if (!args["skip-trace"]) {
  log("3/3 trace");
  builds.trace = await buildId(baseUrl);
  trace = await runTrace({ runDir, path: tracePath, seconds: Number(args["trace-seconds"] ?? 60), opts, log });
}
builds.end = await buildId(baseUrl);

const finished = new Date();
const meta = {
  run,
  baseShown: isLocal(baseUrl) ? baseUrl : "$TT_BASE_URL",
  started: started.toISOString(),
  finished: finished.toISOString(),
  minutes: ((finished - started) / 60000).toFixed(1),
  journeys: journeyIds,
  themes: list(args.themes, "dark,light"),
  room,
  tracePath,
  builds,
};
writeFileSync(join(runDir, "report.md"), writeReport({ meta, capture, lighthouse, trace, redact }));
writeFileSync(join(runDir, "summary.json"), redact(JSON.stringify({ meta, capture, lighthouse, trace }, null, 2)));
if (capture) await writeContactSheets(runDir, { log }); // after report.md so it can link the sheets
const caps = capture?.captures.filter((c) => c.file).length ?? 0;
const fails = capture?.failures.filter((f) => !f.skipped).length ?? 0;
log(`done in ${meta.minutes} min: ${caps} captures, ${fails} failed steps. Report: ${join(runDir, "report.md")}`);
