#!/bin/sh
# Turn any lecture video into what the looper publishes: MP4 with H.264 (no B-frames, a keyframe every 2 s, at most
# 720p) and Opus (48 kHz mono, 20 ms packets). Usage: prepare-lecture IN OUT.mp4
set -eu
in=$1
out=$2
mkdir -p "$(dirname "$out")"
exec ffmpeg -hide_banner -loglevel warning -y -i "$in" \
  -map 0:v:0 -map 0:a:0 \
  -c:v libx264 -preset veryfast -profile:v high -pix_fmt yuv420p -vf "scale=-2:'min(720,ih)'" \
  -bf 0 -force_key_frames "expr:gte(t,n_forced*2)" -sc_threshold 0 -b:v 1500k -maxrate 2000k -bufsize 3000k \
  -c:a libopus -b:a 64k -ar 48000 -ac 1 -frame_duration 20 \
  -movflags +faststart "$out"
