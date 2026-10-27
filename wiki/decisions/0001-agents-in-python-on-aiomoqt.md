---
status: accepted
date: 2026-10-27
decision-makers: project owner
---

# AI agents are written in Python 3.13 on aiomoqt (IETF MoQT draft-18)

## Context and Problem Statement

Each AI step (captions, translation, slide description, chapters) is its own publisher of tracks on a Media over QUIC
relay. The agent core (contracts, Meta ASR and LLM providers, spend ledger, track cores) was already written in Python
with 26 passing tests when the stack was put to the owner.

## Considered Options

* Python + aiomoqt 0.13.1
* TypeScript on Node with `@moq/net`
* Rust with moq-native

## Decision Outcome

Chosen option: "Python + aiomoqt", because the code exists and is tested, and the path from a browser publisher
(moq-lite) through moq-relay to an aiomoqt subscriber (draft-18) was measured before the build: 1,212 Opus objects,
24.2 s of audio, no gaps.

### Consequences

* Good, because PyAV decodes Opus natively and the providers, cores and tests carry over.
* Bad, because aiomoqt has no Windows wheels: agents run in Docker (Linux) only.
* Bad, because aiomoqt has no reconnect of its own: an agent exits on connection loss and Docker restarts it as a
  fresh instance.
