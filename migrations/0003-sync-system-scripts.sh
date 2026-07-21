#!/usr/bin/env bash
# 0003-sync-system-scripts.sh — re-install the host scripts that live OUTSIDE the
# repo so edits committed to them actually reach the running system.
#
# The normal software update is `git reset --hard` on /home/dp/digitalpool-camera.
# That updates ONLY files inside the repo.  Several scripts are copied at
# provisioning time to /usr/local/{sbin,bin} and executed from there by systemd
# (see README) — a git update never touches those copies, so any change to the
# repo original silently never ships.
#
# This bit us with the hotspot SSID: commit 20743ce changed dp-hotspot.sh to
# derive the SSID from the wired ethernet MAC (matching the dp-stream-<XXXX>
# hostname / NetBird name) instead of the WiFi dongle MAC, but already-provisioned
# devices kept running the OLD /usr/local/sbin/dp-hotspot.sh and their SSID never
# changed.  This migration copies the current repo versions into place and, only
# when dp-hotspot.sh actually changed, restarts digitalpool-hotspot.service so its
# built-in SSID-mismatch check recreates the NM profile with the new name.
#
# Copy-if-changed: a script whose installed copy already matches is skipped, so
# nothing is needlessly overwritten and no service is bounced without cause.
# Idempotent — safe to run repeatedly.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# repo-basename  ->  absolute install destination
declare -A DEST=(
  [dp-hotspot.sh]=/usr/local/sbin/dp-hotspot.sh
  [network-watchdog.sh]=/usr/local/bin/network-watchdog.sh
  [monitor-camera.sh]=/usr/local/bin/monitor-camera.sh
  [mediamtx-update-hosts.sh]=/usr/local/bin/mediamtx-update-hosts.sh
)

hotspot_changed=false

for name in "${!DEST[@]}"; do
  src="$REPO_DIR/$name"
  dst="${DEST[$name]}"

  if [ ! -f "$src" ]; then
    echo "SKIP  $name — not present in repo ($src)"
    continue
  fi

  # Only touch the destination if it's missing or differs from the repo copy.
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    echo "OK    $name — already up to date"
    continue
  fi

  mkdir -p "$(dirname "$dst")"
  install -m 0755 "$src" "$dst"
  echo "COPY  $name -> $dst"
  [ "$name" = "dp-hotspot.sh" ] && hotspot_changed=true
done

# dp-hotspot.sh runs as the digitalpool-hotspot oneshot service; restarting it
# re-executes the new script, which recreates the AP profile when the SSID it
# now computes differs from the profile's current SSID.  Only restart when the
# script actually changed — a restart briefly drops connected hotspot clients.
if [ "$hotspot_changed" = "true" ]; then
  if systemctl list-unit-files digitalpool-hotspot.service &>/dev/null; then
    echo "dp-hotspot.sh changed — restarting digitalpool-hotspot.service to re-apply SSID..."
    systemctl restart digitalpool-hotspot.service || {
      echo "WARN  could not restart digitalpool-hotspot.service — SSID will update on next boot." >&2
    }
  else
    echo "dp-hotspot.sh changed but digitalpool-hotspot.service is not installed — new SSID applies when the hotspot next runs."
  fi
fi

echo "System-script sync complete."
