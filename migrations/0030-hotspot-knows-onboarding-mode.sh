#!/usr/bin/env bash
# 0030-hotspot-knows-onboarding-mode.sh — stop the boot hotspot fighting BLE.
#
# Two fixes to dp-hotspot.sh, both of which only bite on the hardware we are
# standardising on:
#
#   1. ONBOARDING_MODE. Under `ble` the onboard radio is the venue internet
#      connection and the hotspot is on-demand (BLUETOOTH_ONBOARDING.md §2 D6).
#      dp-hotspot.sh runs as root at boot, before the app, and knew nothing
#      about that — so every reboot took the radio straight back off the
#      network the box had been told to join. It now reads the mode and exits
#      early when it is `ble`.
#
#   2. Interface detection. `nmcli ... | grep ':wifi'` matches `:wifi-p2p` as a
#      substring. Every iwlwifi card exposes a `p2p-dev-*` control device that
#      can neither scan nor run an AP, and every N100 — which is every
#      production box — has one. Whether it was picked came down to the order
#      nmcli happened to list devices in. Now matched on the exact TYPE field.
#
# dp-hotspot.sh lives in the repo but RUNS from /usr/local/sbin, and only
# 0003-sync-system-scripts.sh copies it there. 0003 is recorded as applied on
# every device and the state file keys on the filename, so editing the repo
# copy alone would ship nothing. 0003 is idempotent and skips files that
# already match, so re-invoking it is the way — the same pattern as 0016.
#
# Idempotent.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC="$HERE/0003-sync-system-scripts.sh"

if [ ! -f "$SYNC" ]; then
  echo "❌ $SYNC not found — cannot re-sync system scripts"
  exit 1
fi

echo "Re-running the system-script sync (0003) to pick up dp-hotspot.sh…"
bash "$SYNC"

# Also refresh the unit, whose ExecStop had the same grep bug.
if [ -f "$HERE/../digitalpool-hotspot.service" ]; then
  install -m 0644 "$HERE/../digitalpool-hotspot.service" \
    /etc/systemd/system/digitalpool-hotspot.service
  systemctl daemon-reload
fi

# Prove the gate actually landed, so the log says whether a reboot will now
# respect the mode rather than just that a copy happened.
if grep -q 'ONBOARDING_MODE' /usr/local/sbin/dp-hotspot.sh 2>/dev/null; then
  echo "   dp-hotspot.sh now honours ONBOARDING_MODE"
else
  echo "❌ /usr/local/sbin/dp-hotspot.sh has no ONBOARDING_MODE gate after the sync"
  exit 1
fi
