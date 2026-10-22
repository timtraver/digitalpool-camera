#!/usr/bin/env bash
# build-ladspa.sh — build the background-music filter for this machine's
# architecture and stage it under vendor/ladspa/<arch>/ for committing.
#
# Run this on a box of the architecture you need (an N97 for x86_64, an RK3588
# for aarch64), then commit the resulting vendor/ladspa/<arch>/dp_percussive.so.
# migrations/0020-audio-music-filter.sh installs it fleet-wide from there, so a
# device never compiles anything.
#
#   ./audio/build-ladspa.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$HERE/.." && pwd)"
ARCH="$(uname -m)"
OUT_DIR="$REPO_DIR/vendor/ladspa/$ARCH"

if [ ! -f /usr/include/ladspa.h ]; then
  echo "ladspa.h not found — installing the LADSPA SDK headers…"
  sudo apt-get update -qq
  sudo apt-get install -y ladspa-sdk
fi

mkdir -p "$OUT_DIR"
echo "Building dp_percussive.so for $ARCH …"
# -ffast-math is deliberately NOT used: the mask is a ratio of squares with a
# small epsilon, and letting the compiler reassociate that is how a filter
# starts producing NaNs on one architecture and not another.
cc -O2 -fPIC -shared -Wall -Wextra \
   -o "$OUT_DIR/dp_percussive.so" \
   "$HERE/dp_percussive_ladspa.c" "$HERE/dp_percussive.c" -lm

echo
echo "Built: $OUT_DIR/dp_percussive.so"
echo "Check it loads:   LADSPA_PATH=$OUT_DIR analyseplugin dp_percussive.so"
echo "Check ffmpeg sees it: LADSPA_PATH=$OUT_DIR ffmpeg -f lavfi -i anullsrc -af ladspa=f=dp_percussive -t 1 -f null -"
echo "Commit vendor/ladspa/$ARCH/ — migrations/0020-audio-music-filter.sh installs it for $ARCH."
