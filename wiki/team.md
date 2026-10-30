# Team: one agent per lane

The work is split the way a team splits responsibilities: each lane is one dedicated agent with its own goal, files
and definition of done, and a coordinator session runs them (project `CLAUDE.md`). Dates are in [plan.md](plan.md).

## Rules for every lane

- **Branches:** work on your own branch in your own worktree, and commit and push often. The coordinator merges into
  `main`; you never push to `main`.
- **Files:** touch only your lane's files. Changes to the wire contracts (`contracts/`, the JSON Schemas) or to
  another lane's files go through the coordinator.
- **Questions:** never ask the owner directly. Return questions to the coordinator, who asks them or files them as
  tickets.
- **When blocked:** stop and report. Don't retry a blocked path, park on long sleeps, or start sub-agents unless the
  work needs them.
- **Real API calls** run only on the VM, through its spend ledger ([deploy](howto/deploy.md)). Locally, use `--fake`.
- **Checks before handing back:**
  - agents: `uv run pytest`, `ruff` and `pyright`;
  - web: `npm run typecheck`, `lint`, `test` and `build`;
  - then a smoke run of what you changed.
- **The public repo** holds nothing private: no hostnames, IPs, keys, tokens or bucket names.

## Lanes

| Lane | Goal | Owns | Depends on | Done when |
|---|---|---|---|---|
| **Demo content** | The two chosen lectures play in looped demo rooms with real agent tracks. | `data/demo/` on the VM, `deploy/media/`, README credits | owner's pick in [ticket 0001](../tickets/0001-demo-lectures.md) | Each lecture is downloaded once from media.ccc.de and trimmed (no EMF title card, sponsor logos or jingle; cuts at sentence breaks). Tracks are generated once on the VM with real agents. Two rooms loop. The README credits each talk under CC BY-SA 4.0 with a note of changes. Spend is reported. |
| **Lazy agents and caps** | Agents spend only while their track is subscribed, and judge rooms have capped tokens. | `agents/src/talk_tracks/` (runtime, cli, moq, ledger), `deploy/compose.vm.yml` agent services | decisions [0008](decisions/0008-judges-get-capped-room-tokens.md) and [0010](decisions/0010-agent-tracks-are-opt-in-and-lazy.md) | An agent goes idle with no subscribers and wakes on the first one (tested against the relay, including how fast the relay drops an upstream subscription). Per-room spend caps work. Agents serve any room a speaker opens, or the rooms in a list. Judge tokens can be minted with a cap. |
| **Track archive** | Every room's tracks are stored, survive the VM, and restore restarted agents. | new `agents/src/talk_tracks/archive/` (or as designed), `deploy/` archive service | owner's answer to [ticket 0015](../tickets/0015-track-history-store.md); decision [0009](decisions/0009-agents-restart-from-durable-track-history.md) | The archiver writes media segments and snapshot timelines for every room, and Caddy serves them. History is copied off the VM (if 0015 says so). A killed agent restarts from the archive with ids continuing. A VM restore is documented and tested once. |
| **Rewind** | A viewer seeks anywhere in a room and returns with "Go live". | `web/src/` viewer playback and timeline | the archive format; decision [0007](decisions/0007-rewind-from-a-static-track-archive.md) | Seeking works in looped rooms first (their recording is static already), then in live rooms from the archive. Media and every opted-in track line up on one clock, and "Go live" rejoins the relay. |
| **Product spec and UI** | The UI, functional requirements and features agreed with the owner, then built. | `wiki/product/`, `wiki/spec/`, `web/src/` pages and components (except playback) | the owner's inspection of the running app | The spec is written from the owner's design session, which the coordinator runs. The UI is built to it, with opt-in track toggles (decision 0010). The web checks pass, and it is checked in Chrome, Firefox, Safari and a phone. |
| **Benchmark** | Talk Tracks' MoQ compared with HLS, DASH and WebRTC on capabilities and performance. | new `bench/`, `wiki/benchmark.md` | [ticket 0016](../tickets/0016-benchmark.md) | A capability matrix: the app's required features against what each protocol delivers, with citations. Measured latency and join time for MoQ, LL-HLS and WebRTC (MediaMTX on the VM, same source), with throughput or fan-out as scoped. Each run can be repeated from `bench/`, and the results page states its method. |

## The coordinator

- Starts lanes once their dependencies are met, briefs them from this page, supervises them (the owner's global rules
  on leading agent teams), merges their branches and prunes them.
- Is the only one who deploys to the VM. Lanes hand over what to deploy.
- Keeps [plan.md](plan.md), the tickets index and the sitrep (`/sitrep`, stored outside git) current, and reports
  stalls and spend to the owner.

## Foundation lanes (from 2026-10-30)

The player and "every interaction is a track" work (decisions 0017–0019). Full briefs:
[lane-briefs.md §Foundation lanes](design/lane-briefs.md#foundation-lanes-2026-10-30). They replace the Product spec
and UI lane above; the Rewind lane's engine in `web/src/playback/` stays and the Player lane builds on it.

| Lane | Goal | Owns | Depends on | Starts |
|---|---|---|---|---|
| **Event track contracts** | Models and schemas for slide, ink, pointer, deck, comments and room tracks | `contracts/`, Python models, `web/src/contracts/` | — | first |
| **Player** | The viewer as a media player, overlays on the room clock | `web/src/player/`, watch and demo pages | platform research first; contracts for step 3 | at once |
| **Speaker console** | Mic, camera, PDF deck, presenter notes, ink and laser as tracks | `web/src/speaker/`, talk page | contracts | after contracts merge |
| **Event track archive and replay** | Speaker event tracks archived and served by FETCH; demo rooms get slide tracks | archive, room service, `deploy/` | contracts | after contracts merge |
| **Any-language translation** | A lazy translation track per requested language | translate agent, demand, caps | — | at once |
| **Comments** | Comments anchored on slides, replayed at their time | room service endpoint, Discussion tab | player, console, archive | after the foundation, if time |
