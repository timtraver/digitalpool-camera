#!/bin/bash
# dp-hotspot.sh — DigitalPool Camera WiFi Hotspot initialiser
#
# Managed by systemd as digitalpool-hotspot.service (runs as root).
# Detects whichever WiFi adapter is present (USB dongle, built-in, etc.),
# creates or recreates the NetworkManager AP profile when needed (e.g. after
# cloning the SD card to a device with a different dongle), and brings up
# the hotspot.  Runs before digitalpool-camera.service so the AP is always
# available even if the Node.js app crashes.
#
# Install:
#   sudo cp dp-hotspot.sh /usr/local/sbin/dp-hotspot.sh
#   sudo chmod +x /usr/local/sbin/dp-hotspot.sh
#   sudo cp digitalpool-hotspot.service /etc/systemd/system/
#   sudo systemctl daemon-reload
#   sudo systemctl enable --now digitalpool-hotspot.service

set -euo pipefail

PROFILE_NAME="DigitalPool-Hotspot"
DEFAULT_SSID="DigitalPool-Camera"
DEFAULT_PASSWORD="Digitalpool"
AP_IP="192.168.50.1"
AP_SUBNET="24"
AP_CHANNEL="6"
APP_PORT="${PORT:-3000}"
DNSMASQ_DIR="/etc/NetworkManager/dnsmasq-shared.d"
DNSMASQ_CONF="$DNSMASQ_DIR/captive-portal.conf"
MAX_WAIT=60    # seconds to wait for interface to become ready
INTERVAL=3

# ── Step 1: find the WiFi interface ─────────────────────────────────────────
IFACE=$(nmcli -t -f DEVICE,TYPE device 2>/dev/null | grep ':wifi' | head -1 | cut -d: -f1 || true)
if [ -z "$IFACE" ]; then
    IFACE=$(ip link show 2>/dev/null | grep -Eo 'wl[^:]+' | head -1 || true)
fi
if [ -z "$IFACE" ]; then
    echo "❌ No WiFi interface found — hotspot unavailable" >&2
    exit 1
fi
echo "📡 WiFi interface: $IFACE"

# ── Step 2: wait for the interface to be ready (NM state ≥ 30) ──────────────
echo "⏳ Waiting for $IFACE (up to ${MAX_WAIT}s)..."
nmcli device set "$IFACE" managed yes 2>/dev/null || true
WAITED=0
while [ "$WAITED" -lt "$MAX_WAIT" ]; do
    STATE=$(nmcli -t -f GENERAL.STATE device show "$IFACE" 2>/dev/null \
            | grep -Eo '[0-9]+' | head -1 || echo "0")
    if [ "${STATE:-0}" -ge 30 ]; then
        echo "✅ $IFACE ready (NM state $STATE)"
        break
    fi
    echo "   state=${STATE:-?} — waiting ${INTERVAL}s..."
    sleep "$INTERVAL"
    WAITED=$((WAITED + INTERVAL))
done

# ── Step 3: check profile / handle new hardware ──────────────────────────────
NEED_CREATE=false
SSID="$DEFAULT_SSID"
PASSWORD="$DEFAULT_PASSWORD"

if nmcli connection show "$PROFILE_NAME" &>/dev/null; then
    BOUND=$(nmcli -t -f connection.interface-name connection show "$PROFILE_NAME" 2>/dev/null \
            | grep 'connection\.interface-name:' | cut -d: -f2 | tr -d '[:space:]' || true)
    if [ -n "$BOUND" ] && [ "$BOUND" != "--" ] && [ "$BOUND" != "$IFACE" ]; then
        echo "⚠️  Profile bound to '$BOUND', current interface '$IFACE' — recreating"
        # Preserve existing credentials before deleting
        OLD_SSID=$(nmcli -t -f 802-11-wireless.ssid connection show "$PROFILE_NAME" 2>/dev/null \
                   | cut -d: -f2 | tr -d '[:space:]' || true)
        OLD_PSK=$(nmcli --show-secrets -t -f 802-11-wireless-security.psk \
                  connection show "$PROFILE_NAME" 2>/dev/null \
                  | cut -d: -f2 | tr -d '[:space:]' || true)
        SSID="${OLD_SSID:-$DEFAULT_SSID}"
        PASSWORD="${OLD_PSK:-$DEFAULT_PASSWORD}"
        nmcli connection delete "$PROFILE_NAME" 2>/dev/null || true
        NEED_CREATE=true
    else
        echo "✅ Profile exists and matches interface — skipping create"
    fi
else
    echo "📡 No profile found — will create"
    NEED_CREATE=true
fi

# ── Step 4: create NM profile if needed ─────────────────────────────────────
if [ "$NEED_CREATE" = "true" ]; then
    echo "📡 Creating AP profile (SSID: $SSID, iface: $IFACE)"
    nmcli connection add \
        type wifi \
        ifname "$IFACE" \
        con-name "$PROFILE_NAME" \
        autoconnect no \
        ssid "$SSID" \
        -- \
        wifi.mode ap \
        wifi.band bg \
        wifi.channel "$AP_CHANNEL" \
        wifi-sec.key-mgmt wpa-psk \
        wifi-sec.psk "$PASSWORD" \
        ipv4.method shared \
        ipv4.addresses "$AP_IP/$AP_SUBNET" \
        ipv6.method ignore
    echo "✅ Profile created"
fi


# ── Step 5: captive portal — dnsmasq resolves all hostnames to AP IP ─────────
mkdir -p "$DNSMASQ_DIR"
printf "# Redirect all DNS queries to the AP for captive portal\naddress=/#/%s\n" "$AP_IP" \
    > "$DNSMASQ_CONF"
echo "✅ Captive portal dnsmasq config written"
systemctl reload NetworkManager 2>/dev/null || true
sleep 1   # give NM a moment to reload dnsmasq config

# ── Step 6: bring up the AP ──────────────────────────────────────────────────
MAX_RETRIES=5
RETRY_DELAY=5
for i in $(seq 1 "$MAX_RETRIES"); do
    echo "📡 Starting hotspot (attempt $i/$MAX_RETRIES)..."
    if nmcli connection up "$PROFILE_NAME"; then
        echo "✅ Hotspot up — SSID: $SSID  IP: $AP_IP"
        break
    fi
    if [ "$i" -lt "$MAX_RETRIES" ]; then
        echo "   Retrying in ${RETRY_DELAY}s..."
        sleep "$RETRY_DELAY"
    else
        echo "❌ Hotspot failed to start after $MAX_RETRIES attempts" >&2
        exit 1
    fi
done

# ── Step 7: captive portal — iptables port-80 → app redirect ─────────────────
# Devices probe http port 80; our app listens on $APP_PORT.  The PREROUTING
# REDIRECT rule forwards them transparently without the user needing to type
# the port number.
RULE="-t nat -A PREROUTING -i $IFACE -p tcp --dport 80 -j REDIRECT --to-port $APP_PORT"
iptables "${RULE/-A/-D}" 2>/dev/null || true   # remove stale rule first
if iptables $RULE 2>/dev/null; then
    echo "✅ Captive portal: port 80 → $APP_PORT redirect active on $IFACE"
else
    echo "⚠️  iptables redirect failed (service runs as root — check kernel modules)" >&2
fi
