# Transport benchmark

Measures Talk Tracks' MoQ against LL-HLS and WebRTC with one source on one host. Method, capability matrix and
results: [wiki/benchmark.md](../wiki/benchmark.md). Needs Docker only; no API keys, no Meta calls.

| Service | What it is |
|---|---|
| `relay` | moq-relay 0.17.8, the relay Talk Tracks deploys (built from `deploy/Dockerfile.relay`), open to all |
| `mediamtx` | MediaMTX 1.21.3: LL-HLS on :8888 and WebRTC/WHEP on :8889 ([mediamtx.yml](mediamtx.yml)) |
| `source` | [source.sh](source.sh): one ffmpeg encode with a wall-clock barcode in every frame, teed to `moq import ts` (broadcast `bench/live`) and to MediaMTX over RTSP (path `bench`). Image: moq-cli 0.14.8 with ffmpeg (`deploy/Dockerfile.moq-cli`) |
| `textpub` | [textpub.py](textpub.py): a JSON track `bench/text` / `state` with its publish time, 4 a second, through the agents' MoQ code (agents image) |
| `viewer` | [Dockerfile.viewer](Dockerfile.viewer): the measuring page ([web/](web/)) and the Playwright runner ([runner/run.mjs](runner/run.mjs)) driving headless Google Chrome |
| `netem-relay`, `netem-mediamtx` | [netem.sh](netem.sh) in each server's network namespace: delay and loss towards the viewer only (profile `netem`) |

## Run

From the repo root. The first build takes about 15 minutes (two Rust builds and the Chrome image).

```bash
docker compose -f bench/compose.yml build
docker compose -f bench/compose.yml up -d relay mediamtx source textpub
```

Wait about 10 s for the source to reach both servers, then measure. Each join is one fresh browser context; the
runner goes round-robin over the protocols so drift over time hits every protocol alike.

```bash
docker compose -f bench/compose.yml --profile run run --rm viewer --proto moq,moq-ws,webrtc,hls --runs 20 --seconds 30 --label loopback
```

Results append to `bench/results/<label>.jsonl`, one line per join. Summarise them:

```bash
python bench/analyze.py bench/results/loopback.jsonl
```

### Under emulated network conditions

Delay and loss apply to what the relay and MediaMTX send to the viewer. Start the netem helpers with the
condition, run with the same values (the runner records them in each line), then stop the helpers, which removes the
rules:

```bash
BENCH_DELAY_MS=40 BENCH_LOSS_PCT=0 docker compose -f bench/compose.yml --profile netem up -d --force-recreate netem-relay netem-mediamtx
BENCH_DELAY_MS=40 BENCH_LOSS_PCT=0 docker compose -f bench/compose.yml --profile run run --rm viewer --proto moq,moq-ws,webrtc,hls --runs 10 --seconds 30 --label rtt40
docker compose -f bench/compose.yml --profile netem stop netem-relay netem-mediamtx
```

### Settings

| Setting | Default | Where |
|---|---|---|
| `--proto` | `moq,hls,webrtc` | runner: any of `moq`, `moq-ws`, `hls`, `webrtc` |
| `--runs`, `--seconds` | 10, 20 | runner: joins per protocol, seconds measured per join after its first frame |
| `--delay` | 500 | runner: @moq/watch's delay in ms (the viewer's setting in `web/src/viewer/TeacherMedia.tsx`) |
| `--no-isolation` | off | runner: serve the page without COOP/COEP (production sends them, see `deploy/Caddyfile`) |
| `BENCH_GOP_S`, `BENCH_BITRATE` | 2, 1000k | source: keyframe interval and video bitrate |
| `BENCH_TEXT_HZ` | 4 | textpub: text objects per second |
| `BENCH_DELAY_MS`, `BENCH_LOSS_PCT` | 0, 0 | netem helpers and runner label |

## Stop

```bash
docker compose -f bench/compose.yml --profile netem --profile run down
```
