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
docker compose -f bench/compose.yml --profile run --profile netem build
```

Then measure with [run.sh](run.sh). It starts the servers, the source and the text publisher, waits 10 s for the
source to reach both servers, runs the viewer, and stops them all again on the way out, even after a failure. **Never
leave the source running between measurements:** it encodes live and costs about two CPU cores.

```bash
sh bench/run.sh loopback --proto moq,moq-ws,moq-text,webrtc,hls --runs 20 --seconds 30
```

Each join is one fresh browser context, and the runner goes round-robin over the protocols, so drift over time hits
every protocol alike. Results append to `bench/results/<label>.jsonl`, one line per join. Summarise them:

```bash
python bench/analyze.py bench/results/loopback.jsonl
```

### Under emulated network conditions

Set `BENCH_DELAY_MS` and `BENCH_LOSS_PCT`. `run.sh` then also starts the netem helpers, which add the delay and loss
to what the relay and MediaMTX send to the viewer. The runner records the values in each line, and the helpers'
rules go away when they stop.

```bash
BENCH_DELAY_MS=40 sh bench/run.sh rtt40 --proto moq,moq-ws,webrtc,hls --runs 10 --seconds 30
BENCH_DELAY_MS=40 BENCH_LOSS_PCT=2 sh bench/run.sh loss2 --proto moq,moq-ws,webrtc,hls --runs 10 --seconds 30
```

### Settings

| Setting | Default | Where |
|---|---|---|
| `--proto` | `moq,hls,webrtc` | runner: any of `moq`, `moq-ws` (WebTransport removed, as in Safari), `moq-text` (the text track alone), `hls`, `webrtc` |
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
