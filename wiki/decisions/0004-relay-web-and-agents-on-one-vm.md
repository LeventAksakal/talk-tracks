---
status: accepted
date: 2026-10-27
decision-makers: project owner
---

# The relay, the web app and the agents run together on one cloud VM

## Context and Problem Statement

A public relay already runs on a small cloud VM (moq-relay 0.17.8 behind Caddy for the WebSocket fallback), set up
and measured before the build. Judges try the demo at any hour, including while the owner is offline.

## Considered Options

* Relay: the existing VM, redeployed from `deploy/`; a fresh host; the laptop with a tunnel
* Web app: Caddy on the same VM; Cloudflare Pages; GitHub Pages
* Agents: Docker on the same VM; the laptop; a serverless platform

## Decision Outcome

Chosen: everything on the existing VM, deployed from this repo's `deploy/`. Caddy serves the static web build next to
the relay; the agents run as Docker containers beside it.

### Consequences

* Good, because there is one box and one deploy, and the demo stays up without the laptop.
* Good, because agents are light: speech recognition and language models are remote Meta API calls.
* Bad, because the VM's memory is the limit to watch as agents are added.
* Hostnames and addresses stay out of the repo; deploy files take them from the environment.
