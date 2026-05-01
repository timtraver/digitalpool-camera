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
