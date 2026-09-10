#!/usr/bin/env bash
# camera-nodes.sh — print what every /dev/videoN actually is: which physical
# camera, which USB port, whether it can capture, and the stable paths that
# refer to it.
#
# Why this exists: /dev/videoN numbering is NOT stable. A uvcvideo re-probe
# (usb-reset.sh, autosuspend, a driver rebind) renumbers the nodes with no USB
# disconnect and no other visible sign — on dp-stream-2e27 a camera moved from
# /dev/video0 to /dev/video1 while staying on the bus the whole time, and the
# pinned CAMERA_DEVICE=/dev/video0 in .env then pointed at nothing. Every UVC
# camera also exposes a second, USELESS node for metadata right next to its real
# capture node, so "the lower number" is not a reliable rule either.
#
# Read-only: nothing here opens a camera for capture or changes any state, so it
# is safe to run against a live stream.
#
# Usage: ./camera-nodes.sh
set -uo pipefail

command -v udevadm >/dev/null || { echo "camera-nodes: udevadm not found" >&2; exit 1; }

shopt -s nullglob
NODES=(/dev/video*)
if [ ${#NODES[@]} -eq 0 ]; then
  echo "No /dev/video* nodes at all — no camera is bound to uvcvideo."
  echo "Check 'lsusb' for the camera, then 'journalctl -k | grep -i uvc'."
  exit 0
fi

# Collect the stable symlinks once; each points at a real node we can match up.
declare -A STABLE
for link in /dev/v4l/by-id/* /dev/v4l/by-path/*; do
  tgt="$(readlink -f "$link" 2>/dev/null)" || continue
  STABLE["$tgt"]="${STABLE[$tgt]:+${STABLE[$tgt]}$'\n'}$link"
done

for node in "${NODES[@]}"; do
  # udevadm reports the properties udev itself computed, so this agrees exactly
  # with what the by-id/by-path rules saw.
  props="$(udevadm info --query=property --name="$node" 2>/dev/null)" || continue
  get() { printf '%s\n' "$props" | sed -n "s/^$1=//p" | head -1; }

  product="$(get ID_V4L_PRODUCT)"
  serial="$(get ID_SERIAL_SHORT)"
  caps="$(get ID_V4L_CAPABILITIES)"
  path="$(get ID_PATH)"

  case "$caps" in
    *:capture:*) role="CAPTURE — usable as a camera" ;;
    "")          role="unknown (v4l_id reported no capabilities)" ;;
    *)           role="not a capture node (metadata sibling — never stream from this)" ;;
  esac

  echo "$node"
  echo "    camera   : ${product:-<unknown>}"
  echo "    serial   : ${serial:-<none>}"
  echo "    usb path : ${path:-<none>}"
  echo "    role     : $role"
  echo "    created  : $(stat -c '%y' "$node" 2>/dev/null | cut -d. -f1)"
  if [ -n "${STABLE[$node]:-}" ]; then
    echo "    stable   :"
    printf '%s\n' "${STABLE[$node]}" | sed 's/^/               /'
  else
    echo "    stable   : none — only the unstable $node refers to this device"
  fi
  echo
done

echo "── For .env ──"
echo "Point CAMERA_DEVICE / CAMERA_DEVICE_2 at a *stable* path from a CAPTURE node"
echo "above, never at /dev/videoN. A by-id path follows the camera's serial, so it"
echo "survives renumbering and reboots; a by-path path follows the USB port, so it"
echo "survives swapping in a replacement camera on the same cable."
for node in "${NODES[@]}"; do
  props="$(udevadm info --query=property --name="$node" 2>/dev/null)" || continue
  case "$(printf '%s\n' "$props" | sed -n 's/^ID_V4L_CAPABILITIES=//p')" in
    *:capture:*) ;;
    *) continue ;;
  esac
  for link in ${STABLE[$node]:-}; do
    case "$link" in */by-id/*) echo "  CAMERA_DEVICE=$link  # $node" ;; esac
  done
done
