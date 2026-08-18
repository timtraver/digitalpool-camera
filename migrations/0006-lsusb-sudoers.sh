#!/usr/bin/env bash
# 0006-lsusb-sudoers.sh — let the app read USB device descriptors so it can tell a
# real PTZ camera from a fixed one.
#
# Problem this solves: UVC firmware advertises the Camera Terminal controls
# (pan/tilt/zoom) whether or not the mechanics exist, and uvcvideo creates a v4l2
# control for each — so a fixed camera such as the ELP 4K U3 presents a full
# pan/tilt/zoom control set, accepts writes to it, and even retains the values.
# Nothing in v4l2 distinguishes that from a motorised camera.
#
# The one spec-backed signal lives in the USB Camera Terminal descriptor:
# wObjectiveFocalLengthMin/Max, which the UVC spec requires to be EQUAL for a
# fixed-focal-length lens. Reading it needs `lsusb -v`, and lsusb can only print
# descriptors as root (it opens /dev/bus/usb/*, which is root-owned) — hence a
# sudoers grant. Without this, cameraController.detectPtzCapability() loses that
# signal and falls back to assuming the camera does have PTZ, leaving the operator
# to set it by hand in Camera Input → Pan/Tilt/Zoom.
#
# Read-only and side-effect free: lsusb only reads descriptors.
#
# Idempotent: writes one fixed file and validates it.
set -euo pipefail

SUDOERS="/etc/sudoers.d/digitalpool-lsusb"

cat > "$SUDOERS" <<'SUDO'
# Installed by migrations/0006-lsusb-sudoers.sh
# Lets the digitalpool-camera app read UVC descriptors to detect whether a
# camera physically supports PTZ. Read-only: lsusb cannot modify device state.
dp ALL=(ALL) NOPASSWD: /usr/bin/lsusb -v -d *
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

# Confirm the grant actually works for the service user, so a wrong lsusb path
# (Debian ships /usr/bin/lsusb; some distros use /bin/lsusb) is caught here
# rather than showing up later as silent detection failures.
if sudo -n -u dp sudo -n /usr/bin/lsusb -v -d 1d6b:0002 >/dev/null 2>&1; then
  echo "✅ dp can run 'sudo lsusb -v' without a password"
else
  # Not fatal: the app degrades to assuming PTZ is present, which the operator
  # can override in the UI. Warn loudly rather than blocking the boot chain.
  echo "⚠️  Could not verify the grant (lsusb path differs, or no matching device)."
  echo "    PTZ auto-detection will assume PTZ is present; the UI override still works."
fi
