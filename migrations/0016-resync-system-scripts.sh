#!/usr/bin/env bash
# 0016-resync-system-scripts.sh — re-run the system-script sync so an edited
# repo copy actually reaches /usr/local.
#
# monitor-camera.sh now records CPU package temperature, board temperature and
# the thermal-throttle RATE (events/sec since the previous sample) on every
# 5-minute tick.  The Oct 4 2026 investigation of the dp-stream-71a6 resets had
# to infer all of that after the fact — the flight recorder logged memory and
# network but nothing thermal, so the one question that mattered ("was it hot
# when it died?") had no recorded answer.
#
# The catch: monitor-camera.sh lives in the repo but RUNS from
# /usr/local/bin/monitor-camera.sh, and only 0003-sync-system-scripts.sh copies
# it there.  0003 is already recorded as applied on every device, and the state
# file keys on the filename, so it will never run again — editing the repo copy
# alone would ship nothing.
#
# Rather than duplicate its copy-if-changed logic (and risk the two drifting),
# this migration simply invokes 0003 again.  That script is idempotent by
# design: it skips any script whose installed copy already matches, and only
# restarts the hotspot when dp-hotspot.sh itself changed.
#
# NOTE for future edits to any synced script: the same problem recurs.  Add
# another migration that re-invokes 0003 exactly like this one does.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC="$HERE/0003-sync-system-scripts.sh"

if [ ! -f "$SYNC" ]; then
  echo "❌ $SYNC not found — cannot re-sync system scripts"
  exit 1
fi

echo "Re-running the system-script sync (0003) to pick up repo edits…"
bash "$SYNC"

# Prove the new flight-recorder actually landed, so the migration log says
# whether thermal sampling is live rather than just that a copy happened.
if grep -q 'THERMAL' /usr/local/bin/monitor-camera.sh 2>/dev/null; then
  echo "🌡️  Flight recorder now samples temperature + throttle rate"
  echo "    (next tick writes a THERMAL line to /var/log/digitalpool-monitor.log;"
  echo "     the throttle rate reads '?' on the first sample — it needs a baseline)"
else
  echo "⚠️  /usr/local/bin/monitor-camera.sh has no THERMAL line — sync did not take"
  exit 1
fi
