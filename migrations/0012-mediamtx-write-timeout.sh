#!/usr/bin/env bash
# 0012-mediamtx-write-timeout.sh — give a stalled remote reader longer to recover
# before MediaMTX destroys its session.
#
# On 2026-09-14 the Wowza pull backed up until MediaMTX's write to it blocked
# past the default 10 s writeTimeout:
#
#   20:06:34 INF [RTSP] [session 5714509d] destroyed:
#            write tcp 10.8.0.195:8554->172.16.0.71:60176: i/o timeout
#
# Destroying the session is what actually cost the match. Wowza was back 19 s
# later, but it opened a NEW session and rolled to a NEW recording file, so
# 1h23m of footage became a 13m39s fragment. Had the session survived the stall,
# Wowza would have kept writing to one file.
#
# 30 s is chosen to outlast a transient uplink stall without letting a reader
# that is genuinely gone pin a queue open indefinitely. This does NOT stop frame
# discards — a reader slower than the source still loses frames, that is what
# `writeQueueSize` bounds — it only stops a recoverable stall from being fatal.
#
# writeQueueSize is deliberately left alone. Raising it buys a longer stall
# before discards begin, at the cost of RAM and added latency on every reader,
# and this service already runs under a MemoryMax=2500M cap that exists because
# of a previous leak. Local recording (migration 0011) is the real protection.
#
# MediaMTX watches its config file and hot-reloads, so no restart is needed.
# Idempotent: rewrites the key to the same value on a re-run and exits early
# when it already matches.
set -euo pipefail

CONFIG="/etc/mediamtx.yml"
WANT_KEY="writeTimeout"
WANT_VAL="30s"

if [ ! -f "$CONFIG" ]; then
  echo "❌ $CONFIG not found — is MediaMTX installed?"
  exit 1
fi

CURRENT="$(grep -m1 "^${WANT_KEY}:" "$CONFIG" || true)"
DESIRED="${WANT_KEY}: ${WANT_VAL}"

if [ "$CURRENT" = "$DESIRED" ]; then
  echo "✅ $CONFIG already has ${DESIRED} — nothing to do"
  exit 0
fi

# Keep a one-time backup so the original is recoverable by hand.
if [ ! -f "${CONFIG}.pre-0012.bak" ]; then
  cp -a "$CONFIG" "${CONFIG}.pre-0012.bak"
  echo "ℹ️  Backed up $CONFIG -> ${CONFIG}.pre-0012.bak"
fi

if [ -n "$CURRENT" ]; then
  sed -i "s|^${WANT_KEY}:.*|${DESIRED}|" "$CONFIG"
  echo "✅ Changed '${CURRENT}' -> '${DESIRED}'"
else
  # Prepend rather than append: the file ends in per-path blocks, and a
  # top-level key appended after them would be parsed as part of the last path.
  sed -i "1i ${DESIRED}" "$CONFIG"
  echo "✅ Added '${DESIRED}' at the top of $CONFIG"
fi

# A malformed config makes MediaMTX refuse to reload and keep serving the old
# one, which would hide the breakage until the next restart. Catch it now.
if command -v python3 >/dev/null 2>&1; then
  if python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' "$CONFIG" 2>/dev/null; then
    echo "✅ $CONFIG still parses as YAML"
  else
    echo "❌ $CONFIG no longer parses — restoring backup"
    cp -a "${CONFIG}.pre-0012.bak" "$CONFIG"
    exit 1
  fi
else
  echo "ℹ️  python3/pyyaml unavailable — skipped YAML validation"
fi

echo "ℹ️  MediaMTX hot-reloads on file change; no restart issued."
