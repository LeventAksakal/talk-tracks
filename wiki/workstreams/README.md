# Workstreams

One file per workstream. Each one is a brief you can hand to a fresh session, plus that workstream's log. The
order and dates are in [../roadmap.md](../roadmap.md).

| # | Workstream | Owns (files) |
|---|---|---|
| 01 | [User journeys](01-user-journeys.md) | `wiki/product/journeys.md` |
| 02 | [Brand and assets](02-brand-and-assets.md) | `wiki/product/brand.md`, `web/public/`, `web/src/theme/` |
| 03 | [App UI](03-app-ui.md) | `web/src/pages/`, `web/src/app/`, `web/src/player/` (visual), `web/src/speaker/` (visual) |
| 04 | [Slides canvas and tools](04-slides-canvas.md) | `web/src/canvas/` (new), drawing in `web/src/speaker/` and `web/src/player/` |
| 05 | [Platform gaps and integration](05-platform-gaps.md) | `agents/` room service, `deploy/`, merges, deploys |
| 06 | [QA and performance](06-qa-performance.md) | `wiki/qa/` |
| 07 | [Submission](07-submission.md) | `README.md`, `NOTICE`, submission text, video |

## How to pick one up

1. Open the workstream file and read its **Read first** list.
2. Start the session with the **Start prompt** at the bottom of the file.
3. Set **Status** at the top and your row in the roadmap's status board.
4. Append to the **Log** as you go: decisions, what landed (commit hashes), blockers, handoffs. Newest last, one line
   each.
5. When done, check the **Definition of done**, set `Status: done` and write the handoff line for the next workstream.

## Rules for every session

- The project rules in `CLAUDE.md` and [team.md](../team.md) still hold: one branch and worktree per workstream, touch
  only your files, contract changes (`contracts/`, schemas) go through the coordinator (workstream 05), only the
  coordinator deploys.
- A public repo: no hostnames, IPs, keys or tokens in any file.
- Questions for the owner: blocking ones are asked directly; async ones become a ticket in `tickets/`.
- Web checks before handing over: `npm run typecheck && npm run lint && npm test && npm run build` in `web/`.

## Log format

```
| When (+03) | Session | Entry |
|---|---|---|
| 10-31 14:10 | journeys-1 | Drafted J1–J4; J5 needs a decision on room creation → asked owner |
```
