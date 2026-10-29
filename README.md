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
| `web/` | Speaker console and viewer, React 19 + TypeScript with Meta's Astryx design system |
| `deploy/` | Relay, web server and agents on a single VM |
| `contracts/` | JSON Schemas of every payload, generated from the Python models |
| `wiki/` | Product, spec, stack, how-to and decision records ([index](wiki/README.md)) |
| `tickets/` | Open questions waiting for the owner |

## Open-source parts

moq-relay and the `@moq/*` browser libraries (MIT or Apache-2.0, by the moq.dev authors), aiomoqt, PyAV, NumPy,
pydantic, httpx, websockets, React, Vite, Astryx. Licences are checked in `NOTICE`.

## Demo lectures

The public demo rooms loop four talks from Electromagnetic Field 2026, recorded by the EMF Video Team and C3VOC and
published on media.ccc.de under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/):

| Room | Talk | Speaker | Part used |
|---|---|---|---|
| `virus` | [You Are Part Virus: How Biological Viruses Hack Cells](https://media.ccc.de/v/emf2026-149-1-you-are-part-virus-how-biological-viruses-hack-cells) | Christopher Binny | 0:12.6–17:12.8 of the recording |
| `dataviz` | [Data Visualisation: The Good, The Bad, The Ugly and the Beautiful](https://media.ccc.de/v/emf2026-241-1-data-visualisation-the-good-the-bad-the-ugly) | Charlotte Rutherford | 0:12.6–19:11.4, the whole talk |
| `rsa` | [It's the End of RSA as We Know It (And I Feel Fine): An Introduction to Post-Quantum Cryptography](https://media.ccc.de/v/emf2026-242-1-its-the-end-of-rsa-as-we-know-it-and-i-feel-fine) | Lucy Bell | 0:12.6–20:04.8 of the recording |
| `qrcode` | [A Brief History of the QR Code, and other scannable things](https://media.ccc.de/v/emf2026-234-1-a-brief-history-of-the-qr-code-and-other-scannable-things) | Jon Ginn | 0:12.6–16:22.4, the whole talk |

Changes made:

- Each talk is trimmed: the EMF title card, sponsor logos and jingle at the start are cut, and so is the closing
  licence card. The biology and RSA talks end at section breaks before concluding Q&A / final parts; design and QR code
  loop the whole talk.
- Each is re-encoded for streaming (720p H.264, mono Opus).
- AI-generated tracks are added, made once by this project's agents with Meta models: captions, translations in
  Turkish, Spanish, and Arabic, slide descriptions, and chapters with a glossary and recap.

The trimmed videos and the tracks derived from them are shared under CC BY-SA 4.0 too. The cuts are in
`deploy/media/demo-lectures.sh`. The videos themselves are not in this repository.

## Licence

Apache-2.0, see `LICENSE`. The demo lectures and their derived tracks are CC BY-SA 4.0 (see above).
