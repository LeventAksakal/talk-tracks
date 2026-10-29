# Run the agents locally

Needs Docker. The agents' MoQ library (aiomoqt) has no Windows wheels, so agents always run in containers; the
Python checks run natively from `agents/` with `uv`.

## A relay and every agent, in fake mode

Fake mode uses scripted speech recognition and a fake model: no Meta API calls, no cost.

```bash
docker compose -f deploy/compose.local.yml up -d --build
docker compose -f deploy/compose.local.yml --profile dev up -d teacher watch
docker compose -f deploy/compose.local.yml logs -f watch
```

`teacher` stands in for the speaker's browser (a looping tone on `talk/dev/teacher`, track `audio`); `watch` stands in
for a viewer and prints each agent snapshot as it arrives. The room is `dev`; set `TT_ROOM` to change it.

Slides come from a second stand-in that shows each image for 20 s, in a loop, on `talk/dev/slides`, track `frames`.
Put the images under `agents/data/` and mount it:

```bash
docker compose -f deploy/compose.local.yml --profile dev run -d -v ./agents/data:/app/data watch slides --insecure --image data/slide1.png
```

The describe agent pays once per distinct image: a slide shown again reuses its description.

Try a failover: `docker kill talk-tracks-captions-1`, then
`docker compose -f deploy/compose.local.yml up -d captions`. The translation and chapters agents follow the new
captions instance by themselves (the newest instance always wins). The restarted captions agent resumes its lines
and line ids from `data/state/` inside its container, so nothing is translated twice.

Stop everything with `docker compose -f deploy/compose.local.yml --profile dev down`.

This relay lets anyone publish, which is fine on a laptop only. To run it as deployed, with signed tokens for
publishers and open watching, add the `deploy/compose.auth.yml` overlay ([tokens.md](tokens.md)).

## One agent against the Meta API

Drop `--fake` and pass the key through from your environment (`-e META_API_KEY` or `-e MODEL_API_KEY`, whichever
you have set; never write it to a file):

```bash
docker compose -f deploy/compose.local.yml run --rm -e META_API_KEY captions captions --insecure
```

Spend goes to the shared ledger (`TT_LEDGER`, default `data/ledger.jsonl`) and stops at `TT_SPEND_CEILING_USD`
(default 100).

## A looping demo room

A recorded lecture replayed as a live room, with no model running: see [demo-rooms](demo-rooms.md). The public VM
runs the same stack: see [deploy](deploy.md).

## Checks

From `agents/`: `uv run ruff format --check .`, `uv run ruff check .`, `uv run pyright`, `uv run pytest -q`.

Enable the pre-commit hook once per clone (secret scan plus fast `ruff`, `eslint` and `prettier` on staged files):
```bash
git config core.hooksPath .githooks
```

The speaker console and viewer against this relay: [web.md](web.md).
