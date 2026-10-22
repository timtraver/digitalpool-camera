#!/usr/bin/env bash
# install-ladspa.sh — put the background-music filter where ffmpeg and
# GStreamer will find it. Run as root, by the migrations that call it.
#
# Prefers a prebuilt vendor/ladspa/<arch>/dp_percussive.so; otherwise compiles
# the two source files here, which takes about a second.
#
# Never fails the caller. A venue losing its music filter must not be a reason
# a device fails to boot — it streams unfiltered and says so.
#
# Idempotent.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="$(uname -m)"
PREBUILT="$REPO_DIR/vendor/ladspa/$ARCH/dp_percussive.so"
DEST_DIR="/usr/lib/ladspa"
DEST="$DEST_DIR/dp_percussive.so"

mkdir -p "$DEST_DIR"

install_prebuilt() {
  [ -f "$PREBUILT" ] || return 1
  echo "Installing prebuilt filter for $ARCH: $PREBUILT"
  install -m 0644 "$PREBUILT" "$DEST"
}

build_here() {
  if ! command -v cc >/dev/null 2>&1; then
    echo "No C compiler on this box."
    return 1
  fi
  if [ ! -f /usr/include/ladspa.h ]; then
    echo "Installing LADSPA headers…"
    # The exit status of apt is deliberately ignored, and the HEADER is checked
    # instead. A box can have an unrelated package in a broken state — a DKMS
    # module that no longer builds against the running kernel is the usual one
    # — and then every apt-get install exits non-zero no matter how well the
    # package we asked for installed. Trusting that status cost one device its
    # filter while ladspa-sdk sat correctly installed on disk.
    apt-get update -qq || true
    apt-get install -y ladspa-sdk || true
  fi
  if [ ! -f /usr/include/ladspa.h ]; then
    echo "LADSPA headers still missing after apt — cannot build."
    return 1
  fi
  echo "Compiling the filter from source for $ARCH…"
  local tmp
  tmp="$(mktemp -d)"
  # Build to a temporary file and move it into place, so a half-written plugin
  # is never visible to a pipeline starting at the same moment.
  if ! cc -O2 -fPIC -shared -Wall \
       -o "$tmp/dp_percussive.so" \
       "$REPO_DIR/audio/dp_percussive_ladspa.c" "$REPO_DIR/audio/dp_percussive.c" -lm; then
    rm -rf "$tmp"
    return 1
  fi
  install -m 0644 "$tmp/dp_percussive.so" "$DEST"
  rm -rf "$tmp"
}

if install_prebuilt || build_here; then
  echo "Installed: $DEST"
else
  echo "⚠️  Could not install the music filter on this box. Streams will carry"
  echo "   unfiltered audio; everything else is unaffected."
  echo "   Build one with audio/build-ladspa.sh on an $ARCH machine and commit"
  echo "   vendor/ladspa/$ARCH/dp_percussive.so, then add a new migration."
  exit 0
fi

# ── Verify the hosts can actually see it ────────────────────────────────────
# Informational: the app checks for the plugin at stream start and leaves it
# out of the chain when it is missing, so a "MISSING" here costs the filter,
# not the stream.
if command -v ffmpeg >/dev/null 2>&1; then
  if ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=48000:cl=mono \
       -af "ladspa=f=dp_percussive:p=dp_percussive" -t 0.2 -f null - >/dev/null 2>&1; then
    echo "  OK       ffmpeg loads the filter"
  else
    echo "  MISSING  ffmpeg cannot load it (is this ffmpeg built with --enable-ladspa?)"
  fi
fi
if command -v gst-inspect-1.0 >/dev/null 2>&1; then
  element="$(gst-inspect-1.0 2>/dev/null | grep -oE 'ladspa[a-z0-9-]*percussive[a-z0-9-]*' | head -1)"
  if [ -n "$element" ]; then
    echo "  OK       GStreamer element $element"
  else
    echo "  MISSING  GStreamer has no LADSPA element for it"
    echo "           (embedded-audio sources — NDI, RTSP — stay unfiltered)"
  fi
fi

echo "🎚️  Background-music filter installed."
