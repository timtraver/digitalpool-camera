#!/usr/bin/env bash
# 0033-canonical-name-unregistered.sh — give an UNREGISTERED box its canonical
# name, whatever it is called now.
#
# 0031 renames only hostnames matching the old default exactly
# (dp-stream-<4 hex>), and deliberately leaves anything else alone: renaming a
# box somebody deliberately called "Front Table" out from under them is worse
# than an inconsistent fleet.
#
# That rule is right for a box in service and wrong for one that is not. A box
# with no registration has no identity anyone depends on — no backend device
# record, no venue, nothing that would be confused by a new name — and leaving
# it on a stale hand-typed name means the fleet never converges. dp-stream-1
# was the case in point: hostname "dp-stream-1", remote.json deviceName
# "tim-house-2", advertising as DP-DuoCast-85E4, three names for one box.
#
# So: canonicalise the name of a box that is NOT registered. A registered box
# keeps whatever it is called, exactly as before.
#
# Both names are set, because they are different things and getDeviceName()
# prefers the second:
#   * the hostname       — lowercase, DNS-safe, what NetBird and mediamtx use
#   * remote.json deviceName — what getDeviceName() returns when present
# The display name (DP-DuoCast-XXXX) is derived from the MAC and needs no
# changing; it was already right while both of these were wrong, which is how
# this went unnoticed.
#
# Idempotent.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER=dp
REMOTE="$REPO_DIR/remote.json"

# Registered? Then this migration has nothing to do. Mirrors isRegistered():
# registered===true, or a deviceName with no `registered` key at all (older
# devices predate the flag).
if [ -s "$REMOTE" ] && python3 - "$REMOTE" <<'PYEOF'
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)                      # unreadable → treat as not registered
if cfg.get("registered") is True:
    sys.exit(0)
if "registered" not in cfg and cfg.get("deviceName"):
    sys.exit(0)
sys.exit(1)
PYEOF
then
  echo "   this box is registered — leaving its name alone"
  exit 0
fi

# Canonical name from the primary MAC, the same rule as dp-firstboot.sh.
primary_mac() {
    local iface mac
    for iface in $(ls /sys/class/net 2>/dev/null | grep -E '^(en|eth)') \
                 $(ls /sys/class/net 2>/dev/null | grep -E '^wl') \
                 $(ls /sys/class/net 2>/dev/null); do
        [ "$iface" = "lo" ] && continue
        [ -e "/sys/class/net/$iface/device" ] || continue
        mac="$(cat "/sys/class/net/$iface/address" 2>/dev/null)"
        [ -n "$mac" ] && [ "$mac" != "00:00:00:00:00:00" ] && { echo "$mac"; return; }
    done
}

MAC="$(primary_mac)"
if [ -z "$MAC" ]; then
  echo "   no NIC MAC readable — cannot derive a name, leaving things as they are"
  exit 0
fi
SUFFIX="$(echo "$MAC" | tr -d ':' | tail -c 5)"
NEW_HOSTNAME="dp-duocast-${SUFFIX}"
OLD_HOSTNAME="$(hostname)"

if [ "$OLD_HOSTNAME" = "$NEW_HOSTNAME" ]; then
  echo "   hostname is already $NEW_HOSTNAME"
else
  echo "   hostname $OLD_HOSTNAME -> $NEW_HOSTNAME"
  echo "$NEW_HOSTNAME" > /etc/hostname
  hostnamectl set-hostname "$NEW_HOSTNAME" 2>/dev/null \
    || echo "   (hostnamectl unavailable — /etc/hostname carries it over the next reboot)"
  if grep -q '^127\.0\.1\.1' /etc/hosts; then
    sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t${NEW_HOSTNAME}/" /etc/hosts
  else
    printf '127.0.1.1\t%s\n' "$NEW_HOSTNAME" >> /etc/hosts
  fi
fi

# remote.json's deviceName is what getDeviceName() actually returns. An
# unregistered box has no reason to carry an old one.
if [ -s "$REMOTE" ]; then
  python3 - "$REMOTE" "$NEW_HOSTNAME" <<'PYEOF'
import json, sys
path, new = sys.argv[1], sys.argv[2]
try:
    cfg = json.load(open(path))
except Exception as exc:
    print(f"   could not read remote.json ({exc}) — leaving it alone")
    raise SystemExit(0)
old = cfg.get("deviceName")
if old == new:
    print(f"   remote.json deviceName already {new}")
    raise SystemExit(0)
cfg["deviceName"] = new
json.dump(cfg, open(path, "w"), indent=2)
print(f"   remote.json deviceName {old!r} -> {new}")
PYEOF
  chown "$APP_USER:$APP_USER" "$REMOTE" 2>/dev/null || true
fi

# mediamtx's host entries are built from the hostname.
if [ -x /usr/local/bin/mediamtx-update-hosts.sh ]; then
  /usr/local/bin/mediamtx-update-hosts.sh >/dev/null 2>&1 \
    && echo "   mediamtx host entries rebuilt" || true
fi

echo "Unregistered box canonicalised to $NEW_HOSTNAME (shown as DP-DuoCast-${SUFFIX^^})."
