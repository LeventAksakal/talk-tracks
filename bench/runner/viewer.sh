#!/bin/sh
# The viewer container's entrypoint: a PulseAudio daemon with a null sink (a real-time audio clock, see
# Dockerfile.viewer), then the runner with the arguments given.
set -eu
pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit --log-target=stderr --log-level=error \
  --load="module-null-sink sink_name=bench" --load="module-native-protocol-unix" 2>/dev/null || true
pactl set-default-sink bench 2>/dev/null || echo "viewer: no PulseAudio, Chrome uses its fallback audio output" >&2
exec node run.mjs "$@"
