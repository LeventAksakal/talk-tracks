---
status: closed
created: 2026-10-28
tags: [moq, web, speaker, upstream]
---

# Should we patch @moq/publish, or ask upstream, so the speaker stamps room time directly?

## Question
The room clock is carried today by an offset the speaker console publishes on a `clock` track. Do we remove that
workaround after the hackathon by patching @moq/publish or by asking upstream for a timestamp-origin option?

## Context
@moq/publish stamps audio from `performance.now()` at capture start (its capture worklet's `zero`), and offers no
way to set the timestamp origin. A reload or a second broadcast in a room restarts the speaker's media clock near 0,
which made 4 s slice numbers collide. The owner chose an offset published by the speaker console for the build
(decision 0012, addendum "one room clock"; design: `wiki/design/moq-track-system.md` §4.5). Every consumer must read
the `clock` track before it stamps anything. The owner noted this is a limitation of the library itself.

## Options
- **Keep the offset.** Nothing more to build. Trade-off: every consumer (agents, archive, viewer) keeps reading the
  `clock` track, and a consumer that forgets stamps the wrong slice.
- **Patch @moq/publish locally** (a patch over the pinned version: an origin for the audio worklet's `zero` and the
  video frame timestamps). Trade-off: consumers need no offset; a patch over a minified build is brittle and must be
  redone on every upgrade.
- **Ask upstream** (an issue or PR on the moq repository for a timestamp-origin option in the publisher). Trade-off:
  the clean fix, and other users gain it; it lands on upstream's schedule, not ours.

## Recommendation
Keep the offset for the hackathon. Afterwards, open an upstream issue with the use case (a room clock that survives
publisher reloads) and patch locally only if upstream declines.

## Answer

Not needed (2026-10-28). @moq/publish is not limited here: it stamps every timestamp with `performance.now()` µs
and publishes the mapping to wall time as the hang catalog's root `clock`. The owner chose to use it (decision 0012,
"Revision 2026-10-28"), so there is no offset and no patch.
