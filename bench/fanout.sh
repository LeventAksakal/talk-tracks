#!/bin/sh
# Lightweight fan-out benchmark: bring up servers and source, measure server CPU, memory, and egress across
# N = 1, 10, 100 concurrent viewers, then stop them all again.
#
# Usage: sh bench/fanout.sh LABEL [fanout options]
#   sh bench/fanout.sh loopback
#   sh bench/fanout.sh vm-fanout --duration 20
# Results: bench/results/LABEL.fanout.jsonl
set -eu
cd "$(dirname "$0")"
[ $# -ge 1 ] || { echo "usage: sh bench/fanout.sh LABEL [fanout options]" >&2; exit 2; }
label=$1
shift
export BENCH_LABEL=$label
compose="docker compose -f compose.yml"

stop() {
  $compose stop source textpub mediamtx relay
}
trap stop EXIT

$compose up -d relay mediamtx source textpub
echo "waiting 10 s for the source to reach both servers"
sleep 10
$compose --profile fanout run --rm fanout --label "$label" "$@"
