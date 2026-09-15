#!/usr/bin/env bash
# 0011-recordings-dir.sh — create the local match-recording store.
#
# Why local recording exists at all: delivery is Wowza pulling RTSP from this
# box across the internet, and on 2026-09-14 that pull stalled mid-match.
# MediaMTX's write queue to Wowza filled (`reader is too slow, discarding ~500
# frames` a second — the whole 512-deep default queue), the 10 s writeTimeout
# expired, and the session died with `write tcp …: i/o timeout`. Wowza
# reconnected 19 s later onto a NEW recording file, so a 1h23m match survived
# only as its last 13m39s. Nothing on this box was at fault — the encoders held
# 0 ppm drift throughout — and nothing on this box can stop a venue uplink from
# degrading. The only durable answer is a copy that never leaves the device.
#
# The store deliberately lives OUTSIDE the repo. DEPLOY_GRAPHICS.md syncs
# /home/dp/digitalpool-camera with rsync and /api/update runs `git reset --hard`
# on it; multi-GB match footage in that path would be copied on every deploy and
# is one `--delete` away from being erased. /var/lib is also where the migration
# state file already lives, for the same reason.
#
# Idempotent: mkdir -p, chown, and a capability check.
set -euo pipefail

REC_DIR="/var/lib/digitalpool-camera/recordings"

mkdir -p "$REC_DIR"
chown -R dp:dp "$REC_DIR"
chmod 0755 "$REC_DIR"
echo "✅ $REC_DIR ready (owned by dp)"

# The app writes here as dp; verify rather than assume, because a silent
# permission failure would look exactly like "recording is off".
if sudo -n -u dp test -w "$REC_DIR"; then
  echo "✅ dp can write to $REC_DIR"
else
  echo "❌ dp cannot write to $REC_DIR"
  exit 1
fi

# Recording remuxes the existing RTSP stream with `ffmpeg -c copy` — no decode,
# no encode, so it costs almost nothing on top of two live encoders. But it does
# need ffmpeg on PATH.
#
# Deliberately NOT apt-get installed: migration 0002 puts a specific ffmpeg 7
# build in place for NDI HX, and pulling the distro package over it could
# downgrade or conflict with that. Warn instead and let a human decide.
if command -v ffmpeg >/dev/null 2>&1; then
  echo "✅ ffmpeg: $(command -v ffmpeg) ($(ffmpeg -version 2>/dev/null | head -n1))"
else
  echo "⚠️  ffmpeg is NOT on PATH — recording cannot run until it is."
  echo "    Do not blindly 'apt-get install ffmpeg': migration 0002 installs a"
  echo "    specific ffmpeg 7 build for NDI HX. Check what 0002 left behind first."
fi

# Free space is worth stating plainly at provisioning time: a 5 Mbps stream is
# about 2.25 GB per hour, so the defaults (100 GB cap, 10 GB floor) assume a
# disk with room for roughly 44 hours of footage.
echo "ℹ️  Free space on $(df -P "$REC_DIR" | awk 'NR==2{print $6}'): $(df -Ph "$REC_DIR" | awk 'NR==2{print $4}')"
echo "ℹ️  ~2.25 GB/hour at 5 Mbps. Retention is configurable in the UI (Recording card)."
