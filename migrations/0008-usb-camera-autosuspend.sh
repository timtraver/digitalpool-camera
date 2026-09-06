#!/usr/bin/env bash
# 0008-usb-camera-autosuspend.sh — stop the kernel from power-managing the USB
# capture devices, and make the setting stick across re-enumeration.
#
# Failure mode this addresses: a streaming OBSBOT Tiny SE dropped off the USB bus
# mid-match — the kernel logged a burst of `uvcvideo: Non-zero status (-71)`
# (EPROTO, a bus-level protocol error) followed by `USB disconnect`, and the
# camera re-enumerated ~12s later under a new device number. Nobody touched the
# cable. Observed on two separate devices within two days, on a direct root port
# (not behind a hub), with every neighbouring USB device riding through untouched
# — so the host power rail and the xHCI controller are not implicated.
#
# usbcore defaults to autosuspend=2 and the cameras sit at power/control=auto.
# An actively streaming device should stay busy and never suspend, so this is NOT
# a confirmed root cause — it is a cheap, well-established mitigation for exactly
# this class of EPROTO-then-drop behaviour on UVC devices, and it removes one
# variable from the investigation. The real fix for the outage is in the app:
# server.js now retries the idle preview properly and auto-resumes a stream that
# died from source loss, so a drop costs ~15s instead of taking the stream down
# until someone notices.
#
# A udev rule (not a one-shot sysfs write) because the device gets a NEW sysfs
# node every time it re-enumerates — which, given the failure above, is precisely
# when the setting needs to still be in force.
#
# Scope: USB video/audio capture class devices, plus the OBSBOT Tiny family by
# vendor id (3564) since its audio interfaces enumerate as separate children.
#
# Idempotent: writes a fixed rules file and reloads udev.
set -euo pipefail

RULES=/etc/udev/rules.d/90-digitalpool-usb-camera-power.rules
TMP="$(mktemp)"

cat > "$TMP" <<'RULES'
# Installed by migrations/0008-usb-camera-autosuspend.sh — do not edit by hand.
# Keep USB capture devices powered on: disable autosuspend so the kernel never
# tries to suspend a camera mid-capture, and re-apply on every re-enumeration.

# OBSBOT (Remo Tech) — matched by vendor so every interface/child is covered.
ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="3564", TEST=="power/control", ATTR{power/control}="on"

# Any USB device exposing a UVC video interface.
ACTION=="add", SUBSYSTEM=="usb", ATTR{bInterfaceClass}=="0e", TEST=="power/control", ATTR{power/control}="on"

# Any USB device exposing an audio interface (camera mics enumerate separately).
ACTION=="add", SUBSYSTEM=="usb", ATTR{bInterfaceClass}=="01", TEST=="power/control", ATTR{power/control}="on"
RULES

# Copy-if-changed: skip the reload (and its log noise) when already current.
if [ -f "$RULES" ] && cmp -s "$TMP" "$RULES"; then
  echo "OK    $RULES already up to date"
  rm -f "$TMP"
else
  install -m 0644 "$TMP" "$RULES"
  rm -f "$TMP"
  echo "COPY  installed $RULES"
  udevadm control --reload-rules
  echo "OK    udev rules reloaded"
fi

# Apply to devices that are ALREADY plugged in — a udev rule only fires on 'add',
# so without this the setting wouldn't take effect until the next replug/reboot.
# Walk every USB device that has a power/control knob and pin the capture ones.
CHANGED=0
for dev in /sys/bus/usb/devices/*; do
  [ -f "$dev/power/control" ] || continue
  vendor="$(cat "$dev/idVendor" 2>/dev/null || echo '')"
  is_capture=0
  [ "$vendor" = "3564" ] && is_capture=1
  # Interface class lives on the interface children (e.g. 1-1:1.0), not the device.
  for intf in "$dev":*; do
    [ -f "$intf/bInterfaceClass" ] || continue
    cls="$(cat "$intf/bInterfaceClass" 2>/dev/null || echo '')"
    case "$cls" in 0e|01) is_capture=1 ;; esac
  done
  [ "$is_capture" = "1" ] || continue
  if [ "$(cat "$dev/power/control" 2>/dev/null || echo on)" != "on" ]; then
    echo on > "$dev/power/control" 2>/dev/null || true
    echo "SET   $(basename "$dev") power/control=on ($(cat "$dev/product" 2>/dev/null || echo 'unknown'))"
    CHANGED=$((CHANGED + 1))
  fi
done
echo "OK    ${CHANGED} already-attached capture device(s) updated"

echo "0008-usb-camera-autosuspend complete."
