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

# Replace existing webrtcAdditionalHosts line, or append if absent
if grep -q '^webrtcAdditionalHosts:' "$CONFIG"; then
  sed -i "s|^webrtcAdditionalHosts:.*|webrtcAdditionalHosts: $LIST|" "$CONFIG"
else
  echo "webrtcAdditionalHosts: $LIST" >> "$CONFIG"
fi

echo "mediamtx-update-hosts: set webrtcAdditionalHosts: $LIST"
