---
status: accepted
date: 2026-10-27
decision-makers: project owner
---

# The web app is React 19 + Vite + TypeScript with Meta's Astryx design system

## Context and Problem Statement

The speaker console and the viewer are the only UI. The viewer serves deaf and blind people, so accessible components
matter. Judges are at Meta. Nothing existed in `web/` when this was decided, and the `@moq/*` browser libraries do not
depend on a UI framework.

## Considered Options

* React 19 + Vite + Astryx
* React 19 + Vite with our own components
* Vue 3 + Vite + Pinia

## Decision Outcome

Chosen option: "React 19 + Vite + Astryx", because Astryx gives a Meta look and ready, accessible components (it is
Meta's internal design system of eight years, open-sourced in 2026, MIT), so the time goes into the live-track logic.

### Consequences

* Good, because tabs, lists, cards, toggles and focus handling come ready, and the stack reads as Meta end to end.
* Bad, because Astryx is a 0.x public beta (0.7.4 on 2026-10-26). We pin a 0.7.x release at least two weeks old and
  do not upgrade before the deadline.
* Neutral: StyleX is a peer dependency; we style our own parts with plain CSS through `className`.

## More Information

[Astryx](https://astryx.atmeta.com/), [facebook/astryx](https://github.com/facebook/astryx).
