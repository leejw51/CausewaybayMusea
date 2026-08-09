#!/usr/bin/env bash
# Generate real media to upload during testing. Needs ffmpeg.
#
#   ./fixtures.sh              # small photo + short video (a few MB)
#   ./fixtures.sh 500          # also build a ~500 MB video for a throughput run
#
# Everything lands in ./fixtures, which is gitignored.

set -euo pipefail
cd "$(dirname "$0")"
OUT=fixtures
mkdir -p "$OUT"

if ! command -v ffmpeg >/dev/null; then
  echo "ffmpeg not found — install it (brew install ffmpeg) or drop your own files in $OUT/" >&2
  exit 1
fi

say() { printf '\033[2m·\033[0m %s\n' "$1"; }

if [ ! -f "$OUT/photo.jpg" ]; then
  say "photo.jpg — 1920x1080 test pattern"
  ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=1920x1080:rate=1" -frames:v 1 "$OUT/photo.jpg"
fi

if [ ! -f "$OUT/photo-tall.jpg" ]; then
  say "photo-tall.jpg — portrait, like a phone camera roll"
  ffmpeg -loglevel error -y -f lavfi -i "smptebars=size=1080x1920:rate=1" -frames:v 1 "$OUT/photo-tall.jpg"
fi

if [ ! -f "$OUT/clip.mp4" ]; then
  say "clip.mp4 — 6s 720p H.264, plays natively in Safari"
  ffmpeg -loglevel error -y \
    -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=6" \
    -f lavfi -i "sine=frequency=440:duration=6" \
    -c:v libx264 -pix_fmt yuv420p -preset veryfast -c:a aac -movflags +faststart \
    "$OUT/clip.mp4"
fi

if [ ! -f "$OUT/medium.mp4" ]; then
  # ~40 MB: big enough to span a dozen chunks, small enough for a fast UI run
  say "medium.mp4 — 20s 1080p, ~40 MB (pause/resume/offline test subject)"
  ffmpeg -loglevel error -y \
    -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=20" \
    -c:v libx264 -pix_fmt yuv420p -preset ultrafast \
    -b:v 16M -minrate 16M -maxrate 16M -bufsize 16M -movflags +faststart \
    "$OUT/medium.mp4"
fi

TARGET_MB="${1:-0}"
if [ "$TARGET_MB" != "0" ]; then
  BIG="$OUT/big-${TARGET_MB}mb.mp4"
  if [ ! -f "$BIG" ]; then
    # pick a bitrate that lands near the requested size over 60 seconds
    KBPS=$(( TARGET_MB * 8 * 1024 / 60 ))
    say "big-${TARGET_MB}mb.mp4 — 60s at ${KBPS}kbps (this takes a minute)"
    ffmpeg -loglevel error -y \
      -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=60" \
      -c:v libx264 -pix_fmt yuv420p -preset ultrafast \
      -b:v "${KBPS}k" -minrate "${KBPS}k" -maxrate "${KBPS}k" -bufsize "${KBPS}k" \
      -movflags +faststart "$BIG"
  fi
fi

echo
ls -lh "$OUT"
