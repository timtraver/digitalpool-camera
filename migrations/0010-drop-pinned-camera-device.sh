#!/usr/bin/env bash
# 0010-drop-pinned-camera-device.sh — stop the installed systemd unit from
# pinning CAMERA_DEVICE to a /dev/videoN that any driver re-probe can invalidate.
#
# Problem this solves: digitalpool-camera.service shipped
# `Environment=CAMERA_DEVICE=/dev/video0`. That is a *node number*, and node
# numbers are not stable — a uvcvideo re-probe (usb-reset.sh, USB autosuspend, a
# driver rebind) renumbers them with no USB disconnect and no other visible sign.
# On dp-stream-2e27 a camera moved to /dev/video1 while never leaving the bus and
# Cam1 was down for two days pointing at a node that no longer existed.
#
# Worse, the unit's value could not be overridden: dotenv leaves variables that
# are already in the environment alone, so `Environment=` beat .env and every
# .env edit was a silent no-op, contrary to what the README documented.
#
# The app now discovers the cameras that are actually connected (cameraDevices.js)
# and treats CAMERA_DEVICE as an optional override, so the right fix is to remove
# the line. The repo's copy of the unit no longer has it, but the *installed* copy
# at /etc/systemd/system is placed at provisioning time and is not touched by
# `git reset --hard`, so it needs editing in place.
#
# Idempotent: comments the line out only if an active one is present, and keeps a
# one-time backup the first time it changes anything.
set -euo pipefail

UNIT="/etc/systemd/system/digitalpool-camera.service"

if [ ! -f "$UNIT" ]; then
  echo "ℹ️  $UNIT not present — nothing to do"
  exit 0
fi

if ! grep -qE '^[[:space:]]*Environment=CAMERA_DEVICE' "$UNIT"; then
  echo "✅ $UNIT already has no pinned CAMERA_DEVICE"
  exit 0
fi

[ -f "$UNIT.pre-0010.bak" ] || cp -a "$UNIT" "$UNIT.pre-0010.bak"

# Comment rather than delete, so the original value stays visible to anyone
# debugging this device later.
sed -i -E 's|^([[:space:]]*)(Environment=CAMERA_DEVICE.*)$|\1# disabled by migrations/0010 (node numbers are not stable): \2|' "$UNIT"

if grep -qE '^[[:space:]]*Environment=CAMERA_DEVICE' "$UNIT"; then
  echo "❌ Failed to disable the pinned CAMERA_DEVICE in $UNIT" >&2
  exit 1
fi

# Without this the unit on disk and the unit systemd has loaded disagree, and the
# app would be restarted with the old environment still in place.
systemctl daemon-reload
echo "✅ Removed the pinned CAMERA_DEVICE from $UNIT (backup: $UNIT.pre-0010.bak)"
echo "   The app now auto-detects connected cameras; set CAMERA_DEVICE in .env only to force one."
