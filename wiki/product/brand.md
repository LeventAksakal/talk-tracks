# Brand and design rules: Chalk (2026-10-31)

**Status:** direction chosen, palette signed off, ink values not yet confirmed · **Owner:** the owner (workstream 02) ·
**Tokens:** [`web/src/theme/tokens.css`](../../web/src/theme/tokens.css) · **Working board:** the Reference Canvas
(link in `CLAUDE.md` § Artifacts).

The app looks like a lecture where the speaker draws: a blackboard, chalk-white text, blue chalk for the one accent,
a hand-drawn chalk title. It stays a grounded media player ("we aren't selling candy"); Chalk is the voice of the
frame, never decoration on the content.

## 1. Decisions so far

| Topic | Decision | Source |
|---|---|---|
| Direction | **Chalk**, picked from three (Lanes, Chalk, Signal) | owner, 10-31: "I like the Chalk direction" |
| Title type | **Cabin Sketch** 700 for the wordmark and page titles | owner, 10-31: "use cabin skecth for the title fits the theme" |
| Interface, captions, numbers | **Atkinson Hyperlegible Next**, tabular figures for times and counts; its zero is a plain narrow oval | owner, 10-31: "atkinson hyperlegible is fine for nubmers and timecoes ... 0 should not have a dot or corss in it" |
| Monospace | none; every mono face tried was rejected | same |
| Palette | Blackboard (dark) and Paper (light), below | owner, 10-31: "Palette seems OK to me" |
| Ink | the eight-colour chalk box with a casing | drafted, not yet confirmed |
| Player theme | always dark; hub and console follow the system, with a toggle | ui-design §9 |
| Mascot | **Chalky v2**, a stick of chalk rigged like a 3D character: bones with pivots, 11 faces, 11 cycles, a turnaround from front to back; built in Rive on the same rig | owner, 10-31: "Yes I meant rive"; "think of a 3d modeller; the skeleton and rigging of each of its components" |
| LIVE marker | the **Go-live icon with the word LIVE, in live red**; no red dot | owner, 10-31: "use this instead of the red dot use it with "LIVE" and make it red too" |
| Money | **never shown** to a listener or speaker; a capped track reads "unavailable right now" | owner, 10-31: "No app displays such stuff. we are building the app for actual users" |
| Name | keep **Talk Tracks** for now; finalists in §7 | owner, 10-31: "lets retain talk tracks for now always can change it in the future" |
| Record | [decision 0026](../decisions/0026-the-look-is-chalk-and-a-panel-is-a-track-subscription.md) | |

## 2. Colour

Roles, not hues: components use the token names. Ratios are text on Ground; every text pair also passes on Surface
and Raised.

| Token | Paper (light) | Blackboard (dark) | Use | Text ratio (L / D) |
|---|---|---|---|---|
| `--tt-color-ground` | `#f5f2ea` | `#1b2420` | page and player ground | — |
| `--tt-color-surface` | `#fffdf8` | `#222d28` | panels, cards | — |
| `--tt-color-raised` | `#ece7db` | `#2a3631` | menus, hover, selected row | — |
| `--tt-color-line` | `#dcd5c5` | `#3a4842` | dividers (decorative) | — |
| `--tt-color-field` | `#8a8272` | `#6d7d76` | input and switch edges | 3.4 / 3.7 |
| `--tt-color-text` | `#1b2420` | `#f1ede2` | text | 14.2 / 13.6 |
| `--tt-color-text-muted` | `#5b645e` | `#aab5ae` | secondary text | 5.5 / 7.5 |
| `--tt-color-accent` | `#2d5f8b` | `#9cc7ea` | primary action, selection, focus | 6.0 / 8.9 |
| `--tt-color-live` | `#b42f27` | `#ff6a5c` | LIVE marker (icon and word), live edge, on air: only these | 5.6 / 5.7 |
| `--tt-color-live-fill` | `#c8352b` | `#c8352b` | LIVE badge fill, white text 5.3 | — |
| `--tt-color-degraded` | `#8c5200` | `#f4b544` | behind, stale, capped, failed | 5.7 / 8.7 |
| `--tt-color-ready` | `#226b3c` | `#86d39b` | connected, mic ok, saved | 5.8 / 8.9 |

Rules:

- One accent. Red means live or on air and nothing else; amber means degraded. Every state also says a word.
- A faint grain on Blackboard surfaces is allowed (SVG noise, under 8 % opacity); never a photo texture.
- Errors use the degraded colour plus a word ("Failed", "Can't reach the room"); there is no separate error red.

## 3. Ink: the chalk box

| Name | Token | Hex | Key |
|---|---|---|---|
| Chalk | `--tt-ink-chalk` | `#f7f4ea` | 1 |
| Sun | `--tt-ink-sun` | `#ffd84a` | 2 |
| Mint | `--tt-ink-mint` | `#5fd68a` | 3 |
| Apricot | `--tt-ink-apricot` | `#ff9a3c` | 4 |
| Sky | `--tt-ink-sky` | `#5fb3ff` | 5 |
| Rose | `--tt-ink-rose` | `#ff6fae` | 6 |
| Coral | `--tt-ink-coral` | `#ff5f57` | 7 |
| Lilac | `--tt-ink-lilac` | `#b79cff` | 8 |

- **Speaker ink:** solid, with a `--tt-ink-casing` outline (2 px, 70 %) under every stroke, so Chalk and Sun read on
  a white slide and every colour reads on a dark or busy one. The colours step in lightness, not only hue.
- **Marker:** any chalk at 35 %, no casing, drawn under the slide's text.
- **Listener marks:** a thinner pencil line in the author's own tint, always with a name tag, so it can never pass
  for the speaker's ink. Off unless the listener opens slide comments (§6).
- **Laser:** `--tt-laser`, a dot with a fading trail; the only bright red on a slide.

## 4. Type

| Token | Size | Face | Use |
|---|---|---|---|
| `--tt-text-display` | 72 px (hub title up to 120 px) | Cabin Sketch 700 | wordmark, hub title |
| `--tt-text-h1` | 40 px | Cabin Sketch | page and dialog titles |
| `--tt-text-h2` | 28 px | Cabin Sketch | section titles (Live now, Replays) |
| `--tt-caption-size` | 26 px default, listener-adjustable | Atkinson Hyperlegible Next | subtitles on the stage |
| `--tt-text-h3` | 18 px | Atkinson 600 | card titles, chapter names |
| `--tt-text-body` | 15 px | Atkinson 400 | body, panel text |
| `--tt-text-small` | 13 px | Atkinson | metadata |
| `--tt-text-micro` | 12 px | Atkinson | badges, keys |

- Cabin Sketch only at 28 px and up, never for body text, buttons or captions.
- Times, offsets, counts and money use `font-variant-numeric: var(--tt-numeric)` so they don't jitter.
- Fonts are self-hosted as subset woff2 in `web/public/fonts/` (under 60 KB a file), preloaded for the title face.
  Both are under the SIL Open Font License.

## 5. Space, shape, motion

- Space in 4 px steps (`--tt-space-*`). Radius: 6 small parts, 10 controls, 14 cards and dialogs, full for pills.
- Three shadows, used for layers only: menus (1), floating panels and the mini player (2), dialogs (3).
- Motion only for a cause: controls fading, a panel sliding, the playhead gliding to live, the create-room steps
  sliding. 120 / 240 / 400 ms, one standard curve; zero under reduced motion.

## 6. Product rules that shape the design (owner, 2026-10-31)

- **Everything is a track, and a panel is a subscription.** Opening the chat drawer subscribes to chat; closing it
  unsubscribes. The slide-comments layer is subscribed only while it is shown. Panels need "starting from now" and
  "loading history" states.
- **No switches.** Tracks follow what the listener opens or picks: a language pick subscribes, Off unsubscribes, a
  panel subscribes while open. No toggle rows, no first-visit sheet of switches ("turning stuff on/off is a shit UI";
  "tracks sub/unsub should be smooth natural operations"). Switching must feel instant: warm only tracks that are
  already running (the room's stats track says which), subscribe from the latest group and draw only the newest cue,
  keep the old line up until the new one lands, and linger 30 s after Off so a quick change back is free.
- **No money in the product.** Cost (agent workers calling the Meta API, relay compute) is the operator's concern.
  Machinery, subscriber counts included, lives only in Stats for nerds, which lists every track in the room's
  namespace from a stats track the room service publishes (MoQT itself reports no subscriber counts).
- **Tool options are popovers.** Ink colours and widths open from the active tool and close when you draw; no
  dedicated colour bar. Pause and End talk carry icons; End talk is the only solid red button.
- **Downloads:** the side panel offers the transcript (.txt, .vtt, .md, one language or all) and a **lecture
  package** (.zip: manifest, transcripts, chapters, slides with ink, glossary, the listener's notes) meant to be
  handed to an AI assistant. The package format is still to be defined.
- **Slide comments are supplementary:** off by default, can be shown, hidden or docked; not always on the slide.
- **Comments on a replay:** a stretch goal ("could be a slick feature"), built only if time allows.
- **Chat:** a feature. No accounts in the demo (a real deployment would use the organisation's SAML or SSO). A listener
  gets a random name they can change in an optional name dialog, as in Gartic Phone. Moderation (removing messages)
  is out of scope: on an append-only track it means rewriting the past. How chat is published (one track from a chat
  service, or a track per person) is an architecture decision: ticket 0021.
- **Room creation:** gated by a mint, a one-time token or JWT from the organiser (decision 0025's access code).
- **Picture-in-picture:** yes, if it is cheap to build (Chrome's Document Picture-in-Picture).
- **Default stage layout:** slides fill the stage and the camera sits in a small corner tile the listener can drag,
  resize or swap; with no deck, the camera fills the stage. Split side-by-side is an option, not the default. The
  Juxtopposed catalogue has no case for multi-source layouts; the reasons come from neighbouring cases: keep the main
  content visible and secondary views beside or over it, not instead of it (vlc-19, vlc-31), and don't let a
  secondary view take half the page (youtube-48).

## 7. Name: Talk Tracks for now

Kept on 2026-10-31; it can change later. The shortlist stays on the canvas's Names board. Brainstormed by a fast model (60 names), narrowed by a second with web checks for clashing products. Top finalists:
Chalktrack, Chalkcast, Talk Tracks (baseline), Lectrack, Stemcast. Dropped for clashes: Lectio (a Danish school
platform), Overdub (Descript), Earshot (a captioning app), Glossa (a subtitle add-on), Kreda (a bank). Trademark
and domain checks are needed only if the name changes.

## 8. For the App UI lane (workstream 03)

Wire `tokens.css` into `main.tsx` after the Astryx stylesheets, then move our own variables onto the tokens:

| Today | Token |
|---|---|
| `--tt-body` | `--tt-color-ground` |
| `--tt-surface` | `--tt-color-surface` |
| `--tt-border` | `--tt-color-line` (input edges: `--tt-color-field`) |
| `--tt-text`, `--tt-muted` | `--tt-color-text`, `--tt-color-text-muted` |
| `--tt-focus` | `--tt-color-focus` |
| `--tt-onair` | `--tt-color-live` (badge fill `--tt-color-live-fill`) |
| `--tt-wait` | `--tt-color-degraded` |
| `--tt-ok` | `--tt-color-ready` |
| `--tt-gap`, `--tt-radius` | `--tt-space-4`, `--tt-radius-lg` |
| `--pl-bg`, `--pl-chrome`, `--pl-raised`, `--pl-line` | ground, surface, raised, line under `color-scheme: dark` |
| `--pl-fg`, `--pl-muted`, `--pl-accent` | text, text-muted, accent |
| `--pl-live`, `--pl-warn` | live, degraded |
| ink colours in `Console.tsx`, `listening.ts`, `demoSlides.ts` | `--tt-ink-*` |

The player keeps `color-scheme: dark`; `light-dark()` then picks the Blackboard values with no other change.

## 9. Sources

- Fonts: Cabin Sketch and Atkinson Hyperlegible Next from Google Fonts, SIL Open Font License 1.1.
- Precedents: Juxtopposed's design catalogue (mc-04, twitter-05 for drawing the look from the product; vlc-19,
  vlc-31, youtube-48 for the stage layout). Credit the videos when showing case material.
- All colours, sketches and boards were made in this session; no third-party imagery.
