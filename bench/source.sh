#!/bin/sh
# The benchmark's live source: one encode, teed at the same moment to MoQ and to MediaMTX.
#
# Every frame carries the wall-clock time it was made, in ms modulo 2^32, as a 32-block barcode across the top 80 rows
# (two rows of 16 blocks, 80x40 px each, bit 0 top left; white = 1). The viewer reads the blocks back and subtracts:
# glass-to-glass latency without the camera, encode included. A running clock is drawn below it for people.
#
# Encoding as the demo rooms do (deploy/media/test-clip.sh): H.264 without B-frames, a keyframe every $BENCH_GOP_S
# seconds, Opus 48 kHz mono in 20 ms packets, 1280x720 at 25 fps. x264 runs with zerolatency (no lookahead), so the
# encoder adds no frames of delay for anyone.
#   - MPEG-TS on stdout into `moq import ts`: broadcast `bench/live` on the relay (a hang broadcast, as @moq/watch plays)
#   - RTSP over TCP into MediaMTX, path `bench`, which serves it as LL-HLS and WebRTC
set -eu
gop=${BENCH_GOP_S:-2}
rate=${BENCH_BITRATE:-1000k}

boxes=""
i=0
while [ $i -lt 32 ]; do
  boxes="$boxes,drawbox=x=$((i % 16 * 80)):y=$((i / 16 * 40)):w=80:h=40:color=white:t=fill"
  boxes="$boxes:enable='mod(floor(t*1000/pow(2\\,$i))\\,2)'"
  i=$((i + 1))
done

# Timestamps are set to the wall clock (µs time base) for the barcode, then rebased to start at zero for the encoder.
video="settb=1/1000000,setpts='RTCTIME/(TB*1000000)',drawbox=x=0:y=0:w=1280:h=80:color=black:t=fill$boxes"
video="$video,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontsize=48:fontcolor=white"
video="$video:box=1:boxcolor=black@0.6:x=40:y=120:text='%{localtime\\:%T} UTC'"
video="$video,setpts=PTS-STARTPTS"

while true; do
  echo "source: encoding (GOP ${gop}s, ${rate})" >&2
  ffmpeg -hide_banner -loglevel warning -nostdin \
    -re -f lavfi -i "testsrc2=size=1280x720:rate=25" \
    -re -f lavfi -i "sine=frequency=440:beep_factor=4:sample_rate=48000" \
    -filter_complex "[0:v]$video[v]" -map "[v]" -map 1:a \
    -c:v libx264 -preset veryfast -tune zerolatency -profile:v high -pix_fmt yuv420p -bf 0 \
    -g $((gop * 25)) -keyint_min $((gop * 25)) -sc_threshold 0 -b:v "$rate" -maxrate "$rate" -bufsize "$rate" \
    -c:a libopus -b:a 48k -ar 48000 -ac 1 -frame_duration 20 -application lowdelay \
    -f tee -use_fifo 1 \
    "[f=mpegts:max_delay=0:flush_packets=1:onfail=ignore]pipe\\:1|[f=rtsp:rtsp_transport=tcp:onfail=ignore]rtsp\\://mediamtx\\:8554/bench" \
    | moq --log-level warn --connect http://relay:4443/ import --broadcast bench/live ts \
    || true
  echo "source: stopped, restarting in 2 s" >&2
  sleep 2
done
