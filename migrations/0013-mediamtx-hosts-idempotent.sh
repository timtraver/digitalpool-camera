#!/usr/bin/env bash
# 0013-mediamtx-hosts-idempotent.sh — stop MediaMTX reloading its config every
# 60 seconds.
#
# mediamtx-update-hosts.timer fires every 60 s to refresh the WebRTC ICE host
# list. The script it runs used `sed -i` unconditionally, and `sed -i` writes a
# temp file and renames it over the original — changing the inode whether or not
# a single byte differs. MediaMTX watches that file, so it hot-reloaded its
# entire configuration every 61 seconds, indefinitely, on devices whose address
# list had not changed in days:
#
#   18:55:00 INF reloading configuration (file changed)
#   18:56:01 INF reloading configuration (file changed)
#   18:57:01 INF reloading configuration (file changed)
#   …
#
# A reload restarts any path whose config differs. That did not cause the
# 2026-09-14 outage — the affected session survived roughly 69 of these — but
# it is continuous avoidable churn underneath live matches, and it buried the
# actual signal in the journal while diagnosing the incident.
#
# The repo copy of mediamtx-update-hosts.sh now compares before writing. This
# migration installs it, because /usr/local/bin/mediamtx-update-hosts.sh lives
# outside the repo and `git reset --hard` never touches it — the same trap
# migration 0003 was written for. 0003 already ran on deployed devices, and the
# state file keys on filename, so it will not re-run.
#
# Idempotent: copy-if-changed, same as 0003.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/mediamtx-update-hosts.sh"
DST="/usr/local/bin/mediamtx-update-hosts.sh"

if [ ! -f "$SRC" ]; then
  echo "❌ $SRC not present in repo"
  exit 1
fi

if [ -f "$DST" ] && cmp -s "$SRC" "$DST"; then
  echo "✅ $DST already up to date"
else
  mkdir -p "$(dirname "$DST")"
  install -m 0755 "$SRC" "$DST"
  echo "✅ Installed $SRC -> $DST"
fi

# Prove the fix: run it twice and confirm the config file's mtime is unchanged
# by the second run. That is the exact property whose absence caused the churn.
if [ -f /etc/mediamtx.yml ]; then
  "$DST" >/dev/null 2>&1 || true
  BEFORE="$(stat -c %Y /etc/mediamtx.yml)"
  sleep 1
  "$DST" >/dev/null 2>&1 || true
  AFTER="$(stat -c %Y /etc/mediamtx.yml)"
  if [ "$BEFORE" = "$AFTER" ]; then
    echo "✅ Verified: a no-op run no longer rewrites /etc/mediamtx.yml"
  else
    echo "⚠️  /etc/mediamtx.yml was still rewritten on a no-op run — reloads may continue"
  fi
fi
