#!/usr/bin/env bash
# mediamtx-update-hosts.sh
# Run as ExecStartPre in the mediamtx systemd service.
# Reads all non-loopback IPv4 addresses (LAN, Tailscale 100.x.x.x, hotspot, etc.)
# and writes them into webrtcAdditionalHosts in /etc/mediamtx.yml so that
# MediaMTX includes every interface as a WebRTC ICE candidate.
# This means WebRTC preview works from any interface without hardcoding IPs.

set -euo pipefail

CONFIG=/etc/mediamtx.yml

# Collect all non-loopback IPv4 addresses currently assigned to any interface
ADDRS=$(ip -4 addr show | \
        grep -oP '(?<=inet\s)\d+(\.\d+){3}' | \
        grep -v '^127\.' | \
        sort -u)

if [[ -z "$ADDRS" ]]; then
  echo "mediamtx-update-hosts: no non-loopback IPv4 addresses found, skipping"
  exit 0
fi

echo "mediamtx-update-hosts: found addresses: $(echo $ADDRS | tr '\n' ' ')"

# Build the YAML list value: [addr1, addr2, ...]
LIST=$(echo "$ADDRS" | awk '{printf "%s\"%s\"", (NR>1?", ":""), $0} END{print ""}')
LIST="[$LIST]"

DESIRED="webrtcAdditionalHosts: $LIST"
CURRENT=$(grep -m1 '^webrtcAdditionalHosts:' "$CONFIG" || true)

# Write ONLY when the value actually changed.
#
# `sed -i` writes a temp file and renames it over the original, so it changes the
# inode whether or not any byte differs. MediaMTX watches the config file and
# hot-reloads on that change, so the unconditional sed this replaced made
# MediaMTX reload its entire configuration every 60 s, forever — visible in the
# journal as an endless run of `INF reloading configuration (file changed)`
# roughly 61 seconds apart, on a device whose address list had not changed in
# days. Each reload restarts any path whose config differs, which is needless
# risk underneath a live match.
if [[ "$CURRENT" == "$DESIRED" ]]; then
  echo "mediamtx-update-hosts: unchanged — $LIST"
  exit 0
fi

# Replace existing webrtcAdditionalHosts line, or append if absent
if [[ -n "$CURRENT" ]]; then
  sed -i "s|^webrtcAdditionalHosts:.*|$DESIRED|" "$CONFIG"
else
  echo "$DESIRED" >> "$CONFIG"
fi

echo "mediamtx-update-hosts: set webrtcAdditionalHosts: $LIST"
