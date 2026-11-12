#!/usr/bin/env bash
# 0029-ble-daemon.sh — run the BLE onboarding daemon, and give Node somewhere
# to put its socket.
#
# 0028 installed the Bluetooth stack. This starts the thing that uses it:
# ble/dp-ble.py, which advertises the box, serves the GATT service a phone
# connects to, and pipes whole messages to bleBridge.js in Node over
# /run/digitalpool-camera/ble.sock. See BLUETOOTH_ONBOARDING.md §4.
#
# Two pieces beyond the unit file:
#
#   * A drop-in giving digitalpool-camera.service RuntimeDirectory=, because
#     /run is not writable by dp. systemd creates the directory at start and
#     removes it at stop, so a socket can never outlive the process that made
#     it. The repo's own copy of the unit has the same lines for fresh images;
#     the drop-in is what reaches boxes already in the field, whose installed
#     unit nothing re-syncs.
#
#   * ONBOARDING_MODE in .env, defaulting to `hotspot` on a box that has
#     already been set up (§8.1 D7). A venue tablet may live on that hotspot,
#     and an update must not take it away. Switching a working box to BLE is a
#     deliberate admin action, not something a migration does behind anybody's
#     back.
#
# The unit is enabled whatever the mode says, and the mode is read by the
# DAEMON rather than acted on here. That is deliberate: enabling or disabling a
# unit needs root, the app runs as `dp`, and `dp` is allowed exactly one
# privileged thing — starting this migrations service. Gating systemd on the
# mode would leave the "Onboard WiFi: hotspot / internet" control in §8.1 with
# no way to act. dp-ble.py re-reads ONBOARDING_MODE on every 60-second
# self-check instead, and in `hotspot` mode stays resident and silent: no
# advertisement, no GATT application, nothing a phone can see. So changing mode
# is an .env write the app can do for itself.
#
# It deliberately does NOT restart digitalpool-camera.service. That unit is
# ordered After= this one, so restarting it from in here makes systemd queue a
# job behind the service that is still running and the migration hangs until it
# is killed. It is also unnecessary: at boot this runs Before= the app starts,
# and on an update /api/update restarts the app immediately afterwards.
#
# A board with no Bluetooth controller is not a failure: it keeps its hotspot
# and the unit stays off.
#
# Idempotent.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER=dp

# ── 1. Somewhere for the socket ───────────────────────────────────────────
DROPIN_DIR=/etc/systemd/system/digitalpool-camera.service.d
mkdir -p "$DROPIN_DIR"
cat > "$DROPIN_DIR/20-ble-runtime-dir.conf" <<'CONF'
# Added by migration 0029-ble-daemon.sh.
# bleBridge.js opens /run/digitalpool-camera/ble.sock; dp cannot create that
# directory itself. 0700 and owned by dp, which is also what dp-ble.py runs as.
[Service]
RuntimeDirectory=digitalpool-camera
RuntimeDirectoryMode=0700
CONF

# ── 2. The daemon's unit ──────────────────────────────────────────────────
if [ ! -f "$REPO_DIR/digitalpool-ble.service" ]; then
  echo "❌ $REPO_DIR/digitalpool-ble.service not found"
  exit 1
fi
install -m 0644 "$REPO_DIR/digitalpool-ble.service" /etc/systemd/system/digitalpool-ble.service
systemctl daemon-reload

# ── 3. Which onboarding this box uses ─────────────────────────────────────
ENV_FILE="$REPO_DIR/.env"
touch "$ENV_FILE"
chown "$APP_USER:$APP_USER" "$ENV_FILE" 2>/dev/null || true

if grep -q '^ONBOARDING_MODE=' "$ENV_FILE" 2>/dev/null; then
  echo "   ONBOARDING_MODE already set: $(grep '^ONBOARDING_MODE=' "$ENV_FILE" | tail -1)"
else
  # "Already set up" means any of the things a configured box has. A box with
  # none of them has never been onboarded, so BLE costs it nothing.
  MODE=auto
  for marker in remote.json users.json; do
    [ -s "$REPO_DIR/$marker" ] && MODE=hotspot
  done
  # A saved WiFi profile that is not our own AP means somebody configured this
  # box's network by hand, which is the other sign of a box in service.
  if nmcli -t -f TYPE,NAME connection show 2>/dev/null \
       | grep '^802-11-wireless:' | grep -qv 'DigitalPool'; then
    MODE=hotspot
  fi
  echo "ONBOARDING_MODE=$MODE" >> "$ENV_FILE"
  echo "   set ONBOARDING_MODE=$MODE"
fi

MODE="$(grep -h '^ONBOARDING_MODE=' "$ENV_FILE" | tail -1 | cut -d= -f2 | tr -d '[:space:]')"
MODE="${MODE:-auto}"

# ── 4. Run the daemon wherever there is a radio for it ────────────────────
if [ -d /sys/class/bluetooth ] && [ -n "$(ls -A /sys/class/bluetooth 2>/dev/null)" ]; then
  systemctl enable digitalpool-ble.service
  # `|| true` because of `set -e`: without it a service that fails to start
  # aborts the whole migration run here, and the "not fatal" branch below —
  # which is the stated intent — is never reached.
  systemctl restart digitalpool-ble.service || true
  sleep 3
  if systemctl is-active --quiet digitalpool-ble.service; then
    echo "   digitalpool-ble.service running (ONBOARDING_MODE=$MODE)"
    journalctl -u digitalpool-ble --no-pager -n 6 2>/dev/null | sed 's/^/     /' || true
  else
    # Not fatal. A controller that needs a moment must not stop the rest of the
    # migrations from applying.
    echo "   ⚠ digitalpool-ble.service did not come up; see journalctl -u digitalpool-ble"
  fi
else
  echo "   no Bluetooth controller on this board — leaving digitalpool-ble.service disabled"
  systemctl disable digitalpool-ble.service 2>/dev/null || true
fi

echo "BLE onboarding daemon installed (ONBOARDING_MODE=$MODE)."
