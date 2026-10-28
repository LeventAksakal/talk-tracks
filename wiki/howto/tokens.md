# Sign publishing tokens

Anyone may watch a room; publishing into one needs a token signed with the room key (decision 0005 and its
addendum). The relay asks `moq auth serve` about every session; that server checks the token's signature and scope.

## Keys

One ES256 key pair. The private key signs tokens and never enters the repo or the relay host's public files; the
auth server only needs the public key. Locally both live in `agents/data/keys/` (git-ignored):

```bash
docker run --rm -v ./agents/data/keys:/keys talk-tracks-auth:0.14.8 auth generate --algorithm ES256 --out /keys/private.jwk --public /keys/public.jwk
```

Build the image first from `deploy/`: `docker build -t talk-tracks-auth:0.14.8 -f Dockerfile.auth .`

## Tokens

Scopes are path patterns from the relay root; `foo/**` covers `foo` and everything under it. `--expires` is a unix
time; a token is refused from then on, and a live session closes at that moment.

| Who | Publish | Subscribe |
|---|---|---|
| Speaker of room `R` (browser console or the `teacher` / `slides` stand-ins) | `talk/R/teacher`, `talk/R/slides` | `talk/R/**` |
| Agents of room `R` | `talk/R/agents/**` | `talk/R/**` |
| Agents of any room (the VM's live agents) | `talk/*/agents/**` | `talk/**` |
| Looper of demo room `R` (replays the lecture and every agent track) | `talk/R/teacher`, `talk/R/agents/**` | `talk/R/**` |
| Viewers | nothing, no token | `talk/**` (anonymous) |

```bash
docker run --rm -v ./agents/data/keys:/keys talk-tracks-auth:0.14.8 auth sign --key /keys/private.jwk --publish 'talk/dev/agents/**' --subscribe 'talk/dev/**' --expires 1793200000
docker run --rm -v ./agents/data/keys:/keys talk-tracks-auth:0.14.8 auth sign --key /keys/private.jwk --publish talk/dev/teacher --publish talk/dev/slides --subscribe 'talk/dev/**' --expires 1793200000
```

Agents that serve any room (`--rooms '*'`, [lazy agents](lazy-agents.md)) need one token for the agent paths of
every room. `*` matches one path segment, so `--publish 'talk/*/agents/**'` covers the agents of any room and no
speaker path (checked on 2026-10-28: with it, `talk/judge-a/agents/captions/1` was announced and
`talk/judge-a/teacher` refused as unauthorized):

```bash
docker run --rm -v ./agents/data/keys:/keys talk-tracks-auth:0.14.8 auth sign --key /keys/private.jwk --publish 'talk/*/agents/**' --subscribe 'talk/**' --expires 1793200000
```

The demo room's looper publishes agent paths too: the live agents never serve it (`TT_ROOMS_EXCLUDE`).

Agents take the token from `--token` or `TT_TOKEN`. Browsers add it to the relay URL as `?jwt=<token>`; a token in a
URL can show up in proxy logs, so give it a short expiry.

## Judge tokens

Judges get speaker tokens minted in a batch (decision 0008): each token opens a fresh room `judge-<hex>`, each room
has a spend cap ($2 by default), and the whole batch has a total cap set at minting. On the VM, from the repo root:

```bash
sh deploy/mint-judge-tokens.sh 5 6 $(date -d "2026-11-20" +%s)        # 5 rooms, $2 each, $6 in all, expiring Nov 20
sh deploy/mint-judge-tokens.sh 5 6 $(date -d "2026-11-20" +%s) 1.5    # the same at $1.50 a room
```

It signs each token with `~/tt-keys/private.jwk` (publish `talk/<room>/teacher` and `talk/<room>/slides`, subscribe
`talk/<room>/**`), writes the batch's caps to `~/tt-data/caps/judges-<time>.json`, and the rooms with their links
(`https://<host>/talk/<room>?token=<token>`) to `~/tt-keys/judges-<time>.txt` (mode 600). Copy the links into the
submission notes from there; they never go to the terminal or the repo. Set `TT_HOST` for full links.

The live agents serve every room a speaker opens, so a judge's room gets its agents as soon as the judge goes on
air. They read the caps file when the room opens, and the spend ledger holds the room to its cap and the batch to
its total; past either, the agent stops paying and its track says so ([lazy agents](lazy-agents.md#spend-caps)).
The worst case is known in advance: the batch's total cap (at most rooms × room cap), all of it under the overall
ceiling. To end a batch early, set its `total_usd` in the caps file to 0 and restart the live agents (they read
caps when a room opens).

## Run with tokens locally

```bash
export TT_AGENT_TOKEN=$(cat agents/data/keys/agent-dev.jwt) TT_SPEAKER_TOKEN=$(cat agents/data/keys/speaker-dev.jwt)
docker compose -f deploy/compose.local.yml -f deploy/compose.auth.yml up -d relay auth captions translate-tr
docker compose -f deploy/compose.local.yml -f deploy/compose.auth.yml --profile dev up -d teacher watch
```

For a demo room, `generate` takes `TT_SPEAKER_TOKEN` (signed for the generation room) and `looper` takes
`TT_LOOPER_TOKEN`.

The auth server starts just after the relay; a session that arrives in that moment is refused (the relay answers 502).
Agents restart by themselves; restart a stand-in that started too early.

Checked on 2026-10-27: with these tokens the stack runs as in fake mode, and `watch` subscribes with no token. A
session with no token, an agent token publishing `talk/dev/teacher`, and a token signed with another key are all
refused (`announce ... unauthorized` for the first two, the session closed for the third). The browser viewer
watches `/watch/dev` and a looped `/watch/demo` (video, audio and every agent track) with no token, and the whole
demo pipeline (prepare, generate, loop) runs with the tokens above.
