#!/usr/bin/env bash
# build-ffmpeg7-libs.sh — build the FFmpeg 7 shared libraries that NDI|HX decode
# needs, and stage them under vendor/ffmpeg7/<arch>/ for committing.
#
# Why: NDI's HX decoder dlopen()s libavcodec.so.61 / libavutil.so.59 (FFmpeg 7),
# which Ubuntu 24.04 does not provide (it ships FFmpeg 6 / .60).  We build the
# FFmpeg 7 libs once per architecture, commit them, and migrations/0002 installs
# them on the fleet into /usr/local/lib (alongside the system FFmpeg 6).
#
# Run ONCE on a machine of the target architecture (e.g. the N97 for x86_64, an
# RK3588 for aarch64), then commit the resulting vendor/ffmpeg7/<arch>/ files.
#
#   ./build-ffmpeg7-libs.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCH="$(uname -m)"                       # x86_64 | aarch64
BUILD_DIR="${1:-/tmp/ffmpeg7-build}"
OUT_DIR="$REPO_DIR/vendor/ffmpeg7/$ARCH"

echo "Building FFmpeg 7 shared libs for $ARCH (this takes ~10-15 min)..."
sudo apt-get install -y build-essential nasm pkg-config

rm -rf "$BUILD_DIR"
git clone --depth 1 --branch release/7.1 https://git.ffmpeg.org/ffmpeg.git "$BUILD_DIR"
cd "$BUILD_DIR"

# Default configure enables FFmpeg's native H.264/HEVC decoders (LGPL, no external
# deps) — which is all NDI|HX needs.  Shared libs only; no ffmpeg binary or docs.
./configure --enable-shared --disable-static --disable-programs --disable-doc
make -j"$(nproc)"
rm -rf staging && DESTDIR="$PWD/staging" make install

mkdir -p "$OUT_DIR"
# Copy ONLY the versioned runtime libs (real files + SONAME symlinks), not the
# headers or the unversioned .so dev symlinks (those could shadow the system
# FFmpeg at build time on the device).
cp -a staging/usr/local/lib/*.so.[0-9]* "$OUT_DIR"/

echo
echo "Staged libs in $OUT_DIR:"
ls -la "$OUT_DIR"
echo
echo "Commit vendor/ffmpeg7/$ARCH/ — migrations/0002 installs them fleet-wide for $ARCH."
