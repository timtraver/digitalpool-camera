#!/usr/bin/env bash
# 0031-rename-to-duocast.sh — dp-stream-XXXX becomes dp-duocast-XXXX.
#
# The product is DuoCast, so the boxes should say so. The hostname stays
# lowercase because it is the canonical identifier — `netbird up --hostname=`
# and the mediamtx host entries are derived from it, and both want something
# DNS-safe. The spelling a person reads, DP-DuoCast-XXXX, is computed from the
# same MAC by getDisplayName() in server.js and by ble/dp-ble.py, so a box has
# one identity in two spellings that always share their last four hex digits.
#
# Safe on a registered box: BLUETOOTH_ONBOARDING.md §11.2 and
# CLOUD_FUNCTION_SPEC.md both key the device record on `deviceId`/`macAddress`,
# and deviceName is descriptive only. The next subscription check reports the
# new name and the backend record follows along.
#
# Deliberately conservative about WHICH boxes it touches:
#
#   * Only a hostname matching exactly dp-stream-<4 hex>. A box an operator
#     named "Front Table" keeps that name — renaming somebody's deliberate
#     choice out from under them is worse than an inconsistent fleet.
#   * remote.json's deviceName is rewritten only when it held the old hostname.
#     If it holds something else, that something else was chosen on purpose.
#     `registered` and every other key are preserved untouched — isRegistered()
#     reads deviceName, so losing it would deregister the box.
#
# The NetBird peer keeps its old display name until the box re-registers,
# because `netbird up --hostname=` only runs at registration. That is cosmetic;
# the peer's identity is its key, not its name. The fleet roster will show a
# mix until then.
#
# Idempotent.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER=dp

OLD_HOSTNAME="$(hostname)"

if ! [[ "$OLD_HOSTNAME" =~ ^dp-stream-[0-9a-f]{4}$ ]]; then
  echo "   hostname is \"$OLD_HOSTNAME\", not a dp-stream-XXXX default — leaving it alone"
  exit 0
fi

SUFFIX="${OLD_HOSTNAME##dp-stream-}"
NEW_HOSTNAME="dp-duocast-${SUFFIX}"

echo "Renaming $OLD_HOSTNAME -> $NEW_HOSTNAME"

# /etc/hostname is what survives a reboot, so write it first and directly —
# hostnamectl talks to systemd-hostnamed over D-Bus and can fail.
echo "$NEW_HOSTNAME" > /etc/hostname
hostnamectl set-hostname "$NEW_HOSTNAME" 2>/dev/null \
  || echo "   (hostnamectl unavailable — /etc/hostname carries it over the next reboot)"

if grep -q '^127\.0\.1\.1' /etc/hosts; then
  sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t${NEW_HOSTNAME}/" /etc/hosts
else
  printf '127.0.1.1\t%s\n' "$NEW_HOSTNAME" >> /etc/hosts
fi

# remote.json carries the registered name. Rewrite only the one key, and only
# when it still held the old hostname.
REMOTE="$REPO_DIR/remote.json"
if [ -s "$REMOTE" ]; then
  python3 - "$REMOTE" "$OLD_HOSTNAME" "$NEW_HOSTNAME" <<'PYEOF'
import json, sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path) as handle:
        cfg = json.load(handle)
except Exception as exc:
    print(f"   could not read remote.json ({exc}) — leaving it alone")
    raise SystemExit(0)
if cfg.get("deviceName") != old:
    print(f"   remote.json deviceName is {cfg.get('deviceName')!r} — leaving it alone")
    raise SystemExit(0)
cfg["deviceName"] = new
with open(path, "w") as handle:
    json.dump(cfg, handle, indent=2)
print(f"   remote.json deviceName {old} -> {new}")
PYEOF
  chown "$APP_USER:$APP_USER" "$REMOTE" 2>/dev/null || true
fi

# mediamtx's host entries are built from the hostname; rebuild them now rather
# than waiting for the daily timer, so WebRTC ICE candidates stay resolvable.
if [ -x /usr/local/bin/mediamtx-update-hosts.sh ]; then
  /usr/local/bin/mediamtx-update-hosts.sh >/dev/null 2>&1 \
    && echo "   mediamtx host entries rebuilt" || true
fi

echo "Renamed to $NEW_HOSTNAME (shown as DP-DuoCast-${SUFFIX^^})."
