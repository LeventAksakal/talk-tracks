#!/bin/sh
# Make a looping demo room from a lecture, end to end (wiki/howto/demo-rooms.md):
#   1. prepare   the lecture as data/demo/$TT_LECTURE/lecture.mp4 (from $1, or a synthetic test clip without $1)
#   2. generate  start fresh agents in the private room $TT_ROOM, play the lecture once, record their tracks
#   3. loop      stop those agents and serve the recording, looping, in the room $TT_DEMO_ROOM
#
# Usage, from the repo root:   sh deploy/demo-room.sh [path/to/lecture-video]
# Settings: TT_LECTURE (default test), TT_ROOM (default gen-$TT_LECTURE), TT_DEMO_ROOM (default demo),
# COMPOSE (default "docker compose -f deploy/compose.local.yml"; add -p NAME or more -f files here).
# The agents in compose.local.yml run with --fake; for real tracks run them against the Meta API instead (see the
# how-to). The relay must already be up: $COMPOSE up -d relay
set -eu
cd "$(dirname "$0")/.."

lecture=${TT_LECTURE:-test}
export TT_LECTURE=$lecture
export TT_ROOM=${TT_ROOM:-gen-$lecture}
export TT_DEMO_ROOM=${TT_DEMO_ROOM:-demo}
compose=${COMPOSE:-docker compose -f deploy/compose.local.yml}
agents="captions translate-tr describe chapters"

echo "== prepare data/demo/$lecture/lecture.mp4"
mkdir -p "data/demo/$lecture"
if [ $# -ge 1 ]; then
  cp "$1" "data/demo/$lecture/source"
  $compose --profile demo run --rm media "prepare-lecture /data/$lecture/source /data/$lecture/lecture.mp4"
  rm "data/demo/$lecture/source"
else
  $compose --profile demo run --rm media "test-clip /data/$lecture/lecture.mp4 60"
fi

echo "== generate: fresh agents in room $TT_ROOM, the lecture played once, their tracks recorded"
$compose up -d --force-recreate $agents
$compose --profile demo run --rm generate
$compose stop $agents

echo "== loop: room $TT_DEMO_ROOM replays data/demo/$lecture"
$compose --profile demo up -d --force-recreate looper
echo "watch it: TT_ROOM=$TT_DEMO_ROOM $compose --profile dev run --rm watch"
