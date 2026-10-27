---
status: open
created: 2026-10-27
tags: [web, viewer, deploy, contracts]
---

# Are the web app's working defaults right?

## Question
The web app was built with the defaults below. Confirm each, or say which to change.

## Context
None of these blocks the build; each is easy to change later. Each line is a choice the web lane made while building
the viewer and speaker console.

## Options
1. **Snapshot history in the viewer.** Keep 3000 state changes per agent and thin older ones (bounded memory; old
   scrollback loses entries). Alternatives: keep everything (memory grows with the talk), or cap plus a download of the
   full log (more work).
2. **Default subscriptions.** A viewer subscribes to every agent track except other languages' translations; one tap
   adds a language. Alternative: subscribe to everything (simpler, more bandwidth per language).
3. **Deployed web server.** Send unknown paths to `index.html` (needed) and add COOP/COEP isolation headers, which give
   `@moq/watch` SharedArrayBuffer and lower audio latency but block cross-origin assets without a CORP header.
   Alternative: the fallback only.
4. **Speaker path stays `talk/<room>/teacher`** without the `.hang` suffix `@moq/publish` asks for; only a console
   warning remains. Alternative: rename to `talk/<room>/teacher.hang`, which changes the contract and every lane.
5. **Clock of `SlideFrame.at_ms`.** The speaker console stamps slides with `performance.now()`, the same clock as its
   audio, so a slide lines up with the audio timeline; it is not wall time. The contract text should say so.
   Alternative: wall clock (readable, does not line up with audio).

## Recommendation
Keep all five as built: 3000-entry cap, all tracks but other translations, SPA fallback plus COOP/COEP (everything is
served from one origin), no `.hang` rename, slides on the media clock (and the contract text updated to say it).

## Answer

