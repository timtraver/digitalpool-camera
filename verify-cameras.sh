#!/usr/bin/env bash
# verify-cameras.sh — post-update check for one device. Answers three questions
# that have each caused an outage on this fleet:
#
#   1. Do the two camera slots point at DIFFERENT physical cameras? Two slots on
#      one camera deadlocks both: each slot's cleanup kills the other's idle
#      preview and no backoff escapes it.
#   2. Which physical camera is in which slot? /dev/videoN numbering is not
#      stable, so this has to be read from the hardware, not assumed.
#   3. Are the saved startup PTZ values inside the ranges the camera reports?
#      An out-of-range write fails as a UVC control error every time the source
#      is applied.
#
# Read-only. Safe to run against live streams.
#
# Usage: ./verify-cameras.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

fail=0
note() { printf '  %s\n' "$*"; }
bad()  { printf '  ❌ %s\n' "$*"; fail=1; }
ok()   { printf '  ✅ %s\n' "$*"; }

echo "=== 1. Slot assignment ==="
# Plain variables rather than an associative array: only two slots exist, and
# this keeps the script runnable on bash 3.2 for testing.
SLOT_NODE_1=""; SLOT_NODE_2=""
for idx in 1 2; do
  file="camera-source$([ "$idx" = 2 ] && echo -2).json"
  if [ ! -f "$file" ]; then note "Cam$idx: no $file — slot resolved by discovery, see the app log"; continue; fi
  type=$(sed -n 's/.*"type"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -1)
  dev=$(sed -n 's/.*"device"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -1)
  if [ "$type" != "usb" ]; then note "Cam$idx: source type '$type' (not USB) — nothing to check here"; continue; fi

  # The resolved node is the only sound basis for comparison: a by-id path, a
  # by-path path and a raw node can all name one camera yet differ as strings.
  node=$(readlink -f "$dev" 2>/dev/null || true)
  eval "SLOT_NODE_$idx=\"\$node\""
  if [ -z "$node" ] || [ ! -e "$node" ]; then
    bad "Cam$idx: $dev does not resolve to a present device"
  else
    name=$(udevadm info --query=property --name="$node" 2>/dev/null | sed -n 's/^ID_V4L_PRODUCT=//p' | head -1)
    port=$(udevadm info --query=property --name="$node" 2>/dev/null | sed -n 's/^ID_PATH=//p' | head -1)
    ok "Cam$idx: ${name:-unknown} on ${port:-unknown port}  ($node)"
    note "     via $dev"
  fi
done

if [ -n "$SLOT_NODE_1" ] && [ "$SLOT_NODE_1" = "$SLOT_NODE_2" ]; then
  bad "BOTH SLOTS ARE ON $SLOT_NODE_1 — this deadlocks both cameras. Reassign camera 2 in the UI."
elif [ -n "$SLOT_NODE_1" ] && [ -n "$SLOT_NODE_2" ]; then
  ok "The two slots are on different cameras"
fi

echo
echo "=== 2. Startup PTZ values vs. the ranges the camera reports ==="
for idx in 1 2; do
  eval "node=\"\$SLOT_NODE_$idx\""
  cfg="camera-startup-config$([ "$idx" = 2 ] && echo -2).json"
  [ -n "$node" ] && [ -e "$node" ] || continue
  if [ ! -f "$cfg" ]; then note "Cam$idx: no $cfg — no startup position saved"; continue; fi

  ctrls=$(v4l2-ctl -d "$node" --list-ctrls 2>/dev/null || true)
  if [ -z "$ctrls" ]; then note "Cam$idx: could not read controls from $node (busy or no permission)"; continue; fi

  for ctl in pan_absolute tilt_absolute zoom_absolute; do
    saved=$(sed -n "s/.*\"$ctl\"[[:space:]]*:[[:space:]]*\(-\{0,1\}[0-9]\{1,\}\).*/\1/p" "$cfg" | head -1)
    [ -n "$saved" ] || continue
    line=$(printf '%s\n' "$ctrls" | grep -E "^[[:space:]]*$ctl " | head -1)
    if [ -z "$line" ]; then note "Cam$idx $ctl=$saved — camera reports no such control"; continue; fi
    min=$(printf '%s\n' "$line" | sed -n 's/.*min=\(-\{0,1\}[0-9]\{1,\}\).*/\1/p')
    max=$(printf '%s\n' "$line" | sed -n 's/.*max=\(-\{0,1\}[0-9]\{1,\}\).*/\1/p')
    if [ -z "$min" ] || [ -z "$max" ]; then note "Cam$idx $ctl=$saved — could not parse min/max"; continue; fi
    if [ "$saved" -lt "$min" ] || [ "$saved" -gt "$max" ]; then
      bad "Cam$idx $ctl=$saved is OUTSIDE [$min..$max] — this write fails every time the source is applied"
    else
      ok "Cam$idx $ctl=$saved within [$min..$max]"
    fi
  done
done

echo
echo "=== 3. Recent restart-loop symptoms ==="
loops=$(journalctl -u digitalpool-camera --since '10 min ago' 2>/dev/null | grep -c 'died quickly' || true)
hc=$(journalctl -k -b 2>/dev/null | grep -c 'HC died' || true)
[ "${loops:-0}" -gt 4 ] && bad "'Idle preview died quickly' x$loops in 10 min — still flapping" || ok "no restart flapping (${loops:-0} in 10 min)"
[ "${hc:-0}" -gt 0 ] && bad "xHCI 'HC died' in this boot — the USB host controller failed; only a reboot recovers it" || ok "no xHCI host controller failure this boot"

echo
[ "$fail" = 0 ] && echo "✅ PASS" || echo "❌ FAIL — see the ❌ lines above"
exit "$fail"
