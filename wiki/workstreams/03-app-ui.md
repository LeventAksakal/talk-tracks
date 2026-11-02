# 03 · App UI

> **Scope (owner, 2026-10-30):** desktop only, Chrome first. Phone, iPhone and Safari items in this file are out of scope.

**Status:** in progress · **Session:** App UI lane, branch `lane/app-ui` · **Due:** Mon Nov 2, 18:00 +03 · **Depends on:** 01 (journeys), 02
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
| 10-31 21:38 | coordinator | Owner (10-31): "Yes, merge and start". Lane started on `lane/app-ui`. Slices: 1 tokens and fonts, 2 no switches, no money, default stage, 3 hub and room states, 4 console popovers, 5 transcript download, 6 PiP (stretch). Out of scope until answered: chat (ticket 0021), stats track (0022), lecture package (0023). Target: each slice merged and deployed for the nightly QA build. Status: in progress. Check: owner QA on the VM, journeys J1–J8. |
| 10-31 22:10 | App UI lane | Slice 1, tokens and fonts: `tokens.css` and `fonts.css` imported after Astryx; Atkinson Hyperlegible Next 400/600/700 and a renamed Cabin Sketch Bold subset ("Talk Tracks Title", printable ASCII, 92 KB: over the 60 KB target) self-hosted in `web/public/fonts/` with their OFL texts, credited in the README; `--tt-*`, `--pl-*` and brand hex colours moved onto the tokens; ink colours in the console, listener tools, laser and offline demo read the chalk box (`theme/ink.ts`). The ink casing is not drawn yet (`canvas/ink.ts` is outside this lane). |
| 10-31 22:25 | App UI lane | Slice 2, no switches, no money, slides-first stage: the side panel and menus no longer have on/off rows; a subtitle language pick subscribes, Off unsubscribes, an open panel tab subscribes its track, and a dropped track lingers 30 s; switching language keeps the old line up until the new one lands. A "Sound" pick (speaker, or speaker and slide descriptions) and a "Slides" panel tab replace the descriptions switch. Every cost and spend figure is gone from the player, Stats for nerds, the console audience card, Create talk and `ui-design.md`; a capped track reads "unavailable right now". The default stage puts the slides full size with the camera in a corner tile you can drag, resize from its grip or swap (button or double click); no deck means the camera fills the stage; side by side and one at a time stay in Settings. Listener marks show only with the Discussion tab or your own tools open. Prefs moved to `tt.player.v2`, so saved player settings reset once. |
| 10-31 23:05 | App UI lane | Slice 3, hub and room states: `/` is the hub, with a sticky bar and a Create talk button, the title in the display face, Join by name or link (Ctrl K), "Live now" from relay announcements (demo rooms left out; says when nothing is on air or the relay is unreachable), "Continue watching" (kept in this browser), the four demo lectures marked LIVE · looped recording or Off air, and the existing access-code Create talk form. In the player every room state has a word and a card: Not started, LIVE (icon and word in live red, no dot), Paused, Talk ended (seen live here) or Recorded session (opened later), LIVE · looped recording (demo rooms), No room called X (nothing of the room on a connected relay for 6 s), and a "Room service unreachable" chip in the title bar. Cards for not started, ended, recorded and unknown link back to the hub. Not verified: the unknown-room timing against a freshly created room on the VM. |
| 10-31 23:35 | App UI lane | Slice 4, console polish: picking a tool opens its colour and width in a popover under the tool (a small chip beside the active tool reopens it); it closes when you press on the slide; the colour bar is gone. The console has Pause (withdraws the broadcast, so viewers see Paused; devices, slides and drawing stay) and Resume, with icons; End talk carries a stop icon and is the only solid red button. The on-air badge is the LIVE marker (icon and word in live red) with the time on air, "Paused · time" while paused. Problems in pre-flight, questions and the not-on-air banner are amber, not red; the current slide in the strip is the accent; radii on the tokens. Not verified in a browser: the popover and Pause with a real deck and camera (tests cover both). |
| 10-31 23:55 | App UI lane | Slice 5, transcript download: the Transcript tab has a Download button that opens a popover: pick the original, one translation or All languages, then Text (.txt), Subtitles (.vtt) or Markdown (.md). The whole talk so far is gathered from the tracks history without moving the playhead; the languages gathered are subscribed while the download runs (decision 0026) and let go after (30 s linger). Times are talk time; all-languages files put each translation with the line it translates (VTT uses `<lang>` spans). The lecture package (ticket 0023) has a marked spot beside these formats. Not verified on the VM: gathering a cold language there wakes its agent (lazy tracks), so All languages can take a while and spends on translation. |
| 11-01 00:05 | App UI lane | Slice 6 (picture-in-picture) not built: moving the live stage into a Document Picture-in-Picture window keeps the canvas but breaks React event handling inside it, and a portal would re-create the camera canvas, so it is not cheap. Dev server stopped. |
| 10-31 22:57 | coordinator | Slices 1–5 merged (500feb5) and deployed to the VM (bundle `index-BoZ-vYcX.js`); hub and `/watch/dataviz` checked in the browser. Gate: typecheck, lint, build pass; tests 188 passed, 1 flaky (the console's audience-questions test fails only under full-suite load, 8/8 alone twice). Open: ticket 0025 (four defaults); ink outline in `canvas/ink.ts` (slide tools); first-visit language toast; PiP not cheap (not built); the all-languages download wakes every language's agent. Status: shipped, owner QA pending. |
| 11-02 15:35 | Speaker and screen share lane | Step 1, screen share as a track (`lane/speaker-screen`): the console's Screen check has Share screen (getDisplayMedia, the console's own tab excluded) with a "With its sound" switch, and Stop sharing; the browser's own stop bar ends it too. While shared, the teacher broadcast carries a `screen` rendition (H.264, keyframe every 2 s, at most about 1080p) next to `audio` and `video`; stopping removes it from the hang catalog. A shared tab's sound is mixed into `audio` (Web Audio), so listeners, the archive and captions hear it. The speaker token needs nothing new: scopes name the broadcast (`talk/R/teacher`), not its tracks. The room service lists a `screen` source while the catalog names it; the archive keeps the screen as its own track and writes `screen.m3u8` (the camera's `video.m3u8` never picks the screen, even a bigger one). In the player a shared screen takes the slides' place (main stage; the slides' side or "one at a time" choice), the camera stays in the corner, and the corner's swap button swaps them; rewound, `screen.m3u8` plays on its own muted element following the camera's playhead wherever the archive holds a screen. Cross-lane touches: `archive/hls.py`, `archive/relay.py`, `room_catalog.py`, `contracts.py` (`SCREEN_TRACK`). Not verified in a browser: real getDisplayMedia, the tab-sound mix, the live and rewound screen on the VM (needs a person with a screen). |
| 11-02 16:05 | Speaker and screen share lane | Steps 2 and 3: the speaker link survives a reload. `/talk/<room>?token=…` keeps the token in this browser per room (`tt.speaker.token.<room>`), so reloading `/talk/<room>` without it opens the console as the speaker again; a kept token that expired or names another room is dropped. End talk now says "Ending…" until the room service acknowledges the `end` message: a lost socket, a silent service or a busy one (`rate`, `limit`) is tried again after 1 s, then 2, 4, 8 and every 10 s; a room that never went live (`not-live`) counts as ended; a refusal (`forbidden`: not the speaker's token) stops and offers Try again. The kept link is forgotten once the end is settled. Not verified on the VM: End talk with the room service restarted mid-way (tests cover the retries). |
