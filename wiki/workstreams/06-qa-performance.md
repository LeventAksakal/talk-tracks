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

Dropped after checking source: "You missed 1:00" still showing after Go live is intended (`DemoPage.test.tsx:42`); the
hub's "Checking what is on air…" never resolving happened only on the local preview, which has no relay.

Performance trace (B4, Chrome 156, `/watch/dataviz`): load 2.3 s with 4 long tasks (longest 721 ms, 1,162 ms in
total) and the main thread 64 % busy; 60 s of playback with subtitles 26 % busy, no long task, 50 frames drawn per
second; seek and Go live 25 % busy, one 100 ms task. JS heap after GC 15.1 → 16.5 MB over 60 s (1.4 MB/min; the 20 min
loop is still to measure), DOM nodes 394 → 454. Offline demo (L): playback 8 % busy, no long task, 0.9 MB/min.

Lighthouse desktop (B4): hub 62 / 100 / 81 / 91 (performance, accessibility, best practices, SEO), watch 39 / 94 / 81 /
92, demo 72 / 94 / 100 / 92. Local preview (L, uncompressed HTTP): hub 91 / 100 / 59 / 91, demo 80 / 94 / 78 / 92.
