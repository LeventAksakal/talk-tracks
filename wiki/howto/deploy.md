# Deploy to the VM

Everything runs on one cloud VM (decision 0004) from `deploy/compose.vm.yml`:

| Service | What it does |
|---|---|
| `caddy` | Let's Encrypt certificate for the hostname, the web app (`web/dist`, SPA fallback, cross-origin isolation headers) on TCP 443, WebSocket upgrades proxied to the relay |
| `relay` | moq-relay on UDP 443 (QUIC and WebTransport) with Caddy's certificate; asks `auth` about every session |
| `auth` | `moq auth serve` with the public key: anyone may watch `talk/**`, publishing needs a signed token ([tokens](tokens.md)) |
| `looper` | the demo room, replaying a recording from `$TT_DATA/demo/<lecture>/` ([demo rooms](demo-rooms.md)) |
| `captions`, `translate-tr`, `describe`, `chapters` | live agents for every room a speaker opens, or `$TT_LIVE_ROOMS` (profile `live`; they need the Meta key). Lazy: they pay only while their track is subscribed, and each room has a spend cap ([lazy agents](lazy-agents.md)) |

The browser reaches the relay on the page's own origin: a production build needs no relay URL.

## Layout on the VM

Nothing here is in git; the hostname, keys and tokens stay on the VM.

| Path | Holds |
|---|---|
| `~/talk-tracks` | a clone of this repo; `web/dist` is copied in from a local build |
| `~/talk-tracks/deploy/.env` | `TT_HOST`, `TT_KEYS`, `TT_DATA`, `TT_DEMO_ROOM`, `TT_LECTURE`, `TT_LOOPER_TOKEN`, `TT_AGENT_TOKEN` (signed for `talk/*/agents/**`, [tokens](tokens.md)), optionally `TT_LIVE_ROOMS` (default `*`) and `TT_ROOM_CAP_USD` (default 2) (mode 600) |
| `~/tt-data/caps/` | one JSON file per judge token batch: its rooms, room cap and total cap ([tokens](tokens.md#judge-tokens)) |
| `~/tt-keys` | `private.jwk` (mode 600, made on the VM, never copied off) and `public.jwk` |
| `~/tt-data` | `demo/<lecture>/` recordings, the track `archive/` (each agent's slices: what it serves FETCH from and restarts from), the spend ledger `ledger.jsonl` |
| `~/tt-secrets/meta.env` | `META_API_KEY=...` (folder 700, file 600); compose passes it to the live agents only, never to the looper |

The VM's ledger started with one line that carries over the laptop ledger's total ($0.2333 on 2026-10-27), so its
$100 ceiling covers everything spent so far. The two ledgers do not see each other after that: run real-API work on
the VM, or add a carry-over line for laptop spend.

Caddy's certificate lives in the Docker volume `moq_caddy_data`, kept from the pre-event setup.

## Before an update

Save what runs now, so a bad release can be undone in a minute. On the VM, with `<change>` a short name for this
release (for example `loop-archive`):

```bash
ssh $VM 'cd ~/talk-tracks &&
  git rev-parse --short HEAD &&
  docker tag talk-tracks-agents:dev talk-tracks-agents:before-<change> &&
  cp -a web/dist ~/web-dist-$(git rev-parse --short HEAD) &&
  cp -a deploy/.env ~/env-before-<change>'
```

A web-only release (only `web/` changed) needs just the `cp -a web/dist …` line. After uploading the bundle, check
that the site serves the new `assets/index-*.js` name (`curl -s https://$SITE/ | grep -o 'assets/index-[^"]*'`).

- The first line prints the old commit; write it down, since the roll-back needs it.
- The image tag keeps the old agents image after the rebuild moves `:dev` (compose runs `talk-tracks-agents:dev`,
  or `$TT_AGENTS_TAG`; use that tag if it is set).
- The bundle copy is `~/web-dist-<old commit>`, next to the clone.
- The `.env` copy holds the tokens, so keep it mode 600 (`chmod 600 ~/env-before-<change>`) and out of git.

The relay and auth images change rarely and keep their versioned tags, so they need no copy.

## Update

From a local checkout, with `VM` set to `user@host` for SSH:

```bash
git push
(cd web && npm run build)
ssh $VM 'cd ~/talk-tracks && git pull'
tar -C web/dist -cz . | ssh $VM 'rm -rf ~/talk-tracks/web/dist/* && tar -C ~/talk-tracks/web/dist -xz'
ssh $VM 'cd ~/talk-tracks/agents && docker build -q -t talk-tracks-agents:dev .'
ssh $VM 'cd ~/talk-tracks && docker compose -f deploy/compose.vm.yml --profile live up -d'
```

`--profile live` matters: without it compose leaves the live agents (`captions`, `translate-tr`, `describe`,
`chapters`) on the old image.

If the release changes the demo rooms, also re-sign `TT_LOOPER_TOKEN` (it must cover rooms `virus` and `dataviz`) and
remove the old `talk-tracks-looper-1` container, as in [demo rooms](demo-rooms.md#the-two-public-rooms). Do this
before the `up -d` above, or run `up -d looper-virus looper-dataviz` afterwards.

The relay and auth images are built locally (`docker compose -f deploy/compose.local.yml -f deploy/compose.auth.yml
build relay auth`; Rust builds are slow on the VM) and copied over:
`docker save talk-tracks-relay:0.17.8 talk-tracks-auth:0.14.8 | gzip -1 | ssh $VM 'gunzip | docker load'`.

A new demo lecture is a folder copied to `~/tt-data/demo/<lecture>/`, then `TT_LECTURE=<lecture>` in `.env` and
`docker compose -f deploy/compose.vm.yml up -d looper`.

## Roll back

Undo an update using what [Before an update](#before-an-update) saved. `<old commit>` and `<change>` are the values
from that step.

```bash
ssh $VM 'rm -rf ~/talk-tracks/web/dist/* && cp -a ~/web-dist-<old commit>/. ~/talk-tracks/web/dist/'
ssh $VM 'docker tag talk-tracks-agents:before-<change> talk-tracks-agents:dev'
ssh $VM 'cd ~/talk-tracks && git checkout <old commit>'
ssh $VM 'cd ~/talk-tracks && diff deploy/.env ~/env-before-<change> || cp ~/env-before-<change> deploy/.env'
ssh $VM 'cd ~/talk-tracks && docker compose -f deploy/compose.vm.yml --profile live up -d'
```

- `git checkout` leaves the clone on a detached head. Run `git checkout main` before the next update's `git pull`.
- The `diff` copies the saved `.env` back only if it changed (a re-signed token, a new `TT_LECTURE`).
- `--profile live` matters here too: without it the live agents stay on the new image.
- If the release re-signed `TT_LOOPER_TOKEN` or changed the demo rooms, remove the old looper container as in
  [demo rooms](demo-rooms.md#the-two-public-rooms).

Then run the usual checks from [Checked on 2026-10-27](#checked-on-2026-10-27): `/watch/demo` over HTTPS with the
isolation headers, `/healthz`, the looped lecture with captions, and the agents logging `serving rooms *`.

Data changes are not code and are undone on their own:
- the archive layout: [roll back](archive.md#deploy-the-room-service-to-the-vm) in the archive howto;
- re-cut demo captions: [undo](demo-rooms.md#fitting-the-turkish-cues-to-84-characters-resplit) in demo rooms, which restores
  `translate-tr.cues.orig.json`.

## Clean up

Once the deploy is accepted, remove the saved copies:

```bash
ssh $VM 'docker rmi talk-tracks-agents:before-<change>; rm -rf ~/web-dist-<old commit> ~/env-before-<change>'
```

Keep them until then; the older images they point at take disk space on a small VM.

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

## Checked on 2026-10-28: lazy agents and caps

The deploy followed [lazy agents](lazy-agents.md):
- the agent token was re-signed for `talk/*/agents/**`;
- `TT_LIVE_ROOMS=*` was added;
- `~/tt-data/caps` was created;
- the agents image was rebuilt.

Results:
- **Rooms:** all four agents logged `serving rooms *`. None served the demo room.
- **Idle:** a speaker stand-in was on air in room `smoke` for 40 s with no viewer. The agents served the room and the
  ledger did not grow.
- **Wake:** opening `/watch/smoke` woke them, and the ledger lines carry `"room": "smoke"`.
- **Idle after leaving:** after the viewer left, captions logged `no subscribers, idle` and the ledger stayed flat.
- **Spend:** the check cost about $0.06. The total is $0.33.
- **Defect:** switching a track off in the current viewer does not cancel its subscription. The translation agent
  kept calling the model until the page closed. The new UI must unsubscribe on switch-off (decision 0010).

**Incident.** The relay restarted on its own about three hours before this deploy, and auth did not.
- Auth shares the relay's network namespace, so it was cut off.
- Every agent and the demo looper crash-looped on `ConnectionTerminated (566)`, and the relay logged `auth server
  unavailable`.
- Nothing alerted us. Restarting `relay` and `auth` together fixed it.

## Checked on 2026-10-28: auth over a unix socket

After `up -d relay auth`, `restart relay` was run on its own as a test.
- Within about 40 s every service was up again, and the agents and looper had reconnected (`connected to relay
  (draft 18)`).
- The relay logged `auth server unavailable` 0 times.
- `/watch/demo` played with the connection open.

## Watch out

- Caddy mounts `deploy/Caddyfile` as a single file. `git pull` replaces the file, and the container keeps the old
  copy, so `caddy reload` reloads the old config. After a release that changes the Caddyfile, run
  `docker compose -f deploy/compose.vm.yml restart caddy` and check with `exec -T caddy cat /etc/caddy/Caddyfile`.
- The relay reads the certificate when it starts. Caddy renews it about 30 days before it expires; restart the relay
  after that (`docker compose -f deploy/compose.vm.yml restart relay`).
- The relay asks `auth` over a unix socket in the volume `auth_sock`, not over a shared network namespace, so either
  container can restart, crash or be recreated alone and sessions work again once it is back. (Until 2026-10-28
  `auth` shared the relay's namespace and was cut off whenever the relay restarted by itself.) `auth` removes a stale
  socket before it binds. If sessions are refused, check `docker compose ... ps` and the relay log for `auth server
  unavailable`.
- `docker kill` and `docker stop` count as a manual stop: the restart policy does not bring the container back, a
  crash does. Start it again with `docker compose -f deploy/compose.vm.yml up -d`.
- Clients that connect in the moment between the relay and the auth server starting are refused; agents restart by
  themselves.
