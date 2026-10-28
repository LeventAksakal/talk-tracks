#!/bin/sh
# Network emulation for one server, run in its network namespace (the netem-* services in bench/compose.yml): adds
# BENCH_DELAY_MS of delay and BENCH_LOSS_PCT of random loss to what the server sends to the viewer, and to nothing
# else, so the source's upload stays clean. The delay is one-way, so the viewer's round trip grows by the same amount.
set -eu
dev=eth0
tc qdisc del dev $dev root 2>/dev/null || true
trap 'tc qdisc del dev $dev root 2>/dev/null || true; exit 0' TERM INT

if [ "${BENCH_DELAY_MS:-0}" = 0 ] && [ "${BENCH_LOSS_PCT:-0}" = 0 ]; then
  echo "netem: off"
else
  # Band 4 of a prio qdisc is reached only through the filter: traffic to the viewer.
  tc qdisc add dev $dev root handle 1: prio bands 4
  tc qdisc add dev $dev parent 1:4 handle 40: netem delay "${BENCH_DELAY_MS}ms" loss "${BENCH_LOSS_PCT}%"
  tc filter add dev $dev parent 1:0 protocol ip u32 match ip dst "$BENCH_VIEWER_IP/32" flowid 1:4
  echo "netem: +${BENCH_DELAY_MS} ms, ${BENCH_LOSS_PCT} % loss towards $BENCH_VIEWER_IP"
fi
sleep infinity &
wait
