# Transport benchmark

Measures Talk Tracks' MoQ against LL-HLS and WebRTC with one source on one host. Method, capability matrix and
results: [wiki/benchmark.md](../wiki/benchmark.md). Needs Docker only; no API keys, no Meta calls.

| Service | What it is |
|---|---|
| `relay` | moq-relay 0.17.8, the relay Talk Tracks deploys (built from `deploy/Dockerfile.relay`), open to all |
| `mediamtx` | MediaMTX 1.21.3: LL-HLS on :8888 and WebRTC/WHEP on :8889 ([mediamtx.yml](mediamtx.yml)) |
| `source` | [source.sh](source.sh): one ffmpeg encode with a wall-clock barcode in every frame, teed to `moq import ts` (broadcast `bench/live`) and to MediaMTX over RTSP (path `bench`). Image: moq-cli 0.14.8 with ffmpeg (`deploy/Dockerfile.moq-cli`) |
| `textpub` | [textpub.py](textpub.py): a JSON track `bench/text` / `state` with its publish time, 4 a second, through the agents' MoQ code (the agents image already built, never rebuilt here) |
| `historypub` | [historypub.py](historypub.py): a history track as decision 0012 shapes AI tracks, `bench/history` / `items`, in 4 s slices (carry-in, 16 items, End of Group), and the origin of its own past by FETCH: 300 archive slices the relay has never seen, then the live ones. Uses `fix_end` from the MoQT spikes |
| `viewer` | [Dockerfile.viewer](Dockerfile.viewer): the measuring page ([web/](web/)) and the Playwright runner ([runner/run.mjs](runner/run.mjs)) driving headless Google Chrome |
| `fanout` | [fanout.py](fanout.py): lightweight subscriber load harness measuring server CPU (% of 1 core), RSS memory (MiB), and egress (total Mbit/s and per-viewer kbit/s) at N = 1, 10, 100 viewers across `moq-full`, `moq-captions`, `hls`, and `webrtc` (profile `fanout`) |
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
every protocol alike. Results append to `bench/results/<label>.jsonl`, one line per join; the history publisher
appends each FETCH it serves to `bench/results/<label>.origin.log`, which the analysis reads beside it to tell
origin-served fetches from cached ones. Summarise them:

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

### Server fan-out at scale (1, 10, 100 viewers)

Measure server resource utilization under concurrent subscriber load with [fanout.sh](fanout.sh) (profile `fanout`):

```bash
sh bench/fanout.sh loopback --proto moq-full,moq-captions,webrtc,hls --concurrency 1,10,100 --duration 15
```

Protocol clients are lightweight (draining network packets without video decoding/rendering) so load generator CPU
does not swamp server CPU on a single VM. Measures server CPU (% of 1 core), RSS memory (MiB), and TX egress (total
Mbit/s and per-viewer kbit/s). Results append to `bench/results/<label>.fanout.jsonl`.

### Settings

| Setting | Default | Where |
|---|---|---|
| `--proto` | `moq,hls,webrtc` | runner: any of `moq`, `moq-ws` (WebTransport removed, as in Safari), `moq-text` (the text track alone), `fetch` (the history track: live, then `fetchGroup` of slices uncached, cached and recent; `--query fetches=N` rounds), `hls`, `webrtc` |
| `--runs`, `--seconds` | 10, 20 | runner: joins per protocol, seconds measured per join after its first frame |
| `--delay` | 500 | runner: @moq/watch's delay in ms (the viewer's setting in `web/src/viewer/TeacherMedia.tsx`) |
| `--no-isolation` | off | runner: serve the page without COOP/COEP (production sends them, see `deploy/Caddyfile`) |
| `--query` | none | runner: extra page parameters for experiments, for example `muted=1` |
| `BENCH_GOP_S`, `BENCH_BITRATE`, `BENCH_SIZE` | 2, 1000k, 1280x720 | source: keyframe interval, video bitrate, frame size |
| `BENCH_TEXT_HZ`, `BENCH_AGENTS_IMAGE` | 4, `talk-tracks-agents:dev` | textpub: text objects per second, the image it runs in |
| `BENCH_DELAY_MS`, `BENCH_LOSS_PCT` | 0, 0 | netem helpers and runner label |
| `--concurrency`, `--duration` | `1,10,100`, 15 | fanout: viewer counts, measurement window in seconds |

## What it costs

No API calls and no egress: everything stays on one Docker network on one host, and no port is published. While a
measurement runs, the source takes about 1.6 CPU cores (x264 at 720p25), the viewer about 1.2 (Chrome decoding in
software), and the relay and MediaMTX about 0.1 together, plus about 1.5 GB of memory in all. Between measurements
nothing runs. Disk: about 3 GB of images, most of it the Playwright and Chrome image.

## The VM runs

The published results come from the VM, with labels starting `vm-` (the only results kept in git). From the repo
root on the VM, once this branch is merged:

```bash
docker compose -f bench/compose.yml --profile run --profile netem build     # ~15 min if moq-cli is not built yet
sh bench/run.sh vm-loopback --proto moq,moq-ws,moq-text,webrtc,hls --runs 15 --seconds 30    # ~45 min
BENCH_DELAY_MS=40 sh bench/run.sh vm-rtt40 --proto moq,moq-ws,webrtc,hls --runs 10 --seconds 30    # ~25 min
BENCH_DELAY_MS=40 BENCH_LOSS_PCT=2 sh bench/run.sh vm-loss2 --proto moq,moq-ws,webrtc,hls --runs 10 --seconds 30    # ~25 min
BENCH_DELAY_MS=40 BENCH_LOSS_PCT=5 sh bench/run.sh vm-loss5 --proto moq,moq-ws,webrtc,hls --runs 10 --seconds 30    # ~25 min
sh bench/run.sh vm-moq-delay100 --proto moq,moq-ws --runs 10 --seconds 30 --delay 100    # ~12 min
sh bench/run.sh vm-fetch --proto fetch --runs 15 --query fetches=10    # ~6 min
BENCH_DELAY_MS=40 sh bench/run.sh vm-fetch-rtt40 --proto fetch --runs 10 --query fetches=10    # ~4 min
sh bench/fanout.sh vm-fanout --proto moq-full,moq-captions,webrtc,hls --concurrency 1,10,100 --duration 15    # ~4 min
python3 bench/analyze.py bench/results/vm-*.jsonl --json bench/results/vm-summary.json
```

About 2.8 hours in all. Then bring back `bench/results/vm-*` (the JSON lines and the summary). The last run shows
what MoQ does with a tighter player setting than the viewer's 500 ms.

Before starting, check these:

- **CPU.** A measurement takes about three cores. On a VM with fewer than four vCPUs the numbers would be distorted
  and the demo rooms would slow down, so run when no one is watching, or on a larger machine of the same kind.
- **Network.** The compose network uses the subnet 172.29.0.0/24; if it collides with one on the VM,
  `docker compose` refuses to start. Change it, and the viewer's address (`172.29.0.50`, also in the netem helpers),
  in `compose.yml`.
- **Images.** It builds `talk-tracks-relay:0.17.8` and `talk-tracks-moq-cli:0.14.8` from their pinned Dockerfiles in
  `deploy/` (the same content under the same names, so images already on the VM are reused) and
  `talk-tracks-bench-viewer:dev` from `bench/`, and pulls `bluenviron/mediamtx:1.21.3`. The text publisher runs in
  the agents image already on the host (`BENCH_AGENTS_IMAGE`, default `talk-tracks-agents:dev`) and never builds it.
  Nothing in the production compose project is touched (this one is `talk-tracks-bench`).

## Stop

`run.sh` stops everything after each measurement. To remove the containers and the network as well:

```bash
docker compose -f bench/compose.yml --profile netem --profile run down
```
