---
status: accepted
date: 2026-10-30
decision-makers: coordinator, project owner
---

# Player overlays are DOM plus one main-thread ink canvas per slide, on the room time of the frame on screen

## Context and Problem Statement

[Decision 0017](0017-viewer-is-a-media-player-and-every-interaction-is-a-track.md) puts subtitles, ink, the laser
pointer (and later comment highlights) in **one overlay layer above both renderers**: the live `<canvas>` that
`@moq/watch` paints, and the archive `<video>` that HLS plays. The layer must follow the **room time of the frame on
screen** and place everything in **fractions of the slide or canvas** ([ui-design §3.3–§3.4](../product/ui-design.md)).
The owner's rule is to read the platform docs first ([ui-design §11](../product/ui-design.md#11-before-code-platform-research)).
This draft records what the docs and the `@moq/watch` 0.6.6 source say, and the approach for the Player lane's step 2–3.

### What the live renderer actually does (`web/node_modules/@moq/watch/player-B6mw85kT.js`)

* It paints on the **main thread** with a **2D context**: `canvas.getContext("2d")` (line 1936), then in a
  `requestAnimationFrame` callback `fillRect` black and `drawImage(frame, 0, 0, canvas.width, canvas.height)`
  (lines 1978–1995). The backing size is set to the decoded display size (lines 1940–1943), so the canvas's natural
  size is the video's.
* In the same rAF callback it sets `renderer.out.timestamp` to the painted `VideoFrame.timestamp` in ms (line 1980).
  `VideoFrame.timestamp` is in microseconds ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame/timestamp)),
  and here it is the publisher's PTS (µs of `performance.now()`, [roomClock.ts](../../web/src/playback/roomClock.ts)).
* The decoder holds each frame until `sync.wait(timestamp)` (line 1757), and `Sync.now()` is
  `performance.now() − reference − delay` (lines 1280–1282): **the PTS that should be playing now**, shared by audio
  and video (`player.d.ts`: "Shared audio, video, and caption clock"). Its own caption renderer schedules cues on
  `sync.now()` every animation frame (line 1408).
* It clears the whole canvas every frame, so nothing of ours can be drawn into it, and because it already holds a
  2D context the canvas can never be transferred: `transferControlToOffscreen()` throws `InvalidStateError` once a
  context mode is set ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/transferControlToOffscreen)).

## Considered Options

1. **DOM/CSS for everything** (subtitles as text, ink as SVG paths, laser as an element).
2. **DOM for text and the laser, one main-thread 2D `<canvas>` for ink per slide tile.**
3. **OffscreenCanvas in a worker** for ink, laser and subtitles (`transferControlToOffscreen` + worker rAF).
4. **Native text tracks** (`TextTrack`/`VTTCue`, styled with `::cue`) for subtitles.

| Option | Good | Bad |
|---|---|---|
| 1. All DOM/SVG | text, RTL, `lang`, selection and screen readers for free; no pixel sizing | one SVG path node per stroke; a long annotated slide is hundreds of nodes and style recalcs per point |
| **2. DOM + ink canvas** | text stays DOM (all of the above); ink is a bitmap that redraws only on change; laser is a CSS `transform` (compositor, no repaint); same thread as both clocks | ink drawing shares the main thread with `@moq/watch`'s paint and React; needs device-pixel sizing |
| 3. Worker OffscreenCanvas | drawing off the main thread ([MDN OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas)) | see below: not frame-locked to the video, clock and events must be posted in, frozen placeholder size, more build surface, and the main cost (the video paint) cannot move |
| 4. `TextTrack`/`::cue` | browser-rendered captions | renders only for a media element's own tracks ([WebVTT API](https://developer.mozilla.org/en-US/docs/Web/API/WebVTT_API)); live video is a canvas, so nothing shows; `::cue` allows a fixed property list ([MDN ::cue](https://developer.mozilla.org/en-US/docs/Web/CSS/::cue)); no dragging |

Why not option 3, from the docs:

* The placeholder `<canvas>` gets the worker's bitmap "as part of the OffscreenCanvas's relevant agent's event loop's
  update the rendering steps" ([HTML spec](https://html.spec.whatwg.org/multipage/canvas.html#the-offscreencanvas-interface)):
  the worker's frame, not the main thread's, so ink cannot be locked to the frame `@moq/watch` painted in the main
  thread's rAF.
* Both clocks live on the main thread (`sync.now()`, `requestVideoFrameCallback`), so the worker would need the time
  posted every frame or written into a `SharedArrayBuffer` (needs cross-origin isolation,
  [MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)), plus every
  event, resize and layout change.
* After transfer the placeholder's `width`/`height` "throw an InvalidStateError" (HTML spec), so every resize is a
  message.
* The work is small: ink points and laser samples arrive at about 20/s, subtitles change a few times a second. MDN's
  canvas advice for this shape of scene is layered canvases, CSS for what is static, and redrawing only differences
  ([Optimizing canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas)), all
  available on the main thread.
* Support is fine (OffscreenCanvas 2D: Chrome 69, Firefox 105, Safari/iOS 16.4; worker `requestAnimationFrame`:
  Firefox 99, Safari 16.4, per [MDN compat data](https://github.com/mdn/browser-compat-data)), so this is kept as an
  escape hatch, not ruled out: the ink drawer is a pure function of `(context, strokes, t, size)` that accepts an
  `OffscreenCanvasRenderingContext2D` too, and can move into a worker if profiling shows main-thread jank.

## Decision Outcome

Chosen: **option 2**.

* **Source tiles.** Each source (camera, slides) is a box whose CSS `aspect-ratio` is the source's (canvas natural
  size, `videoWidth/videoHeight`, or the slide image's), centred in its layout cell. The renderer fills the box; the
  source's overlays are `position: absolute; inset: 0` children of the same box. A fraction `(x, y)` from a track is
  then simply `left: x·100 %; top: y·100 %`, in every layout and at every size, with no letterbox maths. (A canvas
  that shows content is a replaced element in the [HTML rendering rules](https://html.spec.whatwg.org/multipage/rendering.html#embedded-content-rendering-rules),
  so `object-fit` would also work, but the aspect box keeps overlay and picture in one rectangle by construction.)
* **Subtitles: DOM.** A draggable block with `lang` and `dir` per line (RTL in its own block, `web/src/viewer/lang.ts`
  `dirOf`), style presets as CSS custom properties, interim words lighter. Dragging uses Pointer Events with
  `setPointerCapture`, `touch-action: none` on the handle so a touch drag is not taken as a pan, and ends on
  `pointerup`, `pointercancel` or `lostpointercapture` ([setPointerCapture](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture),
  [Pointer events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events)). Position is stored as fractions
  of the tile, clamped to a safe area, remembered per device.
* **Laser: DOM.** One element per slide tile moved with `transform: translate(…)`, so no canvas repaint.
* **Ink: one 2D `<canvas>` per slide tile** (`{ alpha: true }`; it is transparent over the slide). Backing store in
  device pixels from `ResizeObserver` with `box: "device-pixel-content-box"` where supported (Chrome 84, Firefox
  108; **not Safari**), else `contentBoxSize × devicePixelRatio`; a `matchMedia("(resolution: Ndppx)")` listener
  catches zoom and display moves ([devicePixelContentBoxSize](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserverEntry/devicePixelContentBoxSize),
  [devicePixelRatio](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio)). Finished strokes are
  cached (a `Path2D` per stroke); a frame redraws only when the set of points visible at `t` changed, and a seek
  redraws from the slice's carry-in.
* **One frame loop.** A single main-thread `requestAnimationFrame` loop (`frameClock.ts`) runs while media plays and
  the tab is visible (rAF pauses in background tabs, [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)),
  reads the room time **once** per frame, and calls the overlay drawers imperatively through refs. React state
  changes only when something discrete changes (cue, slide, chapter), never 60 times a second.

### How overlays get the room time of the frame on screen

Room time = wall time − E (+ the broadcast's `tt.shift`), as everywhere ([roomClock.ts](../../web/src/playback/roomClock.ts)).

| Renderer | Frame time | To wall time | Evidence |
|---|---|---|---|
| **Live canvas** (`@moq/watch`) | `player.renderer.out.timestamp.peek()` (PTS ms of the frame painted) when there is video; else `player.sync.now()` (the same clock, continuous, also for audio-only rooms) | hang catalog root `clock`: `wallClockMs(clock, pts)` | `player-B6mw85kT.js` 1978–1980, 1280–1282, 1757; `media.ts` already maps `sync.now()` this way in a 100 ms poll (`#startLive`) |
| **Archive `<video>`** (hls.js or native HLS, or the looped recording) | `requestVideoFrameCallback` `metadata.mediaTime`: "the media presentation timestamp of the presented frame … on the `HTMLMediaElement.currentTime` timeline" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)); re-registered each frame. Paused, seeking or audio-only (no frames composited): `currentTime` read in the rAF loop and on `seeked` | PROGRAM-DATE-TIME offset the archive already uses: `wall = position() − currentTime·1000 + mediaTime·1000` (the shift `mapBuffered` computes, `hlsArchive.ts` 265–268) | rVFC: Chrome 83, Firefox 132, Safari/iOS 15.4 (MDN compat data) |
| **No media** (`ClockMedia`) | `position()` | already room time | `media.ts` `ClockMedia` |

`currentTime` alone is only "an approximation" and can repeat between reads
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime)), and `timeupdate` fires at
4–66 Hz ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/timeupdate_event)), which is why the
archive path prefers `mediaTime`.

**Engine change needed (through the coordinator; `web/src/playback/` is the Rewind lane's):** `SpeakerMedia` gains
`frameTime(): number | undefined`, the room ms of the frame on screen, cheap enough to call every animation frame:
live from the `Watch.Player` it already holds, archive from the last rVFC `mediaTime` through the PDT offset,
`ClockMedia` from `position()`. Everything else the player needs (`position`, `liveEdge`, `available`, `seek`,
`goLive`, `onChange`) is already public.

### Component structure (`web/src/player/`, matching the mockup)

| Module | Owns |
|---|---|
| `Player.tsx` | root: the `Playback` view, preferences, player state of §5, keyboard shortcuts of §4.10, fullscreen element, control auto-hide |
| `TitleBar.tsx` | talk title, speaker, credit; returns with the controls in fullscreen |
| `Stage.tsx` | the canvas area: layout (single, split with a draggable divider, picture-in-picture with a draggable window, swap), state cards, "What you missed", Stats for nerds |
| `SourceTile.tsx` | one source's aspect-ratio box and its overlay layer |
| `CameraSurface.tsx` | the live `<canvas>` and the archive `<video>` handed to `RoomMedia.attach`, one visible per mode |
| `SlideSurface.tsx` | the slide image on screen at `t` (deck + slide tracks; step 3) |
| `InkLayer.tsx` + `drawInk.ts` | the ink canvas; pure drawer reusable in a worker (step 3) |
| `LaserPointer.tsx` | the laser element (step 3) |
| `SubtitleOverlay.tsx` | draggable subtitles: original, translation, dual, RTL, interim words, style |
| `ProgressBar.tsx` | chapter segments, played/buffered/available, gaps, slide-change and bookmark marks, search matches, scrub |
| `SeekPreview.tsx` | hover/scrub tooltip: time, chapter name, slide thumbnail |
| `ControlBar.tsx` | play/pause, volume, time and the LIVE / `−04:30` pill (Go live), current chapter, CC, layout, panel, settings, fullscreen |
| `CaptionsMenu.tsx` | Off, Original, "Translate to…" search over `Intl.DisplayNames` autonyms and viewer-language names, dual subtitles, Style submenu (presets, size and background sliders, reset position) |
| `LayoutMenu.tsx`, `SettingsMenu.tsx` | layout choice and swap; subtitle style, audio description, quality, theme, shortcuts, Stats for nerds |
| `SidePanel.tsx` | tabs Transcript (follows live, Jump to latest, search), Chapters (So far on top), Glossary, Notes; Discussion slot for the Comments lane |
| `StatsForNerds.tsx` | per-track producing/idle, subscribers, delay, FETCH origin vs cache, back-fills, spend; connection |
| `frameClock.ts` | the one rAF loop and `frameTime()` subscription |
| `useTileSize.ts` | ResizeObserver + device-pixel ratio for overlay canvases |
| `prefs.ts` | per-device preferences (layout, subtitle style and position, language), `localStorage` in try/catch |
| `languages.ts` | language list and names: `new Intl.DisplayNames([tag], { type: "language", fallback: "none" })` for the autonym ([MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DisplayNames/DisplayNames)), reusing `web/src/viewer/lang.ts` |

### Scope: desktop browsers (owner, 2026-10-30)

"Build for the desktop; phones are pretty limiting and this is a hackathon product so allow ourselves some slack",
and "maybe dont bother support every bit of platform". So the player targets **desktop browsers only, Chrome
first**; Firefox is best effort and Safari is not a target. Out of scope: the phone layout of
[ui-design §6](../product/ui-design.md#6-phone), the iPhone fill-the-viewport fullscreen, Document Picture-in-Picture
and the video Picture-in-Picture API. The in-page picture-in-picture *layout* (camera over slides) stays. The
Safari and iPhone notes below are kept as research, not as work to do.

### Platform notes for step 2 (read, not yet decisions)

* **Fullscreen:** `requestFullscreen()` on the player root takes overlays and side panel with it
  ([Fullscreen API](https://developer.mozilla.org/en-US/docs/Web/API/Fullscreen_API)). **iPhone has no element
  fullscreen** (MDN compat: "Only available on iPad, not on iPhone"); the phone gets a CSS fill-the-viewport mode
  instead.
* **Picture-in-picture:** the video PiP API is `<video>`-only and shows no page overlays
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Picture-in-Picture_API)), so it cannot show the live canvas
  with subtitles. Document Picture-in-Picture can hold the whole player but is Chromium (116) and Firefox (151) only,
  not Safari ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Document_Picture-in-Picture_API)): offered where
  present, hidden elsewhere.
* **Media Session:** title, speaker and play/pause/seek handlers ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API));
  live audio is Web Audio, not a media element, so whether the OS shows controls for it is unverified.

### Consequences

* Good, because text stays accessible (screen readers, selection, `lang`/`dir`, RTL shaping) and styleable with CSS,
  which the CC style menu and the live preview need.
* Good, because overlays read the same clock the picture and sound are on, live and in the archive, so ink lands on
  the frame it was drawn on.
* Good, because a worker can still be added for ink without changing the tracks or the components.
* Bad, because overlay drawing shares the main thread with `@moq/watch`'s paint; mitigated by redrawing only on
  change and keeping React out of the frame loop.
* Bad, because the engine needs a `frameTime()` addition owned by another lane.

### Confirmation

Step 2 smoke tests: subtitles drag and keep their fractional position through resize and layout changes; overlay
frame time and `position()` agree within one frame live and in rewind; one screenshot per player state.
