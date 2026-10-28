# Plan to submission

Target: submit by **Wed Nov 4, 12:00 ET** (the deadline is 9 PM ET). Drafted 2026-10-28 on the owner's answer to
[ticket 0010](../tickets/0010-plan.md); it changes as tickets are answered.

## Where we start

Built and running on the public VM: agents (captions, Turkish translation, slide descriptions, chapters) on the Meta
API, the relay behind signed tokens, the web app (viewer, speaker console, offline demo), and a looping demo room
with a placeholder clip. Live agents answer a speaker in room `live`. Spend $0.26 of $100.

## Order of work

The owner's order: inspect the running app → design the UI, functional requirements and features together → build.
The benchmark runs beside the build. Each piece of work is a lane with its own agent, run by a coordinator session
([team.md](team.md)).

| Day | Work | Needs |
|---|---|---|
| Wed Oct 28 | Owner inspects the live app. Lecture shortlist. Discuss track history (0015) and benchmark scope (0016). | — |
| Thu Oct 29 | Design session: UI, functional requirements, features → `wiki/spec/` and `wiki/product/`. Owner picks lectures; generate the demo lectures on the VM with real agents. | the inspection; ticket 0001 |
| Fri Oct 30 | Build: track archive (0015) with agent restore from it; per-room spend caps and judge tokens (decision 0008). Start the UI build from the spec. | tickets 0015, spec |
| Sat Oct 31 | Build: rewind from the archive in the viewer (decision 0007); UI build. Benchmark harness (MediaMTX baselines). | ticket 0016 |
| Sun Nov 1 | Build: finish UI; kill-and-restart test of every agent; benchmark runs; VM load test. | ticket 0004 |
| Mon Nov 2 | End-to-end checks on the VM in Chrome, Firefox, Safari and a phone; judge tokens minted; README with lecture credits; benchmark write-up. | — |
| Tue Nov 3 | Demo video and submission text; freeze `main`. | — |
| Wed Nov 4 | Buffer for fixes; submit by 12:00 ET. | — |

## Running servers

The VM runs everything around the clock: Docker restarts every service on failure and on boot. Updates follow
[howto/deploy.md](howto/deploy.md). The demo room loops all the time, and the live agents wait for a speaker in room
`live` and spend nothing while it is empty.

## Open questions that shape this plan

| Question | Ticket | Blocks |
|---|---|---|
| Which lectures (the owner picks from the shortlist) | [0001](../tickets/0001-demo-lectures.md) | real demo content |
| Which demo moments stay | [0004](../tickets/0004-demo-moments-in-looped-rooms.md) | the kill-and-restart work |
| Where track history lives | [0015](../tickets/0015-track-history-store.md) | archive, restore, rewind |
| Benchmark scope | [0016](../tickets/0016-benchmark.md) | benchmark work |

## Risks

- **The UI design and build together have about four days.** The spec session on Oct 29 decides how much fits; cut
  features there rather than at the end.
- **Rewind is the largest new piece:** an archive plus two sources in the viewer. If it slips, a looped room can still
  rewind within the recording, which is already static.
- **Safari and Firefox WebTransport support differs from Chrome's.** The WebSocket fallback is deployed, but it is
  untested in those browsers.
