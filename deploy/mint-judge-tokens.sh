#!/bin/sh
# Mint speaker tokens for judges (decision 0008, wiki/howto/tokens.md): one fresh room per token, each room capped at
# ROOM_USD (default 2), and every room of this batch together capped at TOTAL_USD.
#
# Usage, on the VM from the repo root:   sh deploy/mint-judge-tokens.sh COUNT TOTAL_USD EXPIRES [ROOM_USD]
#   EXPIRES is a unix time: the end of the judging window (a token is refused from then on).
# Settings: TT_KEYS (folder with private.jwk, default ~/tt-keys), TT_DATA (default ~/tt-data), TT_HOST (for the links).
# Writes the batch's caps to $TT_DATA/caps/<batch>.json, which the live agents read when a judge's room opens, and
# the rooms, tokens and links to $TT_KEYS/<batch>.txt (mode 600). Tokens never go to stdout or into the repo.
set -eu

[ $# -ge 3 ] || { sed -n '5,6p' "$0"; exit 2; }
count=$1 total=$2 expires=$3 room_usd=${4:-2}
keys=${TT_KEYS:-$HOME/tt-keys}
data=${TT_DATA:-$HOME/tt-data}
host=${TT_HOST:-HOST}
batch=judges-$(date +%Y%m%d-%H%M%S)

[ -f "$keys/private.jwk" ] || { echo "no $keys/private.jwk" >&2; exit 1; }
mkdir -p "$data/caps"
umask 077
out="$keys/$batch.txt"
rooms=""
i=0
while [ "$i" -lt "$count" ]; do
  room=judge-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
  token=$(docker run --rm -u "$(id -u):$(id -g)" -v "$keys:/keys:ro" talk-tracks-auth:0.14.8 auth sign \
    --key /keys/private.jwk --publish "talk/$room/teacher" --publish "talk/$room/slides" \
    --subscribe "talk/$room/**" --expires "$expires")
  echo "$room https://$host/talk/$room?token=$token" >>"$out"
  rooms="$rooms${rooms:+, }\"$room\""
  i=$((i + 1))
done

umask 022
printf '{"group": "%s", "room_usd": %s, "total_usd": %s, "rooms": [%s]}\n' \
  "$batch" "$room_usd" "$total" "$rooms" >"$data/caps/$batch.json"
echo "$count rooms of batch $batch: \$$room_usd each, \$$total in all, until $(date -d "@$expires" 2>/dev/null || echo "$expires")"
echo "caps:  $data/caps/$batch.json"
echo "links: $out"
