#!/usr/bin/env bash
# wake-shutdown.sh — arm the RTC wake alarm, then gracefully power the device off.
#
# The board powers itself back on when the alarm fires. This works on the Intel
# x86 targets (N97 / N100), and only when the BIOS "Wake on RTC" / "Auto Power On"
# option is enabled (see README). RK3588 (arm64) boards generally cannot wake from
# a full power-off, so the app only offers this on x64 — this script does not
# re-check the platform.
#
# We use `rtcwake -m no`, which ONLY writes the alarm to the RTC and returns — it
# does not suspend or power off. That lets systemd shut the services down cleanly
# (digitalpool-camera's SIGTERM handler kills the GStreamer/ffmpeg children) via a
# normal `systemctl poweroff`, while the alarm sits in the RTC hardware and
# survives the power-off to trigger the wake.
#
# Arg 1: absolute wake time as a UNIX epoch (seconds); must be in the future.
#
# Runs as root via sudoers (installed by migrations/0005-camera-power-controls.sh):
#   dp ALL=(root) NOPASSWD: /usr/bin/bash /home/dp/digitalpool-camera/wake-shutdown.sh *
#
# Exit codes: 2 = bad epoch arg, 3 = wake time not in the future, 4 = rtcwake failed.
set -uo pipefail

EPOCH="${1:-}"

if [[ ! "$EPOCH" =~ ^[0-9]+$ ]]; then
  echo "wake-shutdown: invalid epoch '$EPOCH'" >&2
  exit 2
fi

NOW="$(date +%s)"
if (( EPOCH <= NOW )); then
  echo "wake-shutdown: wake time is not in the future ($EPOCH <= $NOW)" >&2
  exit 3
fi

echo "wake-shutdown: arming RTC alarm for $(date -d "@$EPOCH" 2>/dev/null || echo "epoch $EPOCH")"
# -m no: set the wakeup alarm only; do not suspend or power off here.
if ! rtcwake -m no -t "$EPOCH"; then
  echo "wake-shutdown: rtcwake failed to arm the alarm" >&2
  exit 4
fi

echo "wake-shutdown: alarm set — powering off now"
# Graceful poweroff: systemd stops digitalpool-camera (media children killed) and
# the other services before the machine powers down. Firmware wakes it at the alarm.
systemctl poweroff
