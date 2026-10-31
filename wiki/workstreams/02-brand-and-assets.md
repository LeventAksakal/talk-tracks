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
