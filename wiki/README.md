# Talk Tracks wiki

What the product does, how it is built, how to use it, and why it is the way it is.

| Section | Holds |
|---|---|
| [product/](product/) | Capabilities: what a speaker and a viewer can do |
| [spec/](spec/) | Functional and non-functional specification |
| [stack/](stack/) | Tech stack and how the parts talk to each other |
| [howto/](howto/) | Running it locally, deploying, running a demo |
| [decisions/](decisions/) | Architecture decision records (MADR) |

Open questions for the owner are ticket files in [`../tickets/`](../tickets/).

## Decisions

| Decision | Record |
|---|---|
| Agents in Python 3.13 on aiomoqt | [0001](decisions/0001-agents-in-python-on-aiomoqt.md) |
| Web app on React 19 + Vite + Astryx | [0002](decisions/0002-web-app-on-react-vite-and-astryx.md) |
| One flat repo with wiki and tickets | [0003](decisions/0003-flat-repo-with-wiki-and-tickets.md) |
| Relay, web app and agents on one VM | [0004](decisions/0004-relay-web-and-agents-on-one-vm.md) |
| Publishing needs a signed token; watching is open | [0005](decisions/0005-publishing-needs-a-signed-token.md) |
| Public demo loops pre-generated lectures | [0006](decisions/0006-demo-loops-pregenerated-lectures.md) |
