#!/bin/sh
# The two lectures the public demo rooms loop (ticket 0001), downloaded once from media.ccc.de, trimmed and prepared
# as data/demo/<lecture>/lecture.mp4 (wiki/howto/demo-rooms.md). Both are CC BY-SA 4.0; README.md credits them.
#
# Usage, from the repo root:   sh deploy/media/demo-lectures.sh [virus] [dataviz]      (default: both)
# COMPOSE as in deploy/demo-room.sh (default "docker compose -f deploy/compose.local.yml"). Needs curl and sha256sum.
#
# The cuts, in seconds of the source file (its SHA-256 is checked, so the timestamps always mean the same frames):
#   start  12.60 in both: the EMF title card, sponsor logos and speaker card end there with a hard cut, and speech
#          begins just after (13.0 s in virus, 12.7 s in dataviz). The jingle is under the cards, so it goes too.
#   virus end 1032.8 (17:12.8): the middle of a 3.6 s pause that closes the part on how viruses get in and copy
#          themselves; the "Taking Over" section slide follows at 1033.9 and runs to the end of the talk.
#   dataviz end 1151.4 (19:11.4): the speaker's thanks are over (speech ends at 1150.4) over the "Thanks for
#          listening" clip; then room sound, and the EMF licence card at 1157.6.
# Found with ffmpeg silencedetect and a 100 ms loudness envelope (pauses), scene detection and sampled frames (cards).
set -eu
cd "$(dirname "$0")/../.."
compose=${COMPOSE:-docker compose -f deploy/compose.local.yml}
cdn=https://cdn.media.ccc.de/events/emf/2026/h264-hd

# name | file on the CDN (1080p H.264) | SHA-256 | start | end
lectures="
virus|emf2026-14901-eng-You_Are_Part_Virus_How_Biological_Viruses_Hack_Cells_hd.mp4|19a27960d5e92fa793c776a0e3b3be97d7d050a8e72017814df90ebd35ce6fcd|12.60|1032.8
dataviz|emf2026-24101-eng-Data_Visualisation_The_Good_The_Bad_The_Ugly_and_the_Beautiful_hd.mp4|e21b1d1ba90283d172b037ec4cbfcadb4e49bfcb76344c2b8ba125bfef0592ad|12.60|1151.4
"

wanted=${*:-virus dataviz}
for want in $wanted; do
  line=$(printf '%s\n' "$lectures" | grep "^$want|") || { echo "unknown lecture: $want" >&2; exit 1; }
  IFS='|' read -r name file sha start end <<EOF
$line
EOF
  dir=data/demo/$name
  mkdir -p "$dir"
  if [ ! -f "$dir/source.mp4" ]; then
    echo "== $name: download $file"
    curl -fL --retry 3 -o "$dir/source.mp4.part" "$cdn/$file"
    mv "$dir/source.mp4.part" "$dir/source.mp4"
  fi
  echo "$sha  $dir/source.mp4" | sha256sum -c -
  echo "== $name: trim $start-$end s and prepare $dir/lecture.mp4"
  $compose --profile demo run --rm media "prepare-lecture /data/$name/source.mp4 /data/$name/lecture.mp4 $start $end"
done
