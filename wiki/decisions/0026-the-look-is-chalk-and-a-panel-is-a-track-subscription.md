---
status: accepted
date: 2026-10-31
decision-makers: project owner, design direction session (workstream 02)
refines: 0017 (every interaction is a track), 0021 (deck annotations are shared state), 0025 (room creation by access code)
---

# The look is Chalk, and a panel is a track subscription

## Context and Problem Statement

Workstream 02 had to give Talk Tracks a visual direction and token names the App UI lane can build on, and the
owner's design rounds on the Reference Canvas (link in `CLAUDE.md` § Artifacts) settled several product rules on the
way. This record collects what was agreed on 2026-10-31 so lanes build on it without re-asking.

## Considered Options

* **Look:** A. Lanes (tracks as coloured lanes), B. Chalk (blackboard, chalk ink, hand-drawn title), C. Signal
  (broadcast equipment).
* **Type:** thirteen display, ten interface and five monospace Google Fonts, rendered side by side in the font lab.
* **Stage layout:** split side by side, camera in a corner tile, or automatic.

## Decision Outcome

**Look and type**

* **Chalk** (option B). Blackboard in dark, Paper in light; one blue-chalk accent; red only for live and on air,
  amber only for degraded, each with a word. Values in [`web/src/theme/tokens.css`](../../web/src/theme/tokens.css),
  rules in [product/brand.md](../product/brand.md). Palette and ink values are drafted and AA-checked; the owner has
  not signed off the exact hexes.
* **Cabin Sketch** for the wordmark and titles (28 px and up only). **Atkinson Hyperlegible Next** for interface,
  captions, times and numbers, with tabular figures; its zero is a plain oval. No monospace face (owner: "0 should
  not have a dot or cross in it").
* **Name:** keep "Talk Tracks" for now; it can change later. The ten finalists stay on the canvas.

**Product rules**

* **A panel is a subscription.** Opening the chat drawer subscribes to the chat track and closing it unsubscribes;
  the slide-comments layer is subscribed only while shown.
* **Slide comments are supplementary:** off by default; listeners can show, hide or dock them.
* **Comments on a replay:** wanted ("could be a slick feature"); a stretch goal, built only if time allows.
* **Chat** is a feature. No accounts in the demo: a random display name, changeable in an optional name dialog. A real
  deployment would use the organisation's SAML or SSO. Moderation (removing messages) is out of scope. How chat is
  published is open in ticket 0021.
* **Room creators** get a mint, a one-time token or a JWT from the organiser; this is decision 0025's access code.
* **Picture-in-picture:** in scope if cheap to build (Chrome's Document Picture-in-Picture). This reverses the 10-30
  "no PiP" scope note.
* **Default stage:** slides fill the stage and the camera sits in a small corner tile the listener can drag, resize
  or swap; with no deck, the camera fills it; side by side is an option.

### Consequences

* Good: a restyle is a change of token values; lanes have one place for colours, type and motion.
* Good: subscription follows what is on screen, so a closed panel costs no bandwidth.
* Bad: each panel needs "starting from now" and "loading history" states, and the App UI lane must move today's
  `--tt-*` and `--pl-*` variables onto the new tokens (map in brand.md §8).
* Bad: Cabin Sketch and Atkinson must be self-hosted as subsets in `web/public/fonts/`, which is not done yet.

## More Information

Precedents from Juxtopposed's design catalogue: mc-04 and twitter-05 (a look drawn from what the product is), steam-37,
vlc-36 and steam-12 (hub sections), youtube-26, youtube-27 and youtube-29 (chat column), vlc-19, vlc-31 and youtube-48
(stage layout). The catalogue has no case with several video sources, so the stage layout is reasoned from these.
