# Deploy to the VM

Everything runs on one cloud VM (decision 0004) from `deploy/compose.vm.yml`:

| Service | What it does |
|---|---|
| `caddy` | Let's Encrypt certificate for the hostname, the web app (`web/dist`, SPA fallback, cross-origin isolation headers) on TCP 443, WebSocket upgrades proxied to the relay |
| `relay` | moq-relay on UDP 443 (QUIC and WebTransport) with Caddy's certificate; asks `auth` about every session |
| `auth` | `moq auth serve` with the public key: anyone may watch `talk/**`, publishing needs a signed token ([tokens](tokens.md)) |
| `looper` | the demo room, replaying a recording from `$TT_DATA/demo/<lecture>/` ([demo rooms](demo-rooms.md)) |
| `captions`, `translate-tr`, `describe`, `chapters` | live agents for `$TT_LIVE_ROOM` (profile `live`; they need the Meta key) |

The browser reaches the relay on the page's own origin: a production build needs no relay URL.

## Layout on the VM

Nothing here is in git; the hostname, keys and tokens stay on the VM.

| Path | Holds |
|---|---|
| `~/talk-tracks` | a clone of this repo; `web/dist` is copied in from a local build |
| `~/talk-tracks/deploy/.env` | `TT_HOST`, `TT_KEYS`, `TT_DATA`, `TT_DEMO_ROOM`, `TT_LECTURE`, `TT_LIVE_ROOM`, `TT_LOOPER_TOKEN`, `TT_AGENT_TOKEN` (mode 600) |
| `~/tt-keys` | `private.jwk` (mode 600, made on the VM, never copied off) and `public.jwk` |
| `~/tt-data` | `demo/<lecture>/` recordings, the agents' `state/` and the spend ledger `ledger.jsonl` |
| `~/tt-secrets/meta.env` | `META_API_KEY=...` (folder 700, file 600); compose passes it to the live agents only, never to the looper |

The VM's ledger started with one line that carries over the laptop ledger's total ($0.2333 on 2026-10-27), so its
$100 ceiling covers everything spent so far. The two ledgers do not see each other after that: run real-API work on
the VM, or add a carry-over line for laptop spend.

Caddy's certificate lives in the Docker volume `moq_caddy_data`, kept from the pre-event setup.

## Update

From a local checkout, with `VM` set to `user@host` for SSH:

```bash
git push
(cd web && npm run build)
ssh $VM 'cd ~/talk-tracks && git pull'
tar -C web/dist -cz . | ssh $VM 'rm -rf ~/talk-tracks/web/dist/* && tar -C ~/talk-tracks/web/dist -xz'
ssh $VM 'cd ~/talk-tracks/agents && docker build -q -t talk-tracks-agents:dev .'
ssh $VM 'cd ~/talk-tracks && docker compose -f deploy/compose.vm.yml up -d'
```

The relay and auth images are built locally (`docker compose -f deploy/compose.local.yml -f deploy/compose.auth.yml
build relay auth`; Rust builds are slow on the VM) and copied over:
`docker save talk-tracks-relay:0.17.8 talk-tracks-auth:0.14.8 | gzip -1 | ssh $VM 'gunzip | docker load'`.

A new demo lecture is a folder copied to `~/tt-data/demo/<lecture>/`, then `TT_LECTURE=<lecture>` in `.env` and
`docker compose -f deploy/compose.vm.yml up -d looper`.

## Sign a token on the VM

```bash
ssh $VM 'docker run --rm -u $(id -u):$(id -g) -v ~/tt-keys:/keys talk-tracks-auth:0.14.8 auth sign --key /keys/private.jwk --publish talk/R/teacher --publish talk/R/slides --subscribe "talk/R/**" --expires $(date -d "+1 day" +%s)'
```

A speaker opens `https://<host>/talk/R?token=<token>`.

## Checked on 2026-10-27

First deploy, replacing the pre-event relay setup:

- Caddy kept the existing certificate.
- `/watch/demo` served over HTTPS with the isolation headers, an SPA path and `/healthz`.
- In Chrome, `/watch/demo` played the looped lecture video with captions, slide descriptions and chapters, and the
  page was cross-origin isolated with no console errors.
- From outside the VM, anonymous `watch` over QUIC followed the demo room.
- A speaker token signed on the VM published `talk/smoke/teacher` and `talk/smoke/slides`, and the viewer showed the
  speaker on air.
- These sessions were refused: one with no token, and one with a token signed by another key.
- The WebSocket upgrade through Caddy answered 101.

Then the live agents, with the key from `~/tt-secrets`:

- A signed speaker stand-in played synthetic speech into room `live` from outside the VM.
- Real captions came out, with the Turkish translation and chapters keeping pace.
- The ASR was paid one minute ahead in the VM ledger.
- About a minute and a half of speech cost about $0.03.
- The looper container has no key in its environment.

The live agents stay up and wait for a speaker. They spend only while someone publishes audio with a speaker token.

## Watch out

- The relay reads the certificate when it starts. Caddy renews it about 30 days before it expires; restart the relay
  after that (`docker compose -f deploy/compose.vm.yml restart relay auth`).
- `auth` shares the relay's network namespace: restart both together, or the auth server is cut off and every
  session is refused (the relay answers 502).
- Clients that connect in the moment between the relay and the auth server starting are refused; agents restart by
  themselves.
