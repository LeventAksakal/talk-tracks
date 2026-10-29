# Talk Tracks wiki

What the product does, how it is built, how to use it, and why it is the way it is.

| Section | Holds |
|---|---|
| [product/](product/) | Capabilities: what a speaker and a viewer can do |
| [spec/](spec/) | Functional and non-functional specification |
| [stack/](stack/) | Tech stack and how the parts talk to each other |
| [howto/](howto/) | Running it locally, deploying, running a demo |
| [decisions/](decisions/) | Architecture decision records (MADR) |

Open questions for the owner are ticket files in [`../tickets/`](../tickets/). The dated plan is [plan.md](plan.md).

## Decisions

| Decision | Record |
|---|---|
| Agents in Python 3.13 on aiomoqt | [0001](decisions/0001-agents-in-python-on-aiomoqt.md) |
| Web app on React 19 + Vite + Astryx | [0002](decisions/0002-web-app-on-react-vite-and-astryx.md) |
| One flat repo with wiki and tickets | [0003](decisions/0003-flat-repo-with-wiki-and-tickets.md) |
| Relay, web app and agents on one VM | [0004](decisions/0004-relay-web-and-agents-on-one-vm.md) |
| Publishing needs a signed token; watching is open | [0005](decisions/0005-publishing-needs-a-signed-token.md) |
| Public demo loops pre-generated lectures | [0006](decisions/0006-demo-loops-pregenerated-lectures.md) |
| Rewind from a static archive of the room's tracks | [0007](decisions/0007-rewind-from-a-static-track-archive.md) |
| Judges get pre-minted room tokens with a spend cap | [0008](decisions/0008-judges-get-capped-room-tokens.md) |
| Agents restart from durable track history | [0009](decisions/0009-agents-restart-from-durable-track-history.md) |
| Agent tracks are opt-in; agents spend only while subscribed | [0010](decisions/0010-agent-tracks-are-opt-in-and-lazy.md) |
| Track history archived on the VM and copied to a bucket | [0011](decisions/0011-track-history-in-a-vm-archive-copied-to-a-bucket.md) |
| AI-track history served by FETCH from the agent, in 4 s slices | [0012](decisions/0012-ai-track-history-by-fetch-from-the-agent.md) |
| Benchmark runs on the resized 4-vCPU production VM | [0013](decisions/0013-benchmark-runs-on-the-resized-vm.md) |
| Turkish, Spanish and Arabic translations across expanded demo rooms | [0014](decisions/0014-translations-in-turkish-spanish-and-arabic.md) |
| Looped rooms keep rising wire time and present each loop as a session | [0015](decisions/0015-looped-rooms-model-repeated-live-sessions.md) |
| Benchmark includes 10/100-viewer fan-out on the VM | [0016](decisions/0016-benchmark-includes-fanout-and-runs-on-the-vm.md) |
