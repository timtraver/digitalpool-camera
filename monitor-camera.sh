#!/bin/bash
# monitor-camera.sh — per-process memory flight recorder for digitalpool-camera.
#
# Appends a one-line summary for every key process every 5 minutes so that
# after an overnight crash you can open the log and immediately see which
# process was growing and when it hit its limit.
#
# Log file: /var/log/digitalpool-monitor.log
# Deployed by: monitor-camera.timer (runs every 5 min via systemd)
# Install:
#   sudo cp monitor-camera.sh /usr/local/bin/
#   sudo chmod +x /usr/local/bin/monitor-camera.sh
#   sudo cp monitor-camera.service monitor-camera.timer /etc/systemd/system/
#   sudo systemctl daemon-reload && sudo systemctl enable --now monitor-camera.timer

LOG=/var/log/digitalpool-monitor.log
# Keep ~30 days of 5-min samples (8640 entries).  Each entry is ~10 lines → ~86k lines max.
MAX_LINES=86400

# ── Rotate if the log has grown too large ────────────────────────────────────
if [ -f "$LOG" ]; then
    LINE_COUNT=$(wc -l < "$LOG" 2>/dev/null || echo 0)
    if [ "$LINE_COUNT" -gt "$MAX_LINES" ]; then
        mv "$LOG" "${LOG}.1"
    fi
fi

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# ── Helper: read RSS + VSZ from /proc/<pid>/status ───────────────────────────
proc_mem() {
    local pid="$1"
    [ -z "$pid" ] && { echo "0 0"; return; }
    local rss vsz
    rss=$(awk '/VmRSS:/ {print $2}' /proc/"$pid"/status 2>/dev/null || echo 0)
    vsz=$(awk '/VmSize:/ {print $2}' /proc/"$pid"/status 2>/dev/null || echo 0)
    echo "$(( rss / 1024 )) $(( vsz / 1024 ))"
}

# ── Helper: find first PID matching a cmdline pattern ────────────────────────
find_pid() { pgrep -f "$1" 2>/dev/null | head -1; }

{
    echo "=== $TIMESTAMP ==="

    # ── System-wide memory ────────────────────────────────────────────────────
    free -m | awk 'NR==2 {
        printf "  SYS   total=%-5dM  used=%-5dM  free=%-5dM  avail=%-5dM\n",
               $2, $3, $4, $7
    }'

    # ── Cgroup memory for the whole service ───────────────────────────────────
    systemctl status digitalpool-camera 2>/dev/null \
        | awk '/Memory:/ {print "  CGROUP" $0}'

    # ── Per-process RSS / VSZ ─────────────────────────────────────────────────
    declare -A LABELS=(
        ["node server.js"]="node       "
        ["gst-overlay-pipeline.py"]="gst-overlay"
        ["gst-launch-1.0"]="gst-launch "
        ["chromium"]="chromium   "
        ["ffmpeg"]="ffmpeg     "
    )

    for PATTERN in "node server.js" "gst-overlay-pipeline.py" "gst-launch-1.0" "chromium" "ffmpeg"; do
        PID=$(find_pid "$PATTERN")
        LABEL="${LABELS[$PATTERN]}"
        if [ -n "$PID" ]; then
            read -r RSS VSZ <<< "$(proc_mem "$PID")"
            printf "  PID=%-6s  RSS=%-5s MB  VSZ=%-5s MB  %s\n" \
                "$PID" "$RSS" "$VSZ" "$LABEL"
        else
            printf "  PID=%-6s  RSS=%-5s MB  VSZ=%-5s MB  %s\n" \
                "-" "-" "-" "$LABEL (not running)"
        fi
    done

    # ── Network interface status ──────────────────────────────────────────────
    for IFACE in $(ip -o link show up | awk -F': ' '{print $2}' | grep -v '^lo$'); do
        GW=$(ip route show dev "$IFACE" 2>/dev/null | awk '/default/ {print $3; exit}')
        [ -z "$GW" ] && GW="(no default route)"
        printf "  NET   %-12s  gw=%s\n" "$IFACE" "$GW"
    done

    # ── Recent errors from the service ───────────────────────────────────────
    ERRORS=$(journalctl -u digitalpool-camera --since "6 minutes ago" \
        --no-pager -q 2>/dev/null \
        | grep -iE "error|fail|crash|killed|OOM|segfault|assert" \
        | grep -v "Auth hook" \
        | tail -5)
    if [ -n "$ERRORS" ]; then
        echo "  ERRORS in last 6 min:"
        echo "$ERRORS" | sed 's/^/    /'
    fi

    echo ""  # blank line between entries for readability

} >> "$LOG" 2>/dev/null
