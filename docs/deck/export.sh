#!/usr/bin/env bash
# Export docs/deck/deck.html to talk-tracks-moqt.pdf and png/NN-<name>.png (1920x1080) with headless Chrome.
# Muted, throwaway profile, closed when done. Usage: bash docs/deck/export.sh [path-to-chrome]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
chrome="${1:-${CHROME:-/c/Program Files/Google/Chrome/Application/chrome.exe}}"
profile="$(mktemp -d)"
trap 'rm -rf "$profile"' EXIT
url_base="file:///$(cd "$here" && pwd -W 2>/dev/null || pwd)/deck.html"
flags=(--headless=new --mute-audio --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check
  --user-data-dir="$profile" --force-device-scale-factor=1 --virtual-time-budget=4000)

"$chrome" "${flags[@]}" --no-pdf-header-footer --print-to-pdf="$here/talk-tracks-moqt.pdf" "$url_base" 2>/dev/null

mkdir -p "$here/png"
names=$(grep -o 'id="s[0-9]*" data-name="[a-z-]*"' "$here/deck.html" | sed -E 's/id="s([0-9]+)" data-name="([a-z-]+)"/\1:\2/')
for pair in $names; do
  n="${pair%%:*}"; name="${pair#*:}"
  out="$here/png/$(printf '%02d' "$n")-$name.png"
  "$chrome" "${flags[@]}" --window-size=1920,1080 --screenshot="$out" "$url_base#$n" 2>/dev/null
  echo "$out"
done
