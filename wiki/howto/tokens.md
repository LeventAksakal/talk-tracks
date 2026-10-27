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
| Viewers | nothing, no token | `talk/**` (anonymous) |

```bash
docker run --rm -v ./agents/data/keys:/keys talk-tracks-auth:0.14.8 auth sign --key /keys/private.jwk --publish 'talk/dev/agents/**' --subscribe 'talk/dev/**' --expires 1793200000
docker run --rm -v ./agents/data/keys:/keys talk-tracks-auth:0.14.8 auth sign --key /keys/private.jwk --publish talk/dev/teacher --publish talk/dev/slides --subscribe 'talk/dev/**' --expires 1793200000
```

Agents take the token from `--token` or `TT_TOKEN`. Browsers add it to the relay URL as `?jwt=<token>`; a token in a
URL can show up in proxy logs, so give it a short expiry.

## Run with tokens locally

```bash
export TT_AGENT_TOKEN=$(cat agents/data/keys/agent-dev.jwt) TT_SPEAKER_TOKEN=$(cat agents/data/keys/speaker-dev.jwt)
docker compose -f deploy/compose.local.yml -f deploy/compose.auth.yml up -d relay auth captions translate-tr
docker compose -f deploy/compose.local.yml -f deploy/compose.auth.yml --profile dev up -d teacher watch
```

Checked on 2026-10-27: with these tokens the stack runs as in fake mode, and `watch` subscribes with no token. A
session with no token, an agent token publishing `talk/dev/teacher`, and a token signed with another key are all
refused (`announce ... unauthorized` for the first two, the session closed for the third).
