#!/usr/bin/env bash
# 0007-network-watchdog-uplinks.sh — ship the uplink-aware network watchdog.
#
# Why this needs its own migration:
#   0003-sync-system-scripts.sh already copies network-watchdog.sh to
#   /usr/local/bin, but it has ALREADY been applied on every device, and the
#   runner keys its state file on the FILENAME — so an edit to the watchdog
#   script would never reach a provisioned box.  A `git reset --hard` update
#   only refreshes the repo copy, which systemd does not execute.
#
# What changed in the watchdog:
#   The old script treated the AP/hotspot interface as "reachable" (the device
#   IS the gateway there).  The hotspot is always on, so the watchdog was
#   permanently satisfied and its reboot path could never fire — devices were
#   found running with dead Ethernet, dead client WiFi and ERR_NAME_NOT_RESOLVED
#   on every overlay fetch, indefinitely.  The hotspot is now informational only
#   and never counts toward health; see network-watchdog.sh for the full model.
#
# This also installs the updated network-watchdog.service (adds StateDirectory=
# for the last-known-good / last-reboot markers) and makes sure the timer is
# enabled — some early boxes were provisioned before it existed.
#
# Idempotent: copy-if-changed, and every systemctl call here is a no-op when
# already in the desired state.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

changed=false

# ── The script systemd actually executes ─────────────────────────────────────
src="$REPO_DIR/network-watchdog.sh"
dst="/usr/local/bin/network-watchdog.sh"
if [ ! -f "$src" ]; then
  echo "FAIL  network-watchdog.sh missing from repo ($src)" >&2
  exit 1
fi
if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
  echo "OK    network-watchdog.sh — already up to date"
else
  mkdir -p "$(dirname "$dst")"
  install -m 0755 "$src" "$dst"
  echo "COPY  network-watchdog.sh -> $dst"
  changed=true
fi

# ── Units (service gained StateDirectory=; timer unchanged but may be absent) ─
for unit in network-watchdog.service network-watchdog.timer; do
  usrc="$REPO_DIR/$unit"
  udst="/etc/systemd/system/$unit"
  [ -f "$usrc" ] || { echo "SKIP  $unit — not in repo"; continue; }
  if [ -f "$udst" ] && cmp -s "$usrc" "$udst"; then
    echo "OK    $unit — already up to date"
  else
    install -m 0644 "$usrc" "$udst"
    echo "COPY  $unit -> $udst"
    changed=true
  fi
done

# ── Persistent state dir (last-known-good uplink + reboot cool-down markers) ──
# StateDirectory= in the unit creates this too, but do it here so a manual run
# of the script (outside systemd) also finds it.
mkdir -p /var/lib/network-watchdog

# ── The old script's failure counter semantics differ — start clean ───────────
rm -f /run/net-watchdog-fails

if [ "$changed" = "true" ]; then
  systemctl daemon-reload
fi

# Safe to repeat; also covers boxes provisioned before the timer existed.
systemctl enable --now network-watchdog.timer
echo "OK    network-watchdog.timer enabled"

# Run one check immediately so the fresh logic is visible in this update's log
# (and so a genuinely isolated device starts its 20-minute clock now rather than
# up to 10 minutes from now).  A failing check must NOT fail the migration —
# it exits 1 by design when the box has no uplink.
systemctl start network-watchdog.service || true
journalctl -t network-watchdog -n 10 --no-pager -q 2>/dev/null | sed 's/^/      /' || true

echo "Network watchdog updated (uplink-aware; hotspot no longer counts as reachable)."
