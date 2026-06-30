#!/bin/bash
# dp-device-reset.sh — DigitalPool Camera clone/re-deploy reset tool
#
# Resets a cloned device to a clean state:
#   • New hostname (dp-stream-N)
#   • Fresh machine-id and SSH host keys (so each unit is unique on the network)
#   • Wiped NetBird peer identity (device gets a new VPN peer on next registration)
#   • Cleared app state: registration, users, camera config, stream config, etc.
#
# Usage:
#   sudo bash dp-device-reset.sh          # interactive
#   sudo bash dp-device-reset.sh --yes    # skip confirmation prompt

set -euo pipefail

APP_DIR="/home/dp/digitalpool-camera"
APP_USER="dp"

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
info()  { echo -e "${GREEN}  ✔  $*${NC}"; }
warn()  { echo -e "${YELLOW}  ⚠  $*${NC}"; }
fatal() { echo -e "${RED}  ✘  $*${NC}" >&2; exit 1; }

# ── Must run as root ──────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || fatal "Run with sudo: sudo bash $0"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   DigitalPool Camera — Device Reset / Re-Deploy"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Ask for hostname number ───────────────────────────────────────────────────
while true; do
    read -rp "  Enter stream number for this unit (e.g. 1 → dp-stream-1): " STREAM_NUM
    if [[ "$STREAM_NUM" =~ ^[0-9]+$ ]] && [[ "$STREAM_NUM" -ge 1 ]] && [[ "$STREAM_NUM" -le 999 ]]; then
        NEW_HOSTNAME="dp-stream-${STREAM_NUM}"
        break
    fi
    warn "Enter a number between 1 and 999."
done

echo ""
echo "  New hostname : ${NEW_HOSTNAME}"
echo "  App dir      : ${APP_DIR}"
echo ""
echo "  This will PERMANENTLY wipe:"
echo "    • System hostname, machine-id, SSH host keys"
echo "    • NetBird peer identity (/var/lib/netbird/)"
echo "    • All app state (registration, users, camera/stream config)"
echo ""

# ── Confirmation ──────────────────────────────────────────────────────────────
SKIP_CONFIRM=false
[[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]] && SKIP_CONFIRM=true

if ! $SKIP_CONFIRM; then
    read -rp "  Proceed? (yes/no): " CONFIRM
    [[ "$CONFIRM" == "yes" ]] || { echo "  Aborted."; exit 0; }
fi

echo ""

# ── 1. Stop services ──────────────────────────────────────────────────────────
echo "⏹  Stopping services…"
systemctl stop digitalpool-camera 2>/dev/null || true
systemctl stop netbird             2>/dev/null || true
sleep 1
info "Services stopped"

# ── 2. Hostname ───────────────────────────────────────────────────────────────
echo "🏷  Setting hostname to ${NEW_HOSTNAME}…"
hostnamectl set-hostname "${NEW_HOSTNAME}"
# Also update /etc/hosts so local resolution doesn't break
sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t${NEW_HOSTNAME}/" /etc/hosts
grep -q "127.0.1.1" /etc/hosts || echo -e "127.0.1.1\t${NEW_HOSTNAME}" >> /etc/hosts
info "Hostname set"

# ── 3. Machine ID ─────────────────────────────────────────────────────────────
echo "🔑  Regenerating machine-id…"
rm -f /etc/machine-id /var/lib/dbus/machine-id
systemd-machine-id-setup
info "Machine-id regenerated: $(cat /etc/machine-id)"

# ── 4. SSH host keys ──────────────────────────────────────────────────────────
echo "🔐  Regenerating SSH host keys…"
rm -f /etc/ssh/ssh_host_*
ssh-keygen -A -q
info "SSH host keys regenerated"

# ── 5. NetBird peer identity ──────────────────────────────────────────────────
echo "🌐  Wiping NetBird peer identity…"
rm -rf /var/lib/netbird/
systemctl start netbird 2>/dev/null || true   # restart daemon in NeedsLogin state
info "NetBird identity cleared (device will re-register on next activation)"

# ── 6. App state files ────────────────────────────────────────────────────────
echo "🗂  Clearing app state…"
APP_STATE_FILES=(
    "remote.json"
    "users.json"
    "camera-config.json"    "camera-config-2.json"
    "camera-startup-config.json" "camera-startup-config-2.json"
    "stream-config.json"    "stream-config-2.json"
    "camera-source.json"    "camera-source-2.json"
    "ethernet-config.json"
    "banned-ips.json"
    "viewer-connections.json"
)
for f in "${APP_STATE_FILES[@]}"; do
    fp="${APP_DIR}/${f}"
    if [[ -f "$fp" ]]; then
        rm -f "$fp"
        info "Removed $f"
    fi
done

# ── 7. Netplan ethernet override (back to DHCP) ───────────────────────────────
NETPLAN_FILE="/etc/netplan/99-digitalpool-ethernet.yaml"
if [[ -f "$NETPLAN_FILE" ]]; then
    rm -f "$NETPLAN_FILE"
    netplan apply 2>/dev/null || true
    info "Ethernet config reset to DHCP"
fi

# ── 8. GStreamer cache ────────────────────────────────────────────────────────
GST_CACHE="/home/${APP_USER}/.cache/gstreamer-1.0"
if [[ -d "$GST_CACHE" ]]; then
    rm -f "${GST_CACHE}"/*.bin
    info "GStreamer registry cache cleared"
fi

# ── 9. Restart app ────────────────────────────────────────────────────────────
echo "🚀  Starting digitalpool-camera service…"
systemctl start digitalpool-camera
sleep 2
if systemctl is-active --quiet digitalpool-camera; then
    info "Service started — device is ready"
else
    warn "Service did not start cleanly. Check: journalctl -u digitalpool-camera -n 30"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}  ✅  Reset complete — ${NEW_HOSTNAME} is ready to deploy${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Connect to hotspot: DigitalPool-Camera"
echo "  Then open:          http://192.168.50.1:3000"
echo "  Register via:       Remote Access tab → Register Device"
echo ""
