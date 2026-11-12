#!/usr/bin/env bash
# 0032-ble-socket-dir.sh — give the BLE socket a directory that always exists.
#
# 0029 made /run/digitalpool-camera a RuntimeDirectory= of
# digitalpool-camera.service. That was wrong in a way that only shows on a box
# where the directory does not already exist — which is every box at first
# install, and any boot where digitalpool-ble.service starts first:
#
#   digitalpool-ble.service: Failed to set up mount namespacing:
#     /run/digitalpool-camera: No such file or directory
#   Control process exited, code=exited, status=226/NAMESPACE
#
# The unit has ReadWritePaths=/run/digitalpool-camera because ProtectSystem=
# strict makes everything else read-only. systemd sets that bind mount up
# BEFORE ExecStart, so a missing path kills the unit before any of its own code
# runs, in a restart loop, with an error that names mount namespacing rather
# than the thing that is actually wrong. It is a bad failure to debug at a
# venue.
#
# Worse, RuntimeDirectory= tied the directory's lifetime to the Node service,
# when the whole point of digitalpool-ble.service is that it is INDEPENDENT of
# it (BLUETOOTH_ONBOARDING.md §4.2) — it keeps advertising and answers
# UNAVAILABLE while Node is away. A socket directory that disappears whenever
# Node stops is the opposite of that.
#
# So the directory now belongs to neither service: tmpfiles.d creates it at
# boot, before anything that needs it, and nothing removes it. A stale socket
# left by a crash is handled where it always was — bleBridge.js unlinks it at
# startup.
#
# Idempotent.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER=dp

# ── 1. The directory, owned by nobody's service ───────────────────────────
cat > /etc/tmpfiles.d/digitalpool-camera.conf <<'CONF'
# Managed by digitalpool-camera migration 0032-ble-socket-dir.sh.
# bleBridge.js opens ble.sock in here and ble/dp-ble.py connects to it; both
# run as dp. Created at boot so neither service depends on the other having
# started first. See BLUETOOTH_ONBOARDING.md §4.3.
d /run/digitalpool-camera 0700 dp dp -
CONF

# Create it now as well, so this run does not have to wait for a reboot.
systemd-tmpfiles --create /etc/tmpfiles.d/digitalpool-camera.conf
if [ ! -d /run/digitalpool-camera ]; then
  # Older systemd, or a tmpfiles refusal — do it by hand rather than leave the
  # BLE daemon in a crash loop.
  mkdir -p /run/digitalpool-camera
  chown "$APP_USER:$APP_USER" /run/digitalpool-camera
  chmod 0700 /run/digitalpool-camera
fi
echo "   $(ls -ld /run/digitalpool-camera)"

# ── 2. Stop the camera service owning its lifetime ────────────────────────
rm -f /etc/systemd/system/digitalpool-camera.service.d/20-ble-runtime-dir.conf
# The repo's own copy of the unit lost RuntimeDirectory= at the same time; a
# box whose installed unit came from the repo needs it refreshed.
if [ -f "$REPO_DIR/digitalpool-camera.service" ] \
   && [ -f /etc/systemd/system/digitalpool-camera.service ] \
   && ! cmp -s "$REPO_DIR/digitalpool-camera.service" /etc/systemd/system/digitalpool-camera.service; then
  install -m 0644 "$REPO_DIR/digitalpool-camera.service" /etc/systemd/system/digitalpool-camera.service
  echo "   refreshed digitalpool-camera.service"
fi

# ── 3. The BLE unit tolerates a missing directory now ─────────────────────
if [ -f "$REPO_DIR/digitalpool-ble.service" ]; then
  install -m 0644 "$REPO_DIR/digitalpool-ble.service" /etc/systemd/system/digitalpool-ble.service
fi

systemctl daemon-reload

# ── 4. Bring it up ────────────────────────────────────────────────────────
if [ -d /sys/class/bluetooth ] && [ -n "$(ls -A /sys/class/bluetooth 2>/dev/null)" ]; then
  systemctl enable digitalpool-ble.service >/dev/null 2>&1 || true
  systemctl reset-failed digitalpool-ble.service 2>/dev/null || true
  systemctl restart digitalpool-ble.service || true
  sleep 3
  if systemctl is-active --quiet digitalpool-ble.service; then
    echo "   digitalpool-ble.service is running"
    journalctl -u digitalpool-ble --no-pager -n 6 2>/dev/null | sed 's/^/     /' || true
  else
    echo "   ⚠ digitalpool-ble.service still not up — see journalctl -u digitalpool-ble"
  fi
else
  echo "   no Bluetooth controller on this board — nothing to start"
fi

echo "BLE socket directory is now independent of both services."
