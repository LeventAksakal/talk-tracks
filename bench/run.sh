#!/bin/sh
# One measurement, start to stop: bring up the servers, the source and the text publisher, measure, then stop them
# all again, whether the run succeeds or not. The source encodes live and costs about two CPU cores while it runs, so
# nothing is left running between measurements.
#
# Usage, from anywhere:   sh bench/run.sh LABEL [runner options]
#   sh bench/run.sh loopback --proto moq,moq-ws,moq-text,webrtc,hls --runs 20 --seconds 30
#   BENCH_DELAY_MS=40 sh bench/run.sh rtt40 --runs 10
#   BENCH_LOSS_PCT=2 sh bench/run.sh loss2 --runs 10
# Runner options: bench/runner/run.mjs. Results: bench/results/LABEL.jsonl.
set -eu
cd "$(dirname "$0")"
[ $# -ge 1 ] || { echo "usage: sh bench/run.sh LABEL [runner options]" >&2; exit 2; }
label=$1
shift
compose="docker compose -f compose.yml"
export BENCH_DELAY_MS=${BENCH_DELAY_MS:-0} BENCH_LOSS_PCT=${BENCH_LOSS_PCT:-0}

stop() {
  $compose --profile netem stop netem-relay netem-mediamtx >/dev/null 2>&1 || true
  $compose stop source textpub historypub mediamtx relay
}
trap stop EXIT

$compose up -d relay mediamtx source textpub historypub
if [ "$BENCH_DELAY_MS" != 0 ] || [ "$BENCH_LOSS_PCT" != 0 ]; then
  $compose --profile netem up -d --force-recreate netem-relay netem-mediamtx
fi
echo "waiting 10 s for the source to reach both servers"
sleep 10
$compose --profile run run --rm viewer --label "$label" "$@"
