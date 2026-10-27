# Talk Tracks

AI agents that publish into a live talk over Media over QUIC.

A speaker talks. Each AI step is its own publisher of named tracks in the same live broadcast: captions, a
translation per language, a description of every new slide for a listener who cannot see it, chapters and a glossary
for someone who arrives late. A viewer subscribes only to the tracks they want. Agents can be added, swapped or
restarted mid-talk, and one cache serves late joiners.

Status: work in progress for the Meta Global AI Developer Hackathon (submissions due 2026-11-04).

## Built during the hackathon

Everything in this repository was written from 2026-10-27 on, in the hackathon's building period. Before the event
the author ran feasibility measurements (relay choice, browser and phone behaviour, load) and kept notes; no code
from before the event is in this repository.

## Meta models used

| Job | Model |
|---|---|
| Live captions (the source text for every other track) | Muse Voice Transcribe, realtime endpointing |
| Translation, chapters, glossary, recap | Muse Spark (Standard mode) |
| Slide description | Muse Spark vision |

## Layout

| Path | What |
|---|---|
| `agents/` | Python agents (captions, translate, describe, chapters), the Meta providers, tests |
| `web/` | Speaker console and viewer, Vue 3 + TypeScript |
| `deploy/` | Relay and web server on a single VM |
| `contracts/` | JSON Schemas of every payload, generated from the Python models |

## Open-source parts

moq-relay and the `@moq/*` browser libraries (MIT or Apache-2.0, by the moq.dev authors), aiomoqt, PyAV, NumPy,
pydantic, httpx, websockets, Vue, Vite, Pinia. Licences are checked in `NOTICE`.

## Licence

Apache-2.0, see `LICENSE`.
