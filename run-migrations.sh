#!/usr/bin/env bash
# run-migrations.sh — apply pending host-config migrations, in order, once each.
#
# Migrations are ordered shell scripts in ./migrations (NNNN-slug.sh), committed
# to git and delivered by the normal `git reset --hard` software update.  Each is
# run once as root; the basename of every successfully-applied script is recorded
# in the state file below so it never runs again.  Failures are NOT recorded, so a
# migration that errors (e.g. no network for apt) is retried on the next run.
#
# Invoked two ways (see digitalpool-migrations.service):
#   * at boot, before digitalpool-camera.service starts
#   * by /api/update, right after `git reset --hard`, via
#     `sudo systemctl start digitalpool-migrations.service`
#
# Must run as root — migrations do apt / systemctl / writes under /etc.
# The state file lives OUTSIDE the repo so `git reset --hard` never touches it.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIG_DIR="$REPO_DIR/migrations"
STATE_DIR="/var/lib/digitalpool-camera"
STATE_FILE="$STATE_DIR/applied-migrations.txt"
LOG_FILE="/var/log/digitalpool-migrations.log"   # cumulative history (append-only)
RUN_LOG="$STATE_DIR/last-run.log"                # ONLY this run — truncated each run

log() {
  local line="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$line"
  echo "$line" >> "$LOG_FILE" 2>/dev/null || true
  echo "$line" >> "$RUN_LOG"  2>/dev/null || true
}

if [ "$(id -u)" -ne 0 ]; then
  echo "run-migrations.sh must run as root" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
touch "$STATE_FILE" "$LOG_FILE" 2>/dev/null || true
# Start this run's log fresh so /api/update surfaces only what THIS run did,
# not the whole cumulative history.  World-readable so the (dp) app can read it.
: > "$RUN_LOG" 2>/dev/null || true
chmod 0644 "$RUN_LOG" 2>/dev/null || true

if [ ! -d "$MIG_DIR" ]; then
  log "No migrations directory ($MIG_DIR) — nothing to do."
  exit 0
fi

# Collect migration scripts in lexical (= numeric-prefix) order.
shopt -s nullglob
mapfile -t scripts < <(printf '%s\n' "$MIG_DIR"/*.sh | sort)
shopt -u nullglob

pending=0
applied=0
for script in "${scripts[@]}"; do
  id="$(basename "$script")"
  if grep -Fxq "$id" "$STATE_FILE" 2>/dev/null; then
    continue   # already applied
  fi
  pending=$((pending + 1))
  log ">> Applying $id"
  if bash "$script" 2>&1 | tee -a "$LOG_FILE" >> "$RUN_LOG"; then
    echo "$id" >> "$STATE_FILE"
    applied=$((applied + 1))
    log "OK Applied $id"
  else
    rc=$?
    log "FAILED $id (exit $rc) — not recorded; will retry next run. Stopping."
    exit "$rc"
  fi
done

if [ "$pending" -eq 0 ]; then
  log "All ${#scripts[@]} migration(s) already applied — no-op."
else
  log "Done: applied $applied of $pending pending migration(s)."
fi
exit 0
