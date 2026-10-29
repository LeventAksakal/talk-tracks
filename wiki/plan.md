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
| Wed Oct 28 | Owner inspects the live app and holds the design session the same day: UI, functional requirements, features → `wiki/spec/` and `wiki/product/`. Lectures picked (0001); track history decided (0015 → decision 0011). Lanes start: lazy agents and caps, benchmark, demo content, track archive. | — |
| Thu Oct 29 | Start the UI build from the spec. Generate the demo lectures on the VM with real agents. | the spec |
| Fri Oct 30 | Build: track archive (decision 0011) with agent restore from it; per-room spend caps and judge tokens (decision 0008); UI build. | — |
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

All 19 tickets in [`../tickets/`](../tickets/) are closed as of 2026-10-29:
- **UI lane:** led directly by the owner (`web/`).
- **Translations & demo rooms ([decision 0014](decisions/0014-translations-in-turkish-spanish-and-arabic.md)):** Turkish,
  Spanish and Arabic (`tr`, `es`, `ar`) across live rooms and an expanded set of CC BY-SA 4.0 looped demo rooms.
- **Loop sessions & demo moments ([decision 0015](decisions/0015-looped-rooms-model-repeated-live-sessions.md)):** all
  four architecture moments stay; looped rooms frame each loop as a broadcast session on top of rising room time.
- **Benchmark ([decision 0013](decisions/0013-benchmark-runs-on-the-resized-vm.md),
  [0016](decisions/0016-benchmark-includes-fanout-and-runs-on-the-vm.md)):** B+ plus 10/100-viewer server fan-out on the
  resized 4-vCPU VM.
- **Archive & backups ([decision 0011](decisions/0011-track-history-in-a-vm-archive-copied-to-a-bucket.md)):** demo
  recordings stay out of git on the VM and back up with the archive and spend ledger to the Cloud Storage bucket.
- **Tooling ([ticket 0008](../tickets/0008-pre-commit-checks.md)):** fast `.githooks/pre-commit` secret + staged lint check.

## Risks

- **The UI design and build together have about four days.** The spec session on Oct 29 decides how much fits; cut
  features there rather than at the end.
- **Rewind is the largest new piece:** an archive plus two sources in the viewer. If it slips, a looped room can still
  rewind within the recording, which is already static.
- **Safari, every iOS browser and Firefox before 153 always use the WebSocket fallback over TCP.** The pinned
  `@moq/net` 0.4.5 refuses WebTransport on every WebKit engine (WebKit bug 319818: long sessions stall), even
  though Safari 26.4 ships it. That makes the fallback the main path for iPhone students, not an edge case. It is
  deployed but untested in those browsers. The benchmark measures it as its own row (found 2026-10-28).
