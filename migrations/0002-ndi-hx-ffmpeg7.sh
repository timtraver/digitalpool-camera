#!/usr/bin/env bash
# 0002-ndi-hx-ffmpeg7.sh — provide the FFmpeg 7 runtime libs that NDI|HX decode needs.
#
# NDI's HX (H.264/H.265) decoder does not decode video itself — it dlopen()s
# FFmpeg's libavcodec.so.61 / libavutil.so.59 (FFmpeg 7).  Ubuntu 24.04 ships
# only FFmpeg 6 (libavcodec.so.60), so without these NDI can't decode an HX
# stream and shows a "Video decoder not found" placeholder frame instead of the
# camera.  (Discovery and connection work fine — this is purely decode.)
#
# We install FFmpeg 7's versioned .so files into /usr/local/lib ALONGSIDE the
# system's FFmpeg 6.  Different SONAME (.61 vs .60) → they coexist; GStreamer's
# avdec_* keeps using the system .60, NDI finds .61.  ldconfig recreates the
# SONAME symlinks from the copied real files.
#
# Prebuilt libs are committed under vendor/ffmpeg7/<arch>/ (see
# build-ffmpeg7-libs.sh for how they were produced).  Idempotent.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="$(uname -m)"                       # x86_64 | aarch64
LIBDIR="$REPO_DIR/vendor/ffmpeg7/$ARCH"

# No prebuilt libs for this architecture → no-op success.  When NDI|HX support
# is needed on another arch (e.g. aarch64 / RK3588), build the libs (see
# build-ffmpeg7-libs.sh), commit them under vendor/ffmpeg7/<arch>/, and add a
# NEW migration to install them — this one is already recorded as applied and
# will not re-run (migrations are keyed on filename).
if ! ls "$LIBDIR"/*.so.* >/dev/null 2>&1; then
  echo "No prebuilt FFmpeg 7 libs for arch '$ARCH' ($LIBDIR) — skipping."
  echo "NDI|HX decode will not work on this arch until libs are committed there."
  exit 0
fi

echo "Installing FFmpeg 7 runtime libs for $ARCH into /usr/local/lib ..."
cp -a "$LIBDIR"/*.so.* /usr/local/lib/
ldconfig

echo "Verifying NDI's required SONAMEs resolve:"
missing=0
for soname in libavcodec.so.61 libavutil.so.59; do
  if ldconfig -p | grep -q "$soname"; then
    echo "  OK       $soname"
  else
    echo "  MISSING  $soname" >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || { echo "FFmpeg 7 libs did not resolve — NDI|HX will still fail." >&2; exit 1; }

echo "FFmpeg 7 libs installed — NDI|HX decoding enabled."
