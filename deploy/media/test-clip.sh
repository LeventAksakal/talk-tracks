#!/bin/sh
# A synthetic lecture, generated here (no downloaded media): ffmpeg's test pattern with a running clock burnt in, and
# a 440 Hz tone that beeps once a second, already in the looper's format. Usage: test-clip OUT.mp4 [SECONDS]
set -eu
out=$1
seconds=${2:-60}
mkdir -p "$(dirname "$out")"
exec ffmpeg -hide_banner -loglevel warning -y \
  -f lavfi -i "testsrc=size=1280x720:rate=25:duration=$seconds" \
  -f lavfi -i "sine=frequency=440:beep_factor=4:sample_rate=48000:duration=$seconds" \
  -vf "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='%{pts\:hms}':x=40:y=40:fontsize=64:fontcolor=white:box=1:boxcolor=black@0.6" \
  -c:v libx264 -preset veryfast -profile:v high -pix_fmt yuv420p \
  -bf 0 -force_key_frames "expr:gte(t,n_forced*2)" -sc_threshold 0 -b:v 1000k \
  -c:a libopus -b:a 48k -ar 48000 -ac 1 -frame_duration 20 \
  -movflags +faststart "$out"
