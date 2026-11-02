# 06 · QA and performance

> **Scope (owner, 2026-10-30):** desktop only, Chrome first. Phone, iPhone and Safari items in this file are out of scope.

**Status:** not started · **Session:** — · **Window:** Mon Nov 2, 12:00 → Tue Nov 3, 16:00 +03 · **Depends on:** 01
(acceptance criteria), 03 and 04 merged and deployed · **Feeds:** 07

## Goal

Prove the product works and is fast before the freeze: walk every journey, measure performance in Chrome DevTools
and Lighthouse, check every screen visually in both themes and on a phone, and hand a ranked fix list back to 03, 04
and 05.

## Read first

- `wiki/product/journeys.md` (01): acceptance criteria are the test script.
- [product/ui-design.md](../product/ui-design.md) §5 (player states), §6 (phone), §9 (accessibility targets).
- [plan.md §Risks](../plan.md#risks): Safari and iPhone always use the WebSocket fallback.

## Targets

| Measure | Target | Pages |
|---|---|---|
| LCP | ≤ 2.5 s (mobile, throttled) | lobby, watch, ended room |
| INP | ≤ 200 ms | lobby, player controls, console tools |
| CLS | ≤ 0.1 | all |
| Lighthouse Performance | ≥ 90 lobby, ≥ 75 player | lobby, watch |
| Lighthouse Accessibility | ≥ 95 | all |
| Lighthouse Best Practices / SEO | ≥ 95 / ≥ 90 | lobby |
| JS on the lobby | ≤ 200 KB gzip; no PDF.js, no console code | lobby |
| Time to first frame | ≤ 2 s on WebTransport, ≤ 4 s on WebSocket | watch |
| Drawing | no long task over 50 ms while drawing; no dropped frames on the laser | console, watch |
| Memory | no steady growth over a 20 min loop in a demo room | watch |

## Passes

1. **Journey walk-through:** J1–J8 on the VM in Chrome desktop, each acceptance criterion ticked or filed.
2. **Lighthouse:** mobile and desktop for lobby, watch (demo room), ended room, talk (pre-flight). Save the reports.
3. **DevTools performance traces:** page load of lobby and watch; 30 s of drawing on the console; a seek and go live
   in the player; a 20 min memory timeline.
4. **Network:** bundle sizes per route (Coverage tab), caching headers on `/assets/` and `/archive/`, no
   unused fonts or images.
5. **Visual verification:** a screenshot of every screen and state from journeys.md's screen inventory, in light and
   dark, at 1440×900, 1024×768, 390×844 (phone portrait) and 844×390 (landscape). Compare against the design and
   the brand; file anything off.
6. **Accessibility:** keyboard-only run of J2 and J3, screen reader spot check (subtitle and description
   announcements), 200 % zoom, contrast of subtitles and ink on light and dark slides.
7. **Cross-browser:** Chrome, Edge, Firefox, Safari on macOS, Safari on iPhone, Chrome on Android. The iPhone and
   Mac runs need the owner's devices.

## Deliverables

- `wiki/qa/report.md`: the targets table with measured values, pass or fail, links to saved reports and traces.
- `wiki/qa/screens/`: the screenshots, named `<screen>-<state>-<theme>-<viewport>.png`.
- `wiki/qa/fixes.md`: a ranked fix list (P0 blocks the demo, P1 visible to judges, P2 polish) with the workstream
  that owns each fix; re-measure after fixes.

## Definition of done

- Every P0 and P1 fixed and re-measured, or accepted by the owner in writing.
- The report has numbers for every target row.

## Start prompt

> You are the QA and performance session for Talk Tracks. Read `wiki/workstreams/06-qa-performance.md` and
> journeys.md. Use Chrome DevTools against the deployed site (the owner gives you the URL). Run the passes in order,
> write `wiki/qa/report.md` and `wiki/qa/fixes.md` as you go, and log progress in the workstream file.

## Log

| When (+03) | Session | Entry |
|---|---|---|
| 10-31 12:57 | coordinator | Brief written. |
| 11-02 18:10 | QA harness lane | Harness in `qa/` (branch `lane/qa-harness`): journey screenshots in Chromium, Chrome, Edge, Firefox and WebKit, dark and light; Lighthouse desktop on hub, watch and `/demo`; a Chrome trace of a watch page. One command, `npm run qa --prefix qa` (README there). Proved on a local preview of `main` (offline parts: 300 captures, 0 failed steps, 19 min) and twice on the deployed site (540 and 548 captures). Both deployed runs straddled redeploys (build 4, then chat, then polish), so the ranked list below is provisional; the freeze run after Tue 10:00 is the one that counts. Not measured yet: phone (out of scope), 20 min memory loop, drawing latency on the console, real camera and mic. |
| 11-02 20:00 | perf and infra lane | Branch `lane/perf-infra`, findings 4, 6, 10 and 14. **Compression and caching (4, 14):** the Caddyfile compresses the app and the create-room JSON (zstd, gzip; text types only, so woff2, PNG and archive segments are left alone), caches `/fonts/*` and `/brand/*` a year as immutable, revalidates `index.html` by ETag, and `web/public/robots.txt` allows all. Checked against `caddy:2.10.2` locally: the 1.23 MB entry arrives as 0.38 MB. Needs a Caddy restart on the VM (deploy howto). **Bundle (4):** routes are lazy chunks, the hub's MoQ stack loads after its first paint, a room card's hover or focus preloads the watch chunk. Hub JS before its first paint: 371 KB gzip → 132 KB (plus 97 KB of MoQ after it, for Live now). The 721 ms load task's main cause was Ajv compiling 15 schemas on import (252 of a 307 ms task locally); each now compiles on first use. Local Lighthouse (desktop, `vite preview`, uncompressed): hub 91 → 100, TBT 224 → 0 ms; demo 86 → 88, TBT 305 → 254 ms. What is left on `/demo` is a 232 ms task drawing the scripted slides (`player/demoSlides.ts`, Player lane). **Console (10):** on the public relay, Go on air stays disabled without a valid token for the room, and the token check offers Paste your speaker link. **Arabic at the live edge (6):** confirmed in source: a translation line goes out once its whole caption line is final (the offline track copies that, +2 s), while the looper shows the line's early cues mid-line; the looper now sends each translated cue with its caption cue. Needs an agents rebuild and the loopers restarted. Not measured on the VM yet: the deployed numbers and the Arabic gap. |

### Ranked findings, harness runs of 11-02

Severity: P0 blocks the demo, P1 visible to judges, P2 polish, P3 note. Paths are under `qa/out/` on the QA machine
(not in git: a run is 50 to 150 MB). `B4` is the run `20261102-deployed-build4`, `R1` the earlier `20261102-deployed`,
`L` the local run `20261102-local-main`. Source lines are on `origin/main` at `893fc11`.

| # | Sev | Finding | Evidence | Cause (confirmed in source unless marked) | Owner |
|---|---|---|---|---|---|
| 1 | — | **The instrument, first.** The site was redeployed three times during the deployed runs, and Firefox lost Playwright's dark-theme emulation on the cross-origin-isolated site, so every Firefox "dark" frame in R1 and B4 is light. Harness fixed (Firefox theme forced by pref, builds recorded per browser, a warning when a run straddles a redeploy); Firefox dark needs the freeze run. | `B4/firefox/hub-top-dark.png` (light) | measured: `prefers-color-scheme: dark` false on the site, true on a `data:` page | QA harness (done) |
| 2 | P0 | **A looped demo room says "Talk ended" after Go live.** Rewind a minute, press Go live: "Talk ended · 19:00", pill `Ended`, "Replay from the start". Seen in Chromium and in the trace's Go-live step on build 4; Edge and Firefox went back to LIVE. The build before returned to LIVE (`R1/chromium/watch-back-live-dark.png`), so it came with build 4. Breaks J4 and demo moment 2. | `B4/chromium/watch-back-live-dark.png`; `B4/report.md` trace step "go live: Ended" | `web/src/player/state.ts:126` lets the room track's state win (`room === "ended"`) over the live edge; looped rooms now have a room track. Which loop's `ended` record it reads: unresolved | Event track archive and replay, Player |
| 3 | P1 | **The light theme breaks the player's overlays.** Under a light system theme the whole player turns light, but its overlays keep hard-coded black backgrounds, so their text is dark on black: the "Not started" heading, Stats for nerds' labels, the Camera chip, "No camera in this room", "Lost the connection". Measured: Camera chip `#1b2420` on about `#0e1013`, 1.2:1; Stats labels `#5b645e` on `#000d`, 2.6 to 3.4:1 (floor 4.5:1). | `B4/chromium/unknown-not-started-light.png`, `B4/chromium/watch-stats-light.png`, `L/chromium/demo-state-failed-light.png` | `player.css:13` sets `color-scheme: dark` on `.tt-player`, but the tokens are `light-dark()` values declared on `:root` (`tokens.css:7`) and resolve light there; overlays use `#000a`/`#000d` with token text (`player.css:236`, `:604`, `:651`) | App UI |
| 4 | P1 | **The web app is served uncompressed; fonts have no cache header.** `index-*.js` arrives as 1,220,303 bytes with `Accept-Encoding: gzip, br, zstd` (no `Content-Encoding`); fonts get no `Cache-Control`. Lighthouse Performance: hub 62 (TBT 860 ms), watch 39, demo 72. Even compressed, the hub's entry chunk is about 354 KB gzip against the 200 KB target. | `B4/lighthouse/hub.html` (total byte weight 1,578 KiB) | `deploy/Caddyfile:59` has no `encode` (only `/archive` indexes do, line 44) and caches only `/assets/*` (line 63) | Coordinator (deploy); App UI for the chunk |
| 5 | P1 | **The watch page shifts on load: CLS 0.36** (target 0.1), almost all from the camera's picture-in-picture tile. | `B4/lighthouse/watch.html` (layout shifts: `.tt-cell-camera.tt-cell-small`, 0.354) | unresolved which style moves it | Player |
| 6 | P1 | **Arabic is missing at the live edge in `dataviz` for long stretches.** With Arabic picked, the stage showed no subtitle and the panel no Arabic for the newest 20 to 45 s at 8:14, 14:37 and 17:40; at 3:33 it worked. Demo moment 1 depends on it. | `R1/chromium/watch-translation-arabic-light.png`, `R1/chrome/watch-translation-arabic-dark.png`; working: `B4/msedge/watch-translation-arabic-dark.png` | unresolved: the generated track's coverage or its timing | Demo content, Any-language translation |
| 7 | P1 | **"In this room" does not mean running.** The subtitles menu marks about 40 languages "in this room" (Bulgarian, Bangla, Catalan…) while Stats for nerds shows them off and unproduced. A viewer cannot tell a ready track from one that will wake a paid agent and wait. The harness picks only Arabic for this reason. | `R1/chromium/watch-subtitles-menu-dark.png`, `R1/chromium/watch-stats-dark.png` | `menus.tsx`: `offered = translationFor(tracks, tag) !== undefined`, i.e. listed in the catalog | Any-language translation, Player |
| 8 | P2 | **Side-panel tabs overflow at 1440×900.** With Chat added, Notes is clipped and Discussion and the close button are scrolled out of sight, with no sign there is more. Lighthouse also flags the close button inside the tablist (`aria-required-children`). | `B4/msedge/watch-back-live-light.png` | `player.css:1190` (`.tt-tabs` `overflow-x: auto`); `SidePanel.tsx` puts the close button in `role="tablist"` | Player |
| 9 | P2 | **The player pages have no main landmark**, and "Skip to content" points at `#main`, which /watch and /demo do not have. Lighthouse Accessibility 94 there (target 95). | `B4/lighthouse/watch.html`, `demo.html` | `App.tsx` skip link; `Player` renders no `<main id="main">` | Player |
| 10 | P2 | **The console offers Go on air with no token on the public relay.** The token check says "WAITING" in amber and Go on air stays the enabled primary action, though the relay will refuse it. (Not pressed: the harness never goes on air.) | `B4/chromium/console-preflight-mic-dark.png` | `Console.tsx` `tokenText`: `none` → `"wait"`; Go on air's `isDisabled` ignores the token | Speaker console |
| 11 | P2 | **A room that does not exist waits for a speaker.** `/watch/qa-no-such-room` shows "Not started · Starts when the speaker goes on air" and an amber "Room service unreachable" pill, never "No room called …". During the 16:39 redeploy a looped demo room said "Starts when Charlotte Rutherford goes on air". | `B4/chromium/unknown-not-started-dark.png`, `B4/chrome/watch-not-ready-dark.png` | `state.ts:114` needs `known === false`; with the room service unreachable it stays undefined | Player, room service |
| 12 | P2 | **Every demo watch page logged 404s** for `/archive/<room>/screen.m3u8` (62 in B4). Possibly fixed by "no archive probes in looped rooms" (6746e26, deployed 16:41); check in the freeze run. | `B4/report.md` console errors | Lighthouse console audit names the URL | Player |
| 13 | P3 | Stats for nerds shows the playhead as `780:47:01` (hours on the loop's clock) while the control bar says 12:01. | `R1/chromium/watch-stats-dark.png` | room clock printed raw | Player |
| 14 | P3 | `/robots.txt` returns the app's `index.html` (SEO "robots.txt is not valid"); the hub cannot use the back/forward cache because `@moq/net` adds an `unload` listener. | `B4/lighthouse/hub.html` | no `web/public/robots.txt`; `@moq/net/connection/reload.js:167` | App UI |
| 15 | P3 | WebKit on Windows (not Safari, out of scope): no `AudioDecoder`, the camera tile stays black, the console has no `mediaDevices`. | `B4/webkit/watch-playing-dark.png` | engine | — |
| 11-02 17:09 | coordinator | QA harness merged (4fdb1bb). Its two deployed runs are provisional (they spanned three redeploys). Findings routed: player fixes lane takes P0 "Talk ended" after Go live in a looped room, the player's light-theme contrast, CLS 0.36 from the camera tile, "in this room" for languages not running, side-panel tab overflow, the missing main landmark, unknown room shown as "Not started", the room-clock playhead in Stats for nerds; performance and infra lane takes Caddy compression and cache headers, robots.txt, bundle split (hub 354 KB gzip, target 200), the console's Go on air without a token, and Arabic missing at the live edge (VM check: the recorded tracks are complete, 26 windows of 27–45 s with no gaps, so the looper's publish timing is the suspect). Freeze run: no deploys while it runs, Tue after 10:00. |
| 11-02 17:49 | coordinator | Performance and infra merged (3f4c5c2; gate agents 307, web 249 passed) and deployed as QA build 8: Caddy restarted, bundle `index-C2n2YSRa.js`, agents rebuilt, loopers recreated; rollback `talk-tracks-agents:before-qa8`, `~/web-dist-f953536`, `~/Caddyfile-f953536`. Checked on the VM: the entry script comes with `content-encoding: zstd` and a one-year immutable cache header; `/robots.txt` is plain text; `/talk/<room>` without a token says it can't go on air. Local Lighthouse (lane): hub 91 → 100, TBT 224 → 0 ms; hub JS before first paint 371 → 132 KB gzip. Not measured yet on the VM: watch-page Lighthouse and Arabic at the live edge (freeze run). Lane questions settled: MoQ on the hub after first paint is enough before the freeze; Ajv at build time is after the hackathon. Open: old console tests that read `disabled` pass trivially on Astryx's `aria-disabled` (follow-up). |
| 11-02 17:58 | coordinator | Player fixes merged (c4c51c8; web gate 256 passed) and deployed, web only (`index-CvS8tAjp.js`). On the VM `/watch/virus` reads LIVE · looped recording with no console errors. Still wrong: an unknown room stays on "Looking for the room…" past 20 s instead of "No room called X"; a small fix lane is on it (`lane/unknown-room`). The counted QA run starts after that fix is deployed, with no deploys while it runs. |
| 11-02 18:13 | coordinator | Unknown-room fix merged (d8175cf; web gate 258 passed) and deployed; on the VM `/watch/no-such-room-qa` reads "No room called no-such-room-qa" after 6 s. **Freeze:** every feature lane is in, so deploys are frozen from now (earlier than the planned Tue 10:00) and the counted QA run is running on d8175cf (`lane/qa-freeze`): five browsers, dark and light, Lighthouse, trace, and a contact sheet for the owner. |
| 11-02 19:20 | QA freeze lane | **Counted run (d8175cf).** Run `20261102-counted-d8175cf`, 18:15–18:52, one build throughout (`index-i7MFUd6h`, no redeploy), 5 browsers × 2 themes × 6 journeys, Lighthouse, trace: 550 captures, 0 failed steps, 0 skipped, no harness fix needed. 13 of the 15 earlier findings are fixed in the frames and numbers; Lighthouse Performance still misses its targets on the hub and the watch page (one load task in the MoQ announcement path); new: subtitles sit over the camera tile. Results and the ranked open list: [Counted run (d8175cf)](#counted-run-d8175cf-11-02) below. |
| 11-02 19:45 | coordinator | Counted run merged (0bd6c49). **Freeze lifted** on the owner's review of the build: the player lacks basics, live demo translation looks fake, captions break mid-phrase, the site is not a streaming platform, the mascot goes (owner feedback ledger, decisions 0031–0033). Routed: player lane on Media Chrome (`lane/player-media-chrome`) takes QA items 1 (watch), 2, 4–8; site lane (`lane/site-streaming`) takes item 1 (hub) and 9; demo-sessions lane (`lane/demo-sessions`) takes the recording plus live session, the honest-AI switch `TT_DEMO_LIVE_AGENTS` and sentence breaks. Item 3 (the `unload` listener in `@moq/net`) is accepted as a dependency miss. Hand-offs Tue 14:00 (demo-sessions, player checkpoint) and 16:00 (site, player); new build for the owner's lecture Tue evening. |
| 11-02 20:30 | coordinator | Site lane merged (4ca332c; web gate: typecheck, lint, build pass; tests 263 passed, 1 failed under load and passed alone: `Console.test.tsx` "draws with the pen" got an extra `stroke` record, a timing flake to fix) and deployed, web only (`index-Cvnv_4Au.js`, rollback `~/web-dist-d8175cf`). On the VM: streaming hub, LIVE on the demo sessions, no console errors. Local Lighthouse (lane, with relay): hub performance 96, TBT 130 ms. Not checked yet: Recordings row with real `-recording` rooms (demo-sessions lane), Firefox, light theme. |
| 11-02 21:45 | coordinator | Demo-sessions merged (e288e61; agents gate 317 passed). Live sessions end and restart from 00:00, recording rooms `<id>-recording`, `TT_DEMO_LIVE_AGENTS`, `translations_with_captions` deleted, sentence cue breaks. **Held from the VM** until the player lane lands: the deployed player expects `period_ms` and would break on the new sessions. Owner approved the recordings token and $5 per demo room per day, switch on Tue evening (decision 0034). Unverified until the VM: the session flow on a real relay, agents restarting per session, `serve-recording` from the web, real forced-break counts. |
| 11-02 21:30 | coordinator | Player on Media Chrome and the integration fixes merged (56b324c; gate: agents 317 passed, web 276 passed and 1 real-timer flake in `aiTracks.test.ts` that passes alone; the aiomoqt deck test passed inside the agents image on the VM) and deployed with demo-sessions: agents image rebuilt (rollback `talk-tracks-agents:before-qa9`, `~/web-dist-4ca332c`, `~/env-before-qa9`), web `index-kqBrYxTA.js`, recordings token signed (first one carried a stale `--expires` from the docs and was refused; re-signed, docs fixed), four recording rooms built (13–16 s each) and served. On the VM: `/watch/virus` live session with chat and sending; `/watch/virus-recording` ended at 17:00, replays with sentence subtitles; hub Recordings row. Cue report: virus 200/246 forced, dataviz 195/234, rsa 3/240, qrcode 7/238 (the first two transcripts have almost no punctuation). Open: the pill still says "LIVE · LOOPED RECORDING"; the live session shows "Speaker audio, no picture yet" in the camera tile; recording rooms request `screen.m3u8` repeatedly (404); two timing-flaky tests (`Console.test.tsx` pen, `aiTracks.test.ts` FETCH hole). |

Dropped after checking source: "You missed 1:00" still showing after Go live is intended (`DemoPage.test.tsx:42`); the
hub's "Checking what is on air…" never resolving happened only on the local preview, which has no relay.

Performance trace (B4, Chrome 156, `/watch/dataviz`): load 2.3 s with 4 long tasks (longest 721 ms, 1,162 ms in
total) and the main thread 64 % busy; 60 s of playback with subtitles 26 % busy, no long task, 50 frames drawn per
second; seek and Go live 25 % busy, one 100 ms task. JS heap after GC 15.1 → 16.5 MB over 60 s (1.4 MB/min; the 20 min
loop is still to measure), DOM nodes 394 → 454. Offline demo (L): playback 8 % busy, no long task, 0.9 MB/min.

Lighthouse desktop (B4): hub 62 / 100 / 81 / 91 (performance, accessibility, best practices, SEO), watch 39 / 94 / 81 /
92, demo 72 / 94 / 100 / 92. Local preview (L, uncompressed HTTP): hub 91 / 100 / 59 / 91, demo 80 / 94 / 78 / 92.

### Counted run (d8175cf), 11-02

Run `20261102-counted-d8175cf` (`C` below; paths under `qa/out/`, not in git), 18:15–18:52 +03, 36.6 min, against the
VM serving `main` at d8175cf. One build for the whole run (`index-i7MFUd6h` at start, per browser, before Lighthouse,
before the trace and at the end), so differences between browsers are browser differences. 1440×900 @1x, reduced
motion, room `dataviz`, translation Arabic (listed "recorded in this room"). No room created, no chat sent, never on
air. Contact sheet: `C/index.html` (every capture by journey, browsers side by side).

**Captures per browser:** Chromium 156.0.8078.4, Chrome 156.0.8078.74, Edge 156.0.4314.58, Firefox 157.0, WebKit
27.2: 110 each (550), 0 failed steps, 0 skipped. Console errors: 18 across 12 captures, all WebKit (no `AudioDecoder`,
no `navigator.mediaDevices`) except 2 in Firefox ("fatal error running connection" on leaving the unknown room). No
`/archive` 404s anywhere.

**Lighthouse (desktop preset, branded Chrome):**

| Page | Performance | Accessibility | Best practices | SEO | LCP | TBT | CLS | Target missed |
|---|---|---|---|---|---|---|---|---|
| hub `/` | 77 | 100 | 81 | 100 | 0.6 s | 570 ms | 0.025 | Performance ≥ 90, Best practices ≥ 95 |
| watch `/watch/dataviz` | 72 | 100 | 81 | 100 | 0.7 s | 730 ms | 0.046 | Performance ≥ 75 |
| demo `/demo` | 92 | 100 | 100 | 100 | 0.8 s | 200 ms | 0.011 | none |

Against B4: hub 62 → 77, watch 39 → 72, demo 72 → 92; accessibility 94 → 100 on the player pages; SEO 91/92 → 100;
watch CLS 0.36 → 0.046. Transfer is compressed now (hub entry 82 KB for 243 KB). Hub JS: 135 KB compressed before
first paint plus 99 KB of MoQ after it (234 KB, target 200; the MoQ-after-paint split was accepted for the freeze).

**Trace** (Chrome 156, `/watch/dataviz`; B4 in brackets): load 2 s, main thread 60 % busy (64 %), 4 long tasks, 802 ms
in total (1,162), longest 626 ms (721); 60 s of playback with subtitles 16 % busy (26 %), no long task, 30 frames drawn
per second (50; a still-slide stretch draws fewer), rAF 144 fps with p95 frame 7 ms and none over 50 ms; seek back a
minute and Go live 14 % busy, one 55 ms task (100 ms), and Go live returned to "LIVE · looped recording". JS heap after
GC 14.9 → 16.2 MB over 60 s (1.3 MB/min, was 1.4); DOM nodes 414 → 474; listeners 262 → 272.

**Earlier findings against this run:**

| # | Finding | Now | Checked in |
|---|---|---|---|
| 1 | Firefox lost dark-theme emulation (instrument) | fixed: Firefox dark frames are dark | `C/firefox/hub-top-dark.png`, `watch-back-live-dark.png` |
| 2 | Looped room says "Talk ended" after Go live (P0) | fixed: LIVE · looped recording in the frames checked (Chromium, Chrome, Edge, Firefox, WebKit) and in the trace | `C/*/watch-back-live-*.png`; trace step "go live" |
| 3 | Light theme breaks the player's overlays | fixed: the player stays dark under a light system theme; Stats labels, unknown-room and failed cards readable | `C/chromium/watch-stats-light.png`, `unknown-not-started-light.png`, `demo-state-failed-light.png` |
| 4 | Uncompressed app, fonts uncached | fixed for compression and caching; Performance still under target (open 1) | `C/lighthouse/hub.html` |
| 5 | Watch CLS 0.36 from the camera tile | fixed: 0.046 (body 0.036, transcript 0.008) | `C/lighthouse/watch.html` |
| 6 | Arabic missing at the live edge | fixed: Arabic on the stage and beside the newest lines at 6:44, 9:15, 14:07, 17:02 and across the loop wrap (0:06) | `C/msedge/watch-translation-arabicrecorded-light.png`, `C/chromium/…-dark.png`, `C/firefox/watch-stats-light.png`, `C/webkit/…-dark.png`, `C/chrome/…-light.png` |
| 7 | "In this room" for languages not running | fixed: the menu says "recorded in this room" (Arabic, Spanish, Turkish) and "starts when picked · takes a moment" for the rest | `C/chromium/watch-subtitles-menu-dark.png` |
| 8 | Side-panel tabs overflow | fixed (arrows and a fade, close button out of the tablist, accessibility 100); stray letter fragments remain at the fade (open 6) | `C/chromium/demo-state-failed-dark.png` |
| 9 | No main landmark on the player pages | fixed: accessibility 100 on watch and demo | `C/lighthouse/watch.html` |
| 10 | Console offers Go on air with no token | fixed: Go on air disabled, Speaker token "NEEDS YOU" with Paste your speaker link | `C/chromium/console-preflight-mic-dark.png` |
| 11 | Unknown room waits for a speaker | fixed: "No room called qa-no-such-room", pill "No such room", Back to the hub | `C/*/unknown-not-started-*.png` |
| 12 | `/archive/<room>/screen.m3u8` 404s | fixed: none logged in 550 captures | `C/report.md` console errors |
| 13 | Stats playhead on the loop's raw clock | fixed: "playhead 9:45 · live edge 9:45" | `C/chromium/watch-stats-dark.png` |
| 14 | robots.txt invalid; `unload` listener blocks bfcache | robots fixed (SEO 100); `unload` still there (open 3) | `C/lighthouse/hub.html` |
| 15 | WebKit on Windows lacks AudioDecoder and mediaDevices | still there (engine, out of scope) | `C/webkit/watch-back-live-dark.png` |

**Ranked open list (counted run).** Sources are on `main` at d8175cf; probable unless marked confirmed.

| # | Sev | Finding | Evidence | Probable source | Owner |
|---|---|---|---|---|---|
| 1 | P1 | **Lighthouse Performance under target on the hub (77, target 90) and the watch page (72, target 75).** Almost all of TBT is one task after first paint: 624 ms on the hub, 814 ms on watch, attributed to the MoQ chunk. A 7 s CPU profile of the watch load (Chrome, after the run) puts about 470 ms in `@moq/net`'s announcement matching (`origin.announced` → path-pattern `overlaps`/`captures` over every announced broadcast), about 420 ms in the React render it triggers, and 104 ms in Ajv compiling validators on first use, all in the same window. The local 100 had no relay, so it never received the announcements. | `C/lighthouse/hub.html`, `C/lighthouse/watch.html`, `C/trace/watch-trace.json.gz` (load task 626 ms) | `web/src/pages/liveRooms.ts:19` (the hub watches all of `talk/`), `web/src/transport/moq.ts:57` (`Moq.Path.Pattern.subtree`), `web/src/contracts/validate.ts` (lazy compiles land together) | Player (infra for the relay's announcement fan-out) |
| 2 | P2 | **Subtitles sit on the camera tile.** In the picture-in-picture layout the bottom-centre subtitle box overlaps the camera tile and covers its Camera chip; in WebKit the tile hides the end of the line. Seen in every browser, original and Arabic. | `C/chromium/watch-subtitles-on-dark.png`, `C/chromium/watch-translation-arabicrecorded-dark.png`, `C/webkit/watch-translation-arabicrecorded-dark.png` | `web/src/player/SubtitleOverlay.tsx:12-15` (default bottom centre; the safe area ignores the small cell), `web/src/player/player.css:128` (`.tt-layout-pip .tt-cell-small`) | Player |
| 3 | P2 | **Best practices 81 on hub and watch (target 95 on the hub):** a deprecated `unload` listener, which also blocks the back/forward cache (remainder of 14). | `C/lighthouse/hub.html` (deprecations, bf-cache) | `@moq/net/connection/reload.js:167` (dependency; Lighthouse places it in the MoQ chunk) | Infra |
| 4 | P3 | "You missed 1:01 · 0 chapters": the count shows when no chapter falls in the gap. | `C/chromium/watch-subtitle-style-light.png` | `web/src/player/Stage.tsx:142` (confirmed) | Player |
| 5 | P3 | Stats for nerds lists about 40 "Translation (xx) off" rows, which bury the two or three tracks that run. | `C/chromium/watch-stats-dark.png` | `web/src/player/StatsForNerds.tsx:84` (every catalog track) | Player |
| 6 | P3 | The side-panel tab fade leaves stray fragments ("s", "apters", "D") at the strip's edges. | `C/chromium/demo-state-failed-dark.png`, `C/chromium/watch-stats-dark.png` | `web/src/player/player.css:1295-1303` (mask) | Player |
| 7 | P3 | Layers below show through empty states: a faint "Camera" chip and "Speaker audio, no picture yet" behind "No room called …"; the offline demo shows an empty camera tile, "No camera in this room", over the slide. | `C/chromium/unknown-not-started-dark.png`, `C/chromium/demo-back-live-dark.png` | `web/src/player/Stage.tsx` (cells render under the card) | Player |
| 8 | P3 | Firefox logs "fatal error running connection Error" when leaving the unknown room (a connection closed by navigation, logged as fatal). | `C/report.md` console errors (`firefox/unknown`) | `@moq/net` connection loop, via `web/src/transport/moq.ts` | Player |
| 9 | P3 | WebKit (Windows, not Safari, out of scope): besides 15, the hub's Live now still says "Checking what is on air…" after 12 s and the demo cards have no LIVE pill, though WebKit's watch page connects over WebSocket. | `C/webkit/hub-top-dark.png` | `web/src/pages/liveRooms.ts`, `web/src/pages/LandingPage.tsx:92` | Player |

Not covered by this run: the 20 min memory loop (60 s only), drawing latency on the console, a real camera and
microphone, a speaker on air, listener annotations and chat sends in a live room, time to first frame and INP (not
instrumented), mobile-throttled Lighthouse and the ended-room and talk pages (the harness runs the desktop preset on
hub, watch and demo), the Coverage and caching pass, keyboard-only and screen-reader runs, real Safari, phone (out of
scope). The console's mic meter is flat in both preflight-mic frames checked while it says "We hear you" (the fake
device beeps intermittently; check with a real mic).
