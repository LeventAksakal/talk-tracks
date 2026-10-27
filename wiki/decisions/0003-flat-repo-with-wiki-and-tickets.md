---
status: accepted
date: 2026-10-27
decision-makers: project owner
---

# One flat repository holds the code, the product wiki, the decisions and the open questions

## Context and Problem Statement

Everything about the product lives in this public repo: code, a product wiki (capabilities, tech stack, how to use),
the functional and non-functional spec, the decisions, and questions waiting for the owner. Nothing private goes in.

## Considered Options

* Flat top level: `agents/ web/ contracts/ deploy/ wiki/ tickets/`
* `apps/` + `packages/` monorepo layout

## Decision Outcome

Chosen option: "flat top level", because two apps and one shared contract folder need no workspace tooling, and the
layout is obvious to someone browsing GitHub. The wiki is split by section: `wiki/product`, `wiki/spec`,
`wiki/stack`, `wiki/howto`, `wiki/decisions` (MADR). Questions that can wait are ticket files in `tickets/`, answered
by the owner in the file; blocking questions are asked directly.

### Consequences

* Good, because one clone gives a reader the code and the reasons for it.
* Neutral: there is no CI (hackathon build); checks run locally before committing.
