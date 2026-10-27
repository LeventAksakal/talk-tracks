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

Try a failover: `docker kill talk-tracks-captions-1`, then
`docker compose -f deploy/compose.local.yml up -d captions`. The translation and chapters agents follow the new
captions instance by themselves (the newest instance always wins).

Stop everything with `docker compose -f deploy/compose.local.yml --profile dev down`.

## One agent against the Meta API

Drop `--fake` and pass the key through from your environment (`-e META_API_KEY` or `-e MODEL_API_KEY`, whichever
you have set; never write it to a file):

```bash
docker compose -f deploy/compose.local.yml run --rm -e META_API_KEY captions captions --insecure
```

Spend goes to the shared ledger (`TT_LEDGER`, default `data/ledger.jsonl`) and stops at `TT_SPEND_CEILING_USD`
(default 100).

## Checks

From `agents/`: `uv run ruff format --check .`, `uv run ruff check .`, `uv run pyright`, `uv run pytest -q`.
