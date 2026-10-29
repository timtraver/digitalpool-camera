#!/bin/bash
# dp-firstboot.sh — one-shot sanitiser that runs on the FIRST boot of a device
# that was flashed from a golden image (see dp-create-image.sh / dp-restore.sh).
#
# It is the non-interactive sibling of dp-device-reset.sh: it turns a byte-for-byte
# clone into a unique unit, then permanently disables itself so it never runs again.
#
#   • Fresh machine-id  (generated FIRST so the hostname can borrow its entropy)
#   • Neutral unique hostname  dp-stream-<4 hex>  (operator renames via the UI)
#   • Fresh SSH host keys
#   • Wiped NetBird peer identity  (re-registers on next activation)
#   • Deleted WiFi profiles  (so the hotspot is rebuilt with THIS unit's SSID,
#     and the master's saved networks and their passwords do not ship with it)
#   • Cleared app state (registration, users, camera/stream config, …)
#   • Regenerated SESSION_SECRET  (so cloned units don't share a cookie secret)
#   • Ethernet back to DHCP, GStreamer cache cleared
#
# Installed + enabled by dp-restore.sh via dp-firstboot.service.  Guarded by a
# flag file so a failed self-disable can't cause a re-run.

set -uo pipefail   # NOT -e: best-effort; one failed step must not abort the rest

APP_DIR="/home/dp/digitalpool-camera"
APP_USER="dp"
FLAG="/var/lib/dp-image/firstboot-pending"
LOG="/var/log/dp-firstboot.log"

exec > >(tee -a "$LOG") 2>&1
echo "── dp-firstboot $(date -u +%Y-%m-%dT%H:%M:%SZ) ──"

# Guard: only run when the pending flag is present.
if [[ ! -f "$FLAG" ]]; then
    echo "No firstboot flag present — nothing to do; disabling service."
    systemctl disable dp-firstboot.service 2>/dev/null || true
    exit 0
fi

# ── 1. Machine ID ──────────────────────────────────────────────────────────────
echo "Regenerating machine-id…"
rm -f /etc/machine-id /var/lib/dbus/machine-id
systemd-machine-id-setup
MID="$(cat /etc/machine-id 2>/dev/null || echo 0000)"

# ── 2. Hostname — dp-stream-<last 4 of primary MAC> ─────────────────────────────
# Derive the suffix from a real NIC's burned-in MAC (stable across reboots, and
# unique per unit).  Prefer wired (en*/eth*), then WiFi (wl*), then any physical
# interface; fall back to the machine-id if no NIC MAC can be read.
primary_mac() {
    local iface mac
    for iface in $(ls /sys/class/net 2>/dev/null | grep -E '^(en|eth)') \
                 $(ls /sys/class/net 2>/dev/null | grep -E '^wl') \
                 $(ls /sys/class/net 2>/dev/null); do
        [[ "$iface" == "lo" ]] && continue
        [[ -e "/sys/class/net/$iface/device" ]] || continue   # skip virtual ifaces
        mac="$(cat "/sys/class/net/$iface/address" 2>/dev/null)"
        [[ -n "$mac" && "$mac" != "00:00:00:00:00:00" ]] && { echo "$mac"; return; }
    done
}
MAC="$(primary_mac)"
if [[ -n "$MAC" ]]; then
    NOCOLON="${MAC//:/}"; SUFFIX="${NOCOLON: -4}"
    echo "Using MAC ${MAC} → suffix ${SUFFIX}"
else
    SUFFIX="${MID: -4}"; [[ -n "$SUFFIX" ]] || SUFFIX="new"
    echo "No NIC MAC found — falling back to machine-id suffix ${SUFFIX}"
fi

NEW_HOSTNAME="dp-stream-${SUFFIX}"
echo "Setting hostname to ${NEW_HOSTNAME}…"
# /etc/hostname is what survives the reboot at the end of this script, so it is
# written directly and first. hostnamectl alone used to do this job, but it talks
# to systemd-hostnamed over D-Bus, and this unit runs early enough in boot that
# the call can fail — silently, because this script is deliberately not `set -e`.
# A unit built on 2026-10-29 came up as its master, dp-stream-b1b5, and nothing
# ever retried: the flag had already been cleared and the service disabled.
echo "${NEW_HOSTNAME}" > /etc/hostname
hostnamectl set-hostname "${NEW_HOSTNAME}" 2>/dev/null \
    || echo "  (hostnamectl unavailable this early — /etc/hostname carries it over the reboot)"
sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t${NEW_HOSTNAME}/" /etc/hosts
grep -q "127.0.1.1" /etc/hosts || echo -e "127.0.1.1\t${NEW_HOSTNAME}" >> /etc/hosts

# ── 3. SSH host keys ────────────────────────────────────────────────────────────
echo "Regenerating SSH host keys…"
rm -f /etc/ssh/ssh_host_*
ssh-keygen -A -q

# ── 4. NetBird peer identity ────────────────────────────────────────────────────
# Just remove the identity — do NOT `systemctl start/stop netbird` here. This unit
# is ordered Before=netbird.service, so calling `systemctl start netbird` deadlocks
# (systemd won't start netbird until we finish, and we'd be waiting on it) until the
# start-timeout fires. netbird starts clean on the reboot at the end of this script.
echo "Wiping NetBird peer identity…"
rm -rf /var/lib/netbird/

# ── 5. App state files ──────────────────────────────────────────────────────────
echo "Clearing app state…"
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
    "subscription.json"
    "table-names.json"      # which table each camera covers AT THE MASTER'S venue
)
for f in "${APP_STATE_FILES[@]}"; do
    rm -f "${APP_DIR}/${f}" && echo "  removed ${f}" || true
done

# DELIBERATELY NOT cleared: /var/lib/digitalpool-camera/applied-migrations.txt
# (the host-config migration record).  A golden image is captured from a
# fully-migrated device, so that file lists the baked-in migrations (0001…N) as
# already applied.  Preserving it here means a cloned device skips replaying them
# — the image itself is the migration baseline.  Do NOT add it to APP_STATE_FILES.
# (New migrations numbered above the baseline still run normally on the clone.)

# Seed remote.json with the device name = hostname.  The name is NOT operator-
# settable in the UI — it is permanently this unit's hostname (dp-stream-<4 hex>).
# The device is still unregistered (no owner email / NetBird identity) until the
# operator registers it.
echo "Seeding remote.json with deviceName=${NEW_HOSTNAME}…"
cat > "${APP_DIR}/remote.json" <<EOF
{
  "deviceName": "${NEW_HOSTNAME}",
  "enabled": false,
  "registered": false,
  "ownerEmail": "",
  "registeredAt": null
}
EOF
chown "${APP_USER}:${APP_USER}" "${APP_DIR}/remote.json" 2>/dev/null || true

# ── 6. Regenerate SESSION_SECRET in .env ────────────────────────────────────────
ENV_FILE="${APP_DIR}/.env"
if [[ -f "$ENV_FILE" ]]; then
    echo "Regenerating SESSION_SECRET…"
    NEW_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | xxd -p | tr -d '\n')"
    if grep -q '^SESSION_SECRET=' "$ENV_FILE"; then
        sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${NEW_SECRET}|" "$ENV_FILE"
    else
        echo "SESSION_SECRET=${NEW_SECRET}" >> "$ENV_FILE"
    fi
    chown "${APP_USER}:${APP_USER}" "$ENV_FILE" 2>/dev/null || true
fi

# ── 7. Netplan ethernet override → DHCP ─────────────────────────────────────────
NETPLAN_FILE="/etc/netplan/99-digitalpool-ethernet.yaml"
if [[ -f "$NETPLAN_FILE" ]]; then
    rm -f "$NETPLAN_FILE"
    netplan apply 2>/dev/null || true
    echo "Ethernet reset to DHCP"
fi

# ── 7b. WiFi profiles — the clone must not keep the master's ────────────────────
# The hotspot SSID is per-unit ("DigitalPool-<last 4 of the wired MAC>"), but
# wifiManager only derives it when it CREATES the profile, and a clone arrives
# with the master's profile already made. Two units then broadcast one SSID on
# one address (192.168.50.1), and a phone cannot tell them apart — which on
# 2026-10-29 left a new box unreachable, since without a USB dongle its own
# hotspot is the only way in. Deleting the profile makes the app build a fresh
# one, named after this unit, the next time it starts.
#
# Saved client networks go too. They are the master's, which means every unit
# built from an image would otherwise carry the PSK of whatever WiFi the master
# was last joined to, and would try to join it on sight.
if command -v nmcli >/dev/null 2>&1; then
    echo "Clearing WiFi profiles cloned from the master…"
    # TYPE first so everything after the first colon is the name: nmcli escapes a
    # colon inside a name as "\:", which splitting on NAME,TYPE would get wrong.
    nmcli -t -f TYPE,NAME connection show 2>/dev/null \
        | sed -n 's/^802-11-wireless://p' \
        | sed 's/\\:/:/g' \
        | while IFS= read -r profile; do
            [[ -n "$profile" ]] || continue
            echo "  deleting \"${profile}\""
            nmcli connection delete "$profile" >/dev/null 2>&1 || true
        done
fi

# ── 8. GStreamer cache ──────────────────────────────────────────────────────────
GST_CACHE="/home/${APP_USER}/.cache/gstreamer-1.0"
[[ -d "$GST_CACHE" ]] && rm -f "${GST_CACHE}"/*.bin

# ── 9. Make sure the app + hotspot come up on this fresh unit ────────────────────
systemctl enable digitalpool-camera 2>/dev/null || true

# ── 10. Check the rename took, then disable self ────────────────────────────────
# The hostname is the one step whose failure leaves no trace afterwards: a unit
# that comes up as its master looks perfectly healthy until two of them are on a
# network together. If it did not take, the flag stays and the service stays
# enabled so the next boot tries again — and this run does NOT reboot, because
# rebooting on a failing run is a boot loop. Every step above is safe to repeat.
CURRENT_HOSTNAME="$(cat /etc/hostname 2>/dev/null || echo "")"
if [[ "$CURRENT_HOSTNAME" != "$NEW_HOSTNAME" ]]; then
    echo "ERROR: /etc/hostname reads '${CURRENT_HOSTNAME}', expected '${NEW_HOSTNAME}'."
    echo "Leaving the firstboot flag set so the next boot retries. Not rebooting."
    exit 1
fi

echo "First-boot sanitise complete — disabling dp-firstboot.service"
rm -f "$FLAG"
rm -rf /var/lib/dp-image           # drop captured image metadata; no longer needed
systemctl disable dp-firstboot.service 2>/dev/null || true

# Reboot once so the new hostname/machine-id are fully in effect everywhere.
echo "Rebooting into the finished unit (${NEW_HOSTNAME})…"
sync
systemctl reboot
