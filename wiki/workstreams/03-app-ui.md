# 03 · App UI

> **Scope (owner, 2026-10-30):** desktop only, Chrome first. Phone, iPhone and Safari items in this file are out of scope.

**Status:** not started · **Session:** — · **Due:** Mon Nov 2, 18:00 +03 · **Depends on:** 01 (journeys), 02
(tokens, logo), 05 (room-creation endpoint) · **Feeds:** 06, 07

## Goal

Turn the working parts into a finished product along the journeys of 01: a real lobby, create and join flows, every
room state, and a design pass over the player and the speaker console with the brand of 02.

## What exists (2026-10-31)

| Area | State | Files |
|---|---|---|
| Routing | Tiny router: `/`, `/watch/:room`, `/talk/:room`, `/demo`, `/demo/rewind` | `router.tsx`, `App.tsx` |
| Landing | **Smoke-test shell**: title, a room-name field, a link to the offline demo, a line telling speakers to open `/talk/<room>?token=…` | `pages/LandingPage.tsx` |
| Player | **Built, about 4.5k lines**: control bar, progress bar with chapters, CC menu with language and style, draggable subtitles, layouts, side panel, stats for nerds, shortcuts, slides/ink/marks/laser live and in rewind, room states | `player/` |
| Console | **Built, about 2.5k lines**: pre-flight, PDF deck, presenter view, pen, highlighter, text marks, laser, eraser, invite QR, audience counts, end talk | `speaker/`, `pages/TalkPage.tsx` |
| Old viewer | Earlier viewer panels, mostly replaced by the player | `viewer/` |
| Styling | Astryx components plus our CSS (`app.css`, `player.css`, `console.css`) | — |
| In flight | Audience annotations UI (`Annotate.tsx`, `Discussion.tsx`, `Questions.tsx`) on `lane/audience-annotations` | — |

Missing: a lobby with demo-room cards and live state, **create a room**, a join flow from QR, room metadata (title,
speaker) in the UI, an "ended" page with a replay link, brand, and phone polish.

## Read first

- `wiki/product/journeys.md` (from 01): the source of truth for what to build.
- `wiki/product/brand.md` and `web/src/theme/tokens.css` (from 02).
- [product/ui-design.md](../product/ui-design.md): §3–§8 for the player, console and lobby.
- [decisions 0017](../decisions/0017-viewer-is-a-media-player-and-every-interaction-is-a-track.md),
  [0020](../decisions/0020-player-overlays-are-dom-and-a-main-thread-ink-canvas-on-the-frame-clock.md),
  [0023](../decisions/0023-the-console-renders-pdf-decks-in-the-browser-with-pdfjs.md).
- [howto/web.md](../howto/web.md) and [howto/run-locally.md](../howto/run-locally.md).

## Scope

1. **App shell:** header with the logo, theme toggle, skip link, footer with credits and licence; 404 and error pages.
2. **Lobby (J2, J8):** a one-line pitch, demo rooms as cards (title, speaker, live state, credit), join by name or
   link, "Continue <last room>", "Create a room", a short "How it works".
3. **Create a room (J5):** the form agreed in 01 (decision 1) → speaker link and audience link/QR → into pre-flight.
   Falls back to "Paste your speaker link" if 05's endpoint is cut.
4. **Join (J1):** QR or link opens the room directly; "Not started", "Live", "Ended" handled; first-tap audio unlock;
   ask for a display name only when needed.
5. **Player design pass:** apply tokens; tidy the control bar, menus and side panel; check every state in
   ui-design §5; phone portrait and landscape (§6).
6. **Console design pass:** apply tokens; pre-flight as a clear checklist; on-air bar; invite full screen for a
   projector; end-talk confirm and the "ended" summary.
7. **Remove or hide leftovers** that are no longer on any journey (old `viewer/` screens, debug pages) so QA and
   Lighthouse measure only the product.

Out of scope: drawing tools and the slide canvas (04), backend endpoints (05).

## Notes for performance (06 will measure these)

- Lazy-load the console, PDF.js and the player per route; the lobby must not download them.
- Reserve space for images and the player box (no layout shift); preload the logo font if one is used.
- The lobby's largest element should be text or a small image, so LCP stays under 2.5 s on a phone.

## Definition of done

- J1–J8 can be walked end to end on the local stack and on the VM, as written in journeys.md.
- Light and dark both pass a visual check; phone portrait works for J1 and J3.
- Web checks pass (`typecheck`, `lint`, `test`, `build`); merged to `main` by the coordinator.

## Start prompt

> You are the App UI session for Talk Tracks. Read `wiki/workstreams/03-app-ui.md`, then journeys.md and brand.md.
> Work on branch `ws/app-ui` in your own worktree. Start with the shell and lobby, then create/join, then the player
> and console design passes. Show me screenshots at each step. Log progress in the workstream file.

## Log

| When (+03) | Session | Entry |
|---|---|---|
| 10-31 12:57 | coordinator | Brief written. |
