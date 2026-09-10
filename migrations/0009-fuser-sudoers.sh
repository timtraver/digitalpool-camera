#!/usr/bin/env bash
# 0009-fuser-sudoers.sh — let the app see (and kill) every holder of the camera
# and mic device nodes, so "Device '/dev/video0' is busy" stops being silent.
#
# Problem this solves: streamController._killCameraProcesses() shells out to
# `sudo fuser -k /dev/video0` before starting a pipeline. There was no NOPASSWD
# grant for fuser, so sudo tried to prompt, found no tty, and PAM logged
#
#   sudo[...]: pam_unix(sudo:auth): auth could not identify password for [dp]
#
# while the shell's `|| true` swallowed the non-zero exit. The follow-up
# `sudo fuser` check failed the same way, returned empty stdout, and the code
# read "no PIDs" as "device free" — printing "✅ Camera device is free"
# immediately before GStreamer failed with VIDIOC_S_FMT "Device or resource
# busy". So the one cleanup step that exists to prevent that error had never run
# on any device, and its failure was reported as success.
#
# The unprivileged pass added alongside this migration covers every holder the
# app itself creates (GStreamer/ffmpeg children run as dp). This grant covers
# the rest: a root-owned holder, and the honest "device really is free" answer
# that lets the app distinguish a stale process from a camera wedged in the
# kernel after a USB drop (which needs usb-reset.sh, not another kill).
#
# Blast radius is deliberately narrow: the targets are fixed device paths, so
# this permits killing whoever holds a capture device and nothing else. No
# trailing `*` — that would let any path be passed to `fuser -k`.
#
# Idempotent: writes one fixed file and validates it.
set -euo pipefail

SUDOERS="/etc/sudoers.d/digitalpool-fuser"

# fuser ships in psmisc, which is NOT installed on every device (dp-stream-2e27
# had neither psmisc nor lsof), so install it rather than assuming it.
#
# The apt step is deliberately non-fatal: the runner stops at the first failing
# migration, so aborting here would block every later migration on a device that
# happens to boot without internet. If the install fails we still lay down the
# grant against the Debian path, so it is correct as soon as psmisc arrives.
FUSER_BIN="$(command -v fuser || true)"
if [ -z "$FUSER_BIN" ]; then
  echo "ℹ️  fuser not present — installing psmisc"
  export DEBIAN_FRONTEND=noninteractive
  if apt-get install -y psmisc; then
    FUSER_BIN="$(command -v fuser || true)"
  else
    echo "⚠️  apt-get install psmisc failed (no network?) — continuing"
  fi
fi
if [ -z "$FUSER_BIN" ]; then
  FUSER_BIN="/usr/bin/fuser"
  echo "⚠️  fuser still missing — writing the grant for $FUSER_BIN anyway."
  echo "    Run 'sudo apt-get install -y psmisc' once this device has internet."
fi
echo "ℹ️  fuser: $FUSER_BIN"

cat > "$SUDOERS" <<SUDO
# Installed by migrations/0009-fuser-sudoers.sh
# Lets the digitalpool-camera app find and SIGKILL processes holding a capture
# device open, so a stale pipeline cannot block the next stream start.
# Device paths are fixed patterns on purpose — no open-ended wildcard.
dp ALL=(root) NOPASSWD: $FUSER_BIN /dev/video[0-9], $FUSER_BIN -k /dev/video[0-9]
dp ALL=(root) NOPASSWD: $FUSER_BIN /dev/snd/pcmC[0-9]D[0-9]c, $FUSER_BIN -k /dev/snd/pcmC[0-9]D[0-9]c
SUDO

chmod 0440 "$SUDOERS"

# A malformed sudoers file can lock the host out of sudo entirely, so validate
# and remove our file again if it doesn't parse.
if visudo -cf "$SUDOERS" >/dev/null 2>&1; then
  echo "✅ Installed and validated $SUDOERS"
else
  rm -f "$SUDOERS"
  echo "❌ $SUDOERS failed validation — removed, not applying"
  exit 1
fi

# Confirm the grant actually works for the service user. `sudo -n fuser` exits 1
# when it finds no holders and 0 when it finds some — both mean the grant works.
# A missing/mismatched grant makes sudo itself fail and print to stderr, which is
# what we're checking for here.
if err=$(sudo -n -u dp sudo -n "$FUSER_BIN" /dev/video0 2>&1 >/dev/null); [ -z "$err" ]; then
  echo "✅ dp can run 'sudo -n fuser /dev/video0' without a password"
else
  echo "⚠️  Could not verify the grant — sudo said: $err"
  echo "    The app still detects dp-owned holders; a root-owned holder would be missed."
fi
