# 06 · QA and performance

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
