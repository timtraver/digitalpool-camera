#!/usr/bin/env bash
# usb-reset.sh — targeted reset of ONE USB device (a camera), by its bus port id.
#
# Unbinds then rebinds the device from the kernel `usb` device driver, which forces
# a full re-enumeration (uvcvideo + snd-usb-audio re-probe) — the software
# equivalent of unplugging and re-plugging just that one camera. It does NOT touch
# the xHCI USB controller or any other device, so the USB WiFi-client dongle and
# the second camera keep running untouched.
#
# Arg 1: USB device port id exactly as it appears under /sys/bus/usb/devices,
#        e.g. "3-1" or a hub chain like "1-4.2". The Node app resolves this from
#        the camera's /dev/videoN via `udevadm info --query=path`.
#
# Runs as root via sudoers (installed by migrations/0005-camera-power-controls.sh):
#   dp ALL=(root) NOPASSWD: /usr/bin/bash /home/dp/digitalpool-camera/usb-reset.sh *
#
# Exit codes: 2 = bad port arg, 3 = port not on the bus (camera dropped off —
# a targeted reset can't help; a reboot is needed), 4 = rebind failed.
set -uo pipefail

PORT="${1:-}"

# Strict allow-list mirrors the sudoers wildcard's only safe shape: a root port
# number, a dash, then a dot-separated hub chain. Rejects anything with slashes,
# spaces, or ".." so the sysfs writes below can't be steered off the usb bus.
if [[ ! "$PORT" =~ ^[0-9]+-[0-9]+(\.[0-9]+)*$ ]]; then
  echo "usb-reset: invalid port id '$PORT'" >&2
  exit 2
fi

DEV_PATH="/sys/bus/usb/devices/$PORT"
DRV="/sys/bus/usb/drivers/usb"

if [[ ! -e "$DEV_PATH" ]]; then
  echo "usb-reset: $PORT is not present on the USB bus — camera has dropped off; a reboot is required" >&2
  exit 3
fi

echo "usb-reset: unbinding $PORT ..."
# unbind tears down the interface drivers (uvcvideo/snd-usb-audio); the device
# object itself stays enumerated, so we can bind it straight back.
echo -n "$PORT" > "$DRV/unbind" 2>/dev/null \
  || echo "usb-reset: unbind reported an error (already unbound?) — continuing" >&2

sleep 2

echo "usb-reset: rebinding $PORT ..."
if ! echo -n "$PORT" > "$DRV/bind" 2>/dev/null; then
  # On some kernels a hotplug re-bind races us and grabs the device first; that's
  # success, not failure — detect it by the presence of the driver symlink.
  if [[ -e "$DEV_PATH/driver" ]]; then
    echo "usb-reset: $PORT was already re-bound by the kernel"
  else
    echo "usb-reset: rebind of $PORT failed" >&2
    exit 4
  fi
fi

echo "usb-reset: done — $PORT re-enumerated"
