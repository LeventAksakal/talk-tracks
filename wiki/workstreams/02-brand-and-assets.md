# 02 · Brand and assets

**Status:** not started · **Session:** — · **Due:** palette and tokens Sun Nov 1, 13:00 +03; assets Sun 22:00 ·
**Feeds:** 03, 04, 07

## Goal

Give Talk Tracks a look of its own: palette, type, logo and every image asset the site, the browser and the
submission need. Decide fast, then hand 03 one tokens file it can build on.

## What exists

- Astryx (`@astryxdesign/core` 0.7.0) styles the standard controls. `web/src/app.css` maps our `--tt-*` variables onto
  Astryx tokens (`--color-*`, `--spacing-*`, `--radius-*`) with fallbacks. `player.css` (1,266 lines) and
  `console.css` hold most of the custom styling.
- One placeholder `web/public/favicon.svg` (navy square, three blue lines). No logo, no social card, no manifest, no
  touch icons. `index.html` has a title and description only.
- Direction in [ui-design.md §9](../product/ui-design.md#9-visual-language): calm graphite neutrals, light and dark
  from the system with a toggle, red only for LIVE and on-air, amber for degraded, every state also has a word,
  motion only for cause, WCAG 2.2 AA in both themes.

## Read first

- [product/ui-design.md](../product/ui-design.md) §9, and §3 for what sits on the canvas (subtitles, ink, laser must
  stay readable on any slide).
- [product/research-video-products.md](../product/research-video-products.md): what the field looks like.
- [product/design-brief.md](../product/design-brief.md) §6–§7: direction and constraints.
- The clickable mockups linked in `CLAUDE.md` (source in `scratch/player-mockups/`).
- Astryx docs for its theme tokens and how to override them (check the package's CSS variables first).

## Decisions to make

1. **Direction.** Keep the graphite + red-for-live direction, or pick a signature accent. Recommendation: graphite
   neutrals with **one** brand accent that is not red or amber (those mean live and degraded), so states stay
   unambiguous.
2. **Typeface.** System font stack (zero cost to LCP) or one self-hosted variable font (woff2, subset, preloaded).
   Recommendation: one variable font for the wordmark and headings only; system stack for body and the player.
3. **Logo idea.** Should "tracks" (parallel lanes, a multitrack) or "talk" (a speech bubble, a waveform) lead?
   Produce 3 concepts, pick 1.
4. **Ink palette.** The 6–8 drawing colours for pen, marker and shapes (04 needs this). They must read on white and
   dark slides and stay distinct for colour-blind viewers.
5. **Icons.** Astryx icons only, or add a set (for example Lucide, ISC licence) for player and canvas tools.

## Deliverables

| Asset | Spec | Where |
|---|---|---|
| Palette | light and dark, neutrals 50–950, accent, live red, degraded amber, success, focus; contrast ratios listed | `wiki/product/brand.md` |
| Tokens | CSS custom properties overriding Astryx tokens plus our `--tt-*`; one file | `web/src/theme/tokens.css` |
| Ink palette | 6–8 colours plus marker opacity, with names | `brand.md`, `tokens.css` |
| Type | family, weights, scale; font files if self-hosted | `brand.md`, `web/public/fonts/` |
| Logo | logomark + wordmark, light and dark, SVG | `web/public/brand/` |
| Favicons | `favicon.svg` (with dark-mode media query), `favicon.ico` 32 px, `apple-touch-icon.png` 180 px, `icon-192.png`, `icon-512.png`, maskable 512 | `web/public/` |
| Manifest | `site.webmanifest`, `theme-color` light and dark | `web/public/`, `index.html` |
| Social card | Open Graph and Twitter image 1200×630, plus `og:` and `twitter:` meta | `web/public/og.png`, `index.html` |
| Banner | submission cover image; check the hackathon page for the size (default 1920×1080 and 1280×640) | `web/public/brand/` |
| Video title and end cards | 1920×1080 | `web/public/brand/` |
| Empty and state illustrations | optional: "not started", "ended", "offline" | only if time |

## Constraints

- Every asset small: favicon SVG under 2 KB, social card under 300 KB, no web font over 60 KB per file.
- Every colour pair used for text passes AA (4.5:1 body, 3:1 large text and UI) in both themes.
- Generated imagery must be ours to license under Apache-2.0 or CC BY-SA; record the source of every asset in
  `brand.md`.
- No Meta logos or marks unless the hackathon rules allow it.

## Definition of done

- The owner has picked the direction, logo and palette.
- `tokens.css` is imported in `main.tsx`, and the site looks right in light and dark with no other code change.
- All favicons, the manifest and the social card are wired in `index.html`, and the social card shows in a preview
  (for example a link-preview debugger).

## Start prompt

> You are the Brand and assets session for Talk Tracks. Read `wiki/workstreams/02-brand-and-assets.md` and its Read
> first list. First show me 3 directions (palette + type + logo concept) side by side and ask me to pick. Then
> produce the tokens file, then the assets in the deliverables table. Log progress in the workstream file.

## Log

| When (+03) | Session | Entry |
|---|---|---|
| 10-31 12:57 | coordinator | Brief written. |
| 10-31 15:40 | coordinator | Owner (10-31): "The design tokens; assets are WIP, I'll define them along with design rules seperately then we'll transfrom the app once thery are set. so the app looks unique and our own." This workstream is now owned by the owner. Target: the app restyles by swapping token values, with no component rewrites. Status: waiting on the owner. Check: changing the token file alone changes the look of every screen. |
| 10-31 17:30 | design direction | Session started. Owner (10-31): "Look a textual interface is not the proper way of collaboration . We need a canvas where we can chuck up references like OBS, Google Meet, Microsoft Teams, Cpnstructor Groups, Zoom, Twicth, Kick, VLC, Youtube etc. The ideathe and melt into our own. We need to define what core user journeys and caapbilities are then build the compoenents the UIUX around that". Target: direction is agreed on a shared canvas, capability by capability, before any token values. Status: Reference Canvas published (CLAUDE.md § Artifacts): journeys → 10 capabilities, reference patterns per capability, a component inventory draft and a look row; waiting on the owner's screenshots and notes. Check: each capability row has the owner's references and a agreed 'ours'. |
| 10-31 18:30 | design direction | Owner (10-31): "Well arent you capable of curating images then producing a gray board or low fidelity concpet art for our own product? what you did with this canvas it just put noteblocks period." Then the vision: a hub like streaming services (large title "Talk Tracks (Name isnt final)", a live strip, resume, published replays); a Create room primary action top right opening a modal where a pasted mint enables Create ("its a closed demo"); the player's core is the content; no viewer cameras ("we are not doing video-con"), Twitch/YouTube Live with a global chat and comments on slides; "everything should be canfigurable and intentionally designed"; PiP, docking, pinning, resizing and keyboard shortcuts for power users (VS Code, Obsidian, Claude Code, browser, Excalidraw); colour, type and artwork (logo, custom assets or abstract images, maybe mascots). Target: greybox screens the owner reacts to on the canvas, then tokens. Status: shipped, not reviewed: six greybox boards on the Reference Canvas (hub; create-room modal with a working mint gate; player with chat and on-slide comment threads; six panel arrangements and presets; command palette and key map; three character directions A Lanes, B Chalk, C Signal), with Juxtopposed precedents noted beside them. Open: PiP was ruled out on 10-30 and is back in today's list; 'mint' vs decision 0025's access code. Check: the owner marks up each board and picks a character direction. |
| 10-31 19:30 | design direction | Owner (10-31): "I like the Chalk direction but colors; typography and mascot should be build properly. for mascot building I can hook up the mcp for the *forgot its name* platform thats famoust for mascots and web art." Canvas comments (10-31): hub "Header is redundat just remove. open with top center title as you scroll it forms in to the top nav bar"; player tabs "see how alignment is borken. major area to watch out for"; create room: language "could be redundant NO? doesnt meta auto-detect it?", Cancel redundant with × and click-outside, mint "could be after create room ... create room -> paste mint -> confirm". Target: Chalk palette, ink box and type agreed on the canvas, then token names. Status: shipped, not reviewed: hub without a header (title collapses into a bar on scroll; search and paste-a-link merged), create room in two sliding steps (details, then mint, then confirm; no Cancel; no language field, since the ASR handshake sends none), player tabs rebuilt; Chalk boards: palette Blackboard (dark) and Paper (light), every text pair AA, LIVE badge one fill; an eight-colour chalk box with a casing so it reads on any slide, marker, listener-mark and laser rules; three type pairings (recommended Fraunces + Atkinson Hyperlegible). Open: mascot platform name (not in the connector directory); type pick; tokens not written yet. Check: the owner picks a pairing and accepts or edits the palette on the canvas. |
| 10-31 20:15 | design direction | Owner (10-31): "Yes I meant rive but 3D web art could perhaps do too. well those fonts you listed I didnlt like them that much you naming them; I have to open the web view them speratly why not you brose curate them showcase them on the canvas?" and "You think we are ready in terms of functaionliy and all design aspectes covered*". Target: fonts picked by eye on the canvas; an honest coverage map. Status: shipped, not reviewed: Font lab board (13 display, 10 interface/caption, 5 mono Google Fonts rendered live; click to mix into a preview of title, caption and timecode); Coverage board answering 'not yet': drawn, partly, missing and owner-call items. Rive has no connector in the directory; the owner adds it. Missing, in order: tokens (fonts and palette first), speaker console greybox, player states, then icons, motion, spacing, logo assets. Check: the owner picks one display, one UI and one mono face in the font lab. |
| 10-31 21:30 | design direction | Owner (10-31): "use cabin skecth for the title fits the theme; atkinson hyperlegible is fine for nubmers and timecoes all of them are terrible. 0 should not have a dot or corss in it." Identity "an optional name modal taht pops up or gives you random names"; chat "should be a feature", moderation "maybe out of scope"; chat shape "its an architecture and design decision"; "everything is a track ... subscribe to chat (just open the drawer) unsubscribe (just close the drawer)"; slide pins "not always on ... people can turn them off dock them"; creators get "mints or JWT or one time tokens"; PiP "if its easy to implement and build then yes"; default layout from Juxtopposed; name: "haiku; sonnet agents can expand then anrrow down and present 5-10 top rankers". Target: tokens pushed for the App UI lane; brand rules written; name shortlist on the canvas. Status: shipped (f1ed519), not wired in: `web/src/theme/tokens.css` (Paper/Blackboard via light-dark(), ink box, Cabin Sketch + Atkinson Hyperlegible Next, space, radius, motion, Astryx bridge); `wiki/product/brand.md` (rules, contrast, old-to-new variable map); ticket 0021 (how chat is published). Atkinson Hyperlegible Next's zero checked by eye: plain oval. Default stage: slides fill, camera in a corner tile (vlc-19, vlc-31, youtube-48; no multi-source case in the catalog). Canvas: Font lab set to the picks, Names board (top 10 of 60), Coverage updated, decisions sticky. Check: owner confirms palette and ink values and picks a name; ticket 0021 answered; App UI lane imports tokens.css. |
| 10-31 22:00 | design direction | Owner (10-31): "lets retain talk tracks for now always can change it in the future: comments on replay could be a slick feature. if we can manage and build it in time fine. If you have t he complete design platter and deicisons record and report upstream so coordinator can incorparet it". Target: decisions recorded in the wiki and handed to the coordinator. Status: shipped: decision 0026 (the look is Chalk, and a panel is a track subscription), wiki/README index row, brand.md (name kept, replay comments a stretch goal), canvas Coverage and decisions sticky; handover note in the coordinator's shared notes folder. Not designed yet: speaker console, player states, stats overlay, icons, logo assets, mascot; palette and ink hexes not signed off. Check: coordinator merges `claude/magical-tesla-3deae6` and briefs the App UI lane from brand.md §8. |
| 10-31 23:00 | design direction | Owner (10-31): "yeah then goahead with all grayboxes". Target: every screen and state on the coverage map greyboxed in the Chalk look. Status: shipped, not reviewed: six boards on the Reference Canvas (round 4 row): speaker console get-ready (states: ready, mic blocked, no slides, link expired; Go on air disabled until must-haves pass), console on air (red on-air bar, ink tools P M S T L E and colours 1–8, next slide and private notes, questions and chat, track meters with an amber behind state, End talk confirm), nine player states (connecting to ended, behind live with "You missed"), tracks menu (language, style presets previewed on the slide, track states) with the first-visit sheet (random name plus tracks), side panel tabs with a subscription line plus stats for nerds, and edge cases (nothing live, no search results, code rejected, room ready, name dialog, not found, offline). Coverage map: all screens drawn. Checked: markup balanced, scripts run, no style holes; not viewed in a browser by the session. Check: the owner reviews the round 4 boards and comments. |
