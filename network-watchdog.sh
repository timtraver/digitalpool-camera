#!/bin/bash
# network-watchdog.sh — reboot if the device is completely network-isolated.
#
# After an OOM event the kernel network stack can break across ALL interfaces
# (WiFi AND Ethernet), leaving the device running but permanently unreachable.
# A soft service restart can't fix this — only a reboot can.
#
# Strategy:
#   1. For each active interface:
#      a. If the interface is a WiFi AP/hotspot, treat it as reachable — it IS
#         the gateway, there is no upstream host to ping.
#      b. Otherwise, ping the interface's default gateway (or 192.168.50.1).
#   2. If ALL interfaces fail, increment a failure counter.
#   3. After 2 consecutive failures (20 minutes), reboot.
#   4. On any success, reset the counter.
#      If the rtw_8822bu USB WiFi driver shows stuck-queue errors, attempt a
#      USB rebind (Rockchip / USB-adapter hardware only).
#
# Run by network-watchdog.timer every 10 minutes.

LOG_TAG="network-watchdog"
FAIL_FILE="/run/net-watchdog-fails"
MAX_FAILS=2          # reboot after this many consecutive all-interface failures
WIFI_DRIVER="rtw_8822bu"

# ── Detect if an interface is operating as a WiFi Access Point ───────────────
# When it is, the device IS the gateway — no upstream host to ping.
# Returns 0 (true) if AP mode, 1 (false) otherwise.
is_ap_mode() {
    local iface="$1"
    iw dev "$iface" info 2>/dev/null | grep -q "type AP"
}

# ── Test one interface: pass if AP mode, otherwise ping its default gateway ──
ping_iface() {
    local iface="$1"
    # AP/hotspot interface: this device is the gateway — always consider reachable.
    if is_ap_mode "$iface"; then
        logger -t "$LOG_TAG" "ℹ️   $iface is a WiFi AP (hotspot) — treating as reachable"
        return 0
    fi
    local gw
    gw=$(ip route show dev "$iface" 2>/dev/null | awk '/default/ {print $3; exit}')
    # No default route on this interface — try pinging the AP IP instead
    [ -z "$gw" ] && gw="192.168.50.1"
    ping -I "$iface" -c 2 -W 3 "$gw" &>/dev/null
}

# ── Collect all UP interfaces (exclude loopback) ─────────────────────────────
mapfile -t IFACES < <(ip -o link show up | awk -F': ' '{print $2}' | grep -v '^lo$')

ANY_OK=0
for iface in "${IFACES[@]}"; do
    if ping_iface "$iface"; then
        logger -t "$LOG_TAG" "✅  $iface reachable"
        ANY_OK=1
    else
        logger -t "$LOG_TAG" "⚠️  $iface NOT reachable"
    fi
done

# ── All interfaces failed ─────────────────────────────────────────────────────
if [ "$ANY_OK" -eq 0 ]; then
    FAILS=$(cat "$FAIL_FILE" 2>/dev/null || echo 0)
    FAILS=$(( FAILS + 1 ))
    echo "$FAILS" > "$FAIL_FILE"
    logger -t "$LOG_TAG" "❌  All interfaces unreachable — consecutive failures: $FAILS / $MAX_FAILS"

    if [ "$FAILS" -ge "$MAX_FAILS" ]; then
        logger -t "$LOG_TAG" "🔴  Failure threshold reached — rebooting to restore network"
        # Write reason to disk so it survives the reboot
        echo "$(date): network-watchdog triggered reboot after $FAILS consecutive failures" \
            >> /var/log/network-watchdog-reboots.log
        systemctl reboot
    fi
    exit 1
fi

# ── At least one interface is up — reset failure counter ─────────────────────
echo 0 > "$FAIL_FILE"

# ── Opportunistic WiFi driver reset if stuck-queue errors are present ─────────
# grep -c always prints a count (even "0") — drop the || echo 0 which caused
# STUCK to become "0\n0" when there were no matches (grep exits 1 on zero matches,
# triggering the || branch even though grep had already output "0").
STUCK=$(journalctl -k --since "15 minutes ago" --no-pager -q 2>/dev/null \
        | grep -c "timed out to flush queue")

if [ "$STUCK" -gt 0 ]; then
    logger -t "$LOG_TAG" "⚠️  rtw_8822bu queue-flush errors detected ($STUCK) — attempting USB rebind"

    WIFI_IFACE=""
    for dir in /sys/class/net/*/device/driver; do
        [ -e "$dir" ] || continue
        drv=$(basename "$(readlink -f "$dir")")
        if [ "$drv" = "$WIFI_DRIVER" ]; then
            WIFI_IFACE=$(basename "$(dirname "$(dirname "$dir")")")
            break
        fi
    done

    if [ -n "$WIFI_IFACE" ]; then
        USB_DEV=$(readlink -f "/sys/class/net/$WIFI_IFACE/device" 2>/dev/null)
        USB_BIND_PATH=$(dirname "$USB_DEV")
        USB_ID=$(basename "$USB_DEV")

        if [ -n "$USB_ID" ] && [ -w "$USB_BIND_PATH/unbind" ]; then
            echo "$USB_ID" > "$USB_BIND_PATH/unbind" 2>/dev/null
            sleep 3
            echo "$USB_ID" > "$USB_BIND_PATH/bind"   2>/dev/null
            sleep 5
            systemctl restart NetworkManager
            logger -t "$LOG_TAG" "✅  WiFi USB rebind complete — NetworkManager restarted"
        fi
    fi
fi
