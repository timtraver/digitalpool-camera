#!/bin/bash
# network-watchdog.sh — reboot if the device has lost every *uplink*.
#
# After an OOM event the kernel network stack can break across ALL interfaces
# (WiFi AND Ethernet), leaving the device running but permanently unreachable.
# A soft service restart can't fix this — only a reboot can.
#
# The AP/hotspot interface is NOT an uplink. Earlier versions treated it as
# "reachable" (the device is its own gateway, nothing upstream to ping), which
# meant the always-on hotspot kept the watchdog permanently satisfied and the
# reboot path could never fire — the device sat there with dead Ethernet, dead
# client WiFi and dead DNS (ERR_NAME_NOT_RESOLVED) forever. The hotspot is now
# reported for context only and never counts toward health.
#
# Strategy:
#   1. Classify every UP interface:
#        - virtual (VPN wt0/nb*/tun*/wg*, bridges, veth, docker) → ignored;
#          they ride on top of a real uplink and can't prove connectivity.
#        - WiFi AP/hotspot                                       → ignored (local only).
#        - physical iface with carrier                            → uplink candidate.
#   2. Healthy if ANY candidate pings its default gateway, OR the box can reach
#      the internet at all (ICMP to a public resolver, or a DNS lookup).
#   3. No candidates at all:
#        - if an uplink was healthy within UPLINK_SEEN_MAX_AGE, the interfaces
#          have vanished → count it as a failure.
#        - otherwise this device simply has no uplink provisioned (venue with no
#          internet) → log and do nothing; rebooting would just loop.
#   4. On failure: try the rtw_8822bu USB rebind first, re-test, and only then
#      increment the consecutive-failure counter.
#   5. After MAX_FAILS consecutive failures (20 minutes), reboot — subject to a
#      cool-down so a device that can't recover doesn't reboot-loop tightly.
#   6. On success, reset the counter and stamp the last-known-good marker.
#
# Run by network-watchdog.timer every 10 minutes.

LOG_TAG="network-watchdog"
FAIL_FILE="/run/net-watchdog-fails"
STATE_DIR="/var/lib/network-watchdog"
UPLINK_SEEN_FILE="$STATE_DIR/uplink-last-ok"
LAST_REBOOT_FILE="$STATE_DIR/last-reboot"
MAX_FAILS=2                     # reboot after this many consecutive failures
REBOOT_COOLDOWN=1800            # seconds — don't reboot again within this window
UPLINK_SEEN_MAX_AGE=86400       # seconds — how long a past-good uplink is "expected"
PING_TARGETS="1.1.1.1 8.8.8.8"  # public ICMP targets for the internet check
DNS_TEST_HOST="digitalpool.com" # resolved as a fallback when ICMP is filtered
AP_ADDR="192.168.50.1"          # hotspot address — see is_ap_mode() fallback
WIFI_DRIVER="rtw_8822bu"

log() { logger -t "$LOG_TAG" "$1"; }

mkdir -p "$STATE_DIR" 2>/dev/null

# ── Interface classification ─────────────────────────────────────────────────
# Virtual interfaces (VPN tunnels, bridges, veth, docker) have no backing
# device in sysfs. They depend on a real uplink, so they prove nothing.
is_virtual() {
    local iface="$1"
    case "$iface" in
        lo|wt*|nb*|tun*|tap*|wg*|tailscale*|docker*|br-*|veth*|virbr*) return 0 ;;
    esac
    [ ! -e "/sys/class/net/$iface/device" ]
}

# When an interface is in AP mode this device IS the gateway — local only.
# The address check is a fallback for boxes where `iw` isn't installed: without
# it the hotspot would look like a carrier-up uplink with no default route and
# be counted as a *failure*, which is the opposite mistake.
is_ap_mode() {
    iw dev "$1" info 2>/dev/null | grep -q "type AP" && return 0
    ip -4 -o addr show dev "$1" 2>/dev/null | grep -q "inet $AP_ADDR/"
}

has_carrier() {
    [ "$(cat "/sys/class/net/$1/carrier" 2>/dev/null)" = "1" ]
}

# ── Reachability probes ──────────────────────────────────────────────────────
ping_gateway() {
    local iface="$1" gw
    gw=$(ip route show dev "$iface" 2>/dev/null | awk '/^default/ {print $3; exit}')
    if [ -z "$gw" ]; then
        log "⚠️   $iface has carrier but no default route"
        return 1
    fi
    ping -I "$iface" -c 2 -W 3 "$gw" &>/dev/null
}

internet_ok() {
    local t
    for t in $PING_TARGETS; do
        if ping -c 1 -W 3 "$t" &>/dev/null; then
            log "🌐  internet reachable (ping $t)"
            return 0
        fi
    done
    # ICMP is often filtered on venue networks — a successful lookup is enough.
    if getent hosts "$DNS_TEST_HOST" &>/dev/null; then
        log "🌐  internet reachable (DNS $DNS_TEST_HOST)"
        return 0
    fi
    return 1
}

# Returns 0 if at least one uplink is healthy, 1 if candidates exist but all
# failed, 2 if there are no uplink candidates at all.
check_uplinks() {
    local iface ok=0 candidates=0

    # Process substitution (not a pipe) so counters below stay in this shell.
    while read -r iface; do
        if is_virtual "$iface"; then
            continue
        fi
        if is_ap_mode "$iface"; then
            log "ℹ️   $iface is a WiFi AP (hotspot) — local only, not an uplink"
            continue
        fi
        if ! has_carrier "$iface"; then
            log "⚠️   $iface has no carrier"
            continue
        fi
        candidates=$(( candidates + 1 ))
        if ping_gateway "$iface"; then
            log "✅  $iface reachable (gateway)"
            ok=1
        else
            log "⚠️   $iface NOT reachable"
        fi
    done < <(ip -o link show up | awk -F': ' '{print $2}' | cut -d@ -f1)

    [ "$candidates" -eq 0 ] && return 2
    [ "$ok" -eq 1 ] && return 0
    # Gateway pings all failed — the box may still have a working route
    # (ICMP-blocking gateway, unusual topology), so check the internet directly.
    internet_ok && return 0
    return 1
}

# ── Opportunistic rtw_8822bu USB rebind when the driver has stuck queues ─────
# grep -c always prints a count (even "0") — no `|| echo 0`, which used to make
# STUCK "0\n0" because grep exits 1 on zero matches after already printing "0".
rebind_wifi_if_stuck() {
    local stuck iface usb_dev usb_bind_path usb_id dir drv
    stuck=$(journalctl -k --since "15 minutes ago" --no-pager -q 2>/dev/null \
            | grep -c "timed out to flush queue")
    [ "$stuck" -gt 0 ] || return 1

    log "⚠️   $WIFI_DRIVER queue-flush errors detected ($stuck) — attempting USB rebind"
    for dir in /sys/class/net/*/device/driver; do
        [ -e "$dir" ] || continue
        drv=$(basename "$(readlink -f "$dir")")
        if [ "$drv" = "$WIFI_DRIVER" ]; then
            iface=$(basename "$(dirname "$(dirname "$dir")")")
            break
        fi
    done
    [ -n "$iface" ] || return 1

    usb_dev=$(readlink -f "/sys/class/net/$iface/device" 2>/dev/null)
    usb_bind_path=$(dirname "$usb_dev")
    usb_id=$(basename "$usb_dev")
    [ -n "$usb_id" ] && [ -w "$usb_bind_path/unbind" ] || return 1

    echo "$usb_id" > "$usb_bind_path/unbind" 2>/dev/null
    sleep 3
    echo "$usb_id" > "$usb_bind_path/bind" 2>/dev/null
    sleep 5
    systemctl restart NetworkManager
    log "✅  WiFi USB rebind complete — NetworkManager restarted"
    return 0
}

file_age() {
    local f="$1" mtime now
    mtime=$(stat -c %Y "$f" 2>/dev/null) || return 1
    now=$(date +%s)
    echo $(( now - mtime ))
}

mark_healthy() {
    echo 0 > "$FAIL_FILE"
    touch "$UPLINK_SEEN_FILE"
}

do_reboot() {
    local reason="$1" age
    age=$(file_age "$LAST_REBOOT_FILE")
    if [ -n "$age" ] && [ "$age" -lt "$REBOOT_COOLDOWN" ]; then
        log "⏸️   Reboot suppressed — last watchdog reboot was ${age}s ago (cool-down ${REBOOT_COOLDOWN}s)"
        return
    fi
    log "🔴  $reason — rebooting to restore network"
    touch "$LAST_REBOOT_FILE"
    # Write reason to disk so it survives the reboot
    echo "$(date): network-watchdog triggered reboot — $reason" \
        >> /var/log/network-watchdog-reboots.log
    systemctl reboot
}

count_failure() {
    local reason="$1" fails
    fails=$(cat "$FAIL_FILE" 2>/dev/null || echo 0)
    case "$fails" in ''|*[!0-9]*) fails=0 ;; esac
    fails=$(( fails + 1 ))
    echo "$fails" > "$FAIL_FILE"
    log "❌  $reason — consecutive failures: $fails / $MAX_FAILS"
    [ "$fails" -ge "$MAX_FAILS" ] && do_reboot "$reason for $fails consecutive checks"
    exit 1
}

# ── Main ─────────────────────────────────────────────────────────────────────
check_uplinks
STATUS=$?

if [ "$STATUS" -eq 0 ]; then
    mark_healthy
    rebind_wifi_if_stuck   # opportunistic: driver is wedged even though we're up
    exit 0
fi

if [ "$STATUS" -eq 2 ]; then
    SEEN_AGE=$(file_age "$UPLINK_SEEN_FILE")
    if [ -z "$SEEN_AGE" ] || [ "$SEEN_AGE" -gt "$UPLINK_SEEN_MAX_AGE" ]; then
        log "ℹ️   No uplink interface present and none seen recently — nothing to verify (hotspot-only device?)"
        exit 0
    fi
    log "⚠️   No uplink interface present, but one was healthy ${SEEN_AGE}s ago — interfaces have vanished"
fi

# Unhealthy. A wedged USB WiFi driver is the most common recoverable cause —
# rebind and re-test once before counting this round as a failure.
if rebind_wifi_if_stuck; then
    check_uplinks
    if [ $? -eq 0 ]; then
        log "✅  Uplink restored by USB rebind — no failure counted"
        mark_healthy
        exit 0
    fi
fi

count_failure "All uplinks unreachable"
