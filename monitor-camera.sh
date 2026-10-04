#!/bin/bash
# monitor-camera.sh — per-process memory flight recorder for digitalpool-camera.
#
# Appends a snapshot for every key process every 5 minutes so that after an
# overnight crash you can open the log and immediately see which process was
# growing and when it hit its limit.
#
# Log: /var/log/digitalpool-monitor.log  (survives reboots, auto-rotates)
# Deployed by: monitor-camera.timer (every 5 min via systemd)

LOG=/var/log/digitalpool-monitor.log
MAX_LINES=86400   # ~30 days of 5-min samples before rotation

# ── Rotate if the log has grown too large ────────────────────────────────────
if [ -f "$LOG" ]; then
    LINE_COUNT=$(wc -l < "$LOG" 2>/dev/null || echo 0)
    if [ "$LINE_COUNT" -gt "$MAX_LINES" ]; then
        mv "$LOG" "${LOG}.1"
    fi
fi

# ── Helper: RSS and VSZ in MB for a given PID ────────────────────────────────
proc_rss_mb() {
    local pid="$1"
    [ -z "$pid" ] && echo "-" && return
    local kb
    kb=$(awk '/VmRSS:/ {print $2}' "/proc/$pid/status" 2>/dev/null)
    [ -z "$kb" ] && echo "-" || echo $(( kb / 1024 ))
}

proc_vsz_mb() {
    local pid="$1"
    [ -z "$pid" ] && echo "-" && return
    local kb
    kb=$(awk '/VmSize:/ {print $2}' "/proc/$pid/status" 2>/dev/null)
    [ -z "$kb" ] && echo "-" || echo $(( kb / 1024 ))
}

# ── Helper: temperature in C for the thermal zone of a given type ────────────
# Zone *indices* are not stable across boards, so always look a zone up by its
# type (x86_pkg_temp = CPU package, acpitz = board/ambient) rather than by number.
zone_temp_c() {
    local want="$1" z m
    for z in /sys/class/thermal/thermal_zone*; do
        if [ "$(cat "$z/type" 2>/dev/null)" = "$want" ]; then
            m=$(cat "$z/temp" 2>/dev/null)
            [ -n "$m" ] && { echo $(( m / 1000 )); return; }
        fi
    done
    echo "-"
}

# ── Helper: thermal-throttle events per second since the PREVIOUS sample ─────
# package_throttle_count is cumulative since boot, which hides WHEN throttling
# started: a box that spent one hot afternoon at its limit reads the same days
# later as one that is throttling right now.  Only the per-sample delta shows a
# box crossing into sustained thermal limiting, which is the thing worth seeing
# in the minutes before a reset.  Keep the baseline next to the migration state
# so it survives log rotation.
THROTTLE_STATE=/var/lib/digitalpool-camera/last-throttle
throttle_rate() {
    local now ts prev_c prev_t
    now=$(cat /sys/devices/system/cpu/cpu0/thermal_throttle/package_throttle_count 2>/dev/null)
    [ -z "$now" ] && { echo "-"; return; }
    ts=$(date +%s)
    if [ -r "$THROTTLE_STATE" ]; then
        read -r prev_c prev_t < "$THROTTLE_STATE" 2>/dev/null || true
    fi
    mkdir -p "$(dirname "$THROTTLE_STATE")" 2>/dev/null
    echo "$now $ts" > "$THROTTLE_STATE" 2>/dev/null
    # No baseline yet (first sample after a boot or a lost state file).
    if [ -z "${prev_c:-}" ] || [ -z "${prev_t:-}" ] || [ "$ts" -le "${prev_t:-0}" ] || [ "$now" -lt "${prev_c:-0}" ]; then
        echo "?"
        return
    fi
    echo $(( (now - prev_c) / (ts - prev_t) ))
}

# ── Helper: first PID whose full cmdline contains the pattern ─────────────────
find_pid() { pgrep -f "$1" 2>/dev/null | head -1; }

log_proc() {
    local label="$1" pattern="$2"
    local pid rss vsz
    pid=$(find_pid "$pattern")
    if [ -n "$pid" ]; then
        rss=$(proc_rss_mb "$pid")
        vsz=$(proc_vsz_mb "$pid")
        printf "  %-12s  PID=%-6s  RSS=%-5s MB  VSZ=%-5s MB\n" "$label" "$pid" "$rss" "$vsz"
    else
        printf "  %-12s  not running\n" "$label"
    fi
}

# ── Helper: sum RSS across ALL PIDs matching a pattern (multi-process apps) ───
# Chromium spawns 5-6 processes; log_proc only captures one and silently misses
# the rest.  This function reports the true total across every matching process.
log_proc_all() {
    local label="$1" pattern="$2"
    local total_rss=0 count=0 first_pid="-"
    while IFS= read -r pid; do
        local kb
        kb=$(awk '/VmRSS:/ {print $2}' "/proc/$pid/status" 2>/dev/null)
        if [ -n "$kb" ]; then
            total_rss=$(( total_rss + kb ))
            count=$(( count + 1 ))
            [ "$first_pid" = "-" ] && first_pid="$pid"
        fi
    done < <(pgrep -f "$pattern" 2>/dev/null)
    if [ "$count" -gt 0 ]; then
        local rss_mb=$(( total_rss / 1024 ))
        printf "  %-12s  PIDs=%-4s  RSS=%-5s MB  (%d processes)\n" \
               "$label" "$first_pid…" "$rss_mb" "$count"
    else
        printf "  %-12s  not running\n" "$label"
    fi
}

{
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') ==="

    # ── System-wide memory ────────────────────────────────────────────────────
    free -m | awk 'NR==2 {
        printf "  SYS          total=%-5dM  used=%-5dM  free=%-5dM  avail=%-5dM\n",
               $2, $3, $4, $7
    }'

    # ── Cgroup memory for the whole service ───────────────────────────────────
    systemctl status digitalpool-camera 2>/dev/null \
        | awk '/Memory:/ { printf "  CGROUP      %s\n", $0 }'

    # ── Thermal / CPU throttling ──────────────────────────────────────────────
    printf "  THERMAL      pkg=%-4s board=%-4s throttle=%-5s load=%s\n" \
        "$(zone_temp_c x86_pkg_temp)C" "$(zone_temp_c acpitz)C" \
        "$(throttle_rate)/s" "$(cut -d' ' -f1-3 /proc/loadavg)"

    # ── Per-process RSS / VSZ ─────────────────────────────────────────────────
    log_proc "node"        "node server.js"
    log_proc "gst-overlay" "gst-overlay-pipeline.py"
    log_proc "gst-launch"  "gst-launch-1.0"
    log_proc_all "chromium"  "chromium"
    log_proc "ffmpeg"      "ffmpeg"

    # ── Network interfaces ────────────────────────────────────────────────────
    while IFS= read -r IFACE; do
        GW=$(ip route show dev "$IFACE" 2>/dev/null | awk '/default/ {print $3; exit}')
        [ -z "$GW" ] && GW="(no default route)"
        printf "  NET          %-12s  gw=%s\n" "$IFACE" "$GW"
    done < <(ip -o link show up | awk -F': ' '{print $2}' | grep -v '^lo$')

    # ── Recent errors ─────────────────────────────────────────────────────────
    ERRORS=$(journalctl -u digitalpool-camera --since "6 minutes ago" \
        --no-pager -q 2>/dev/null \
        | grep -iE "error|fail|crash|killed|OOM|segfault" \
        | grep -vE "Auth hook|FLV|flv|duration|filesize" \
        | tail -5)
    if [ -n "$ERRORS" ]; then
        echo "  ERRORS:"
        echo "$ERRORS" | sed 's/^/    /'
    fi

    echo ""

} >> "$LOG" 2>&1
