#!/usr/bin/env bash
# 0001-avahi-daemon.sh — install the Avahi mDNS daemon that NDI discovery needs.
#
# libndi.so.6 has no built-in mDNS; it is linked against libavahi-client and
# delegates ALL NDI source discovery to a running avahi-daemon.  Without it,
# NDI discovery silently returns nothing (the 🔍 scan finds no sources and the
# live ndisrc pipeline can never resolve one) even when the camera, routing,
# and firewall are perfectly fine.
#
# Avahi also binds UDP 5353, which MediaMTX's WebRTC stack (pion) wants too.
# They cannot both own the port, and Avahi must win — MediaMTX only needs mDNS
# for .local ICE candidates it doesn't use on a direct LAN, and it fails soft
# when it can't bind 5353.  So MediaMTX is ordered to start AFTER Avahi.
#
# Idempotent: safe to run repeatedly.
set -euo pipefail

echo "Installing avahi-daemon + avahi-utils..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y avahi-daemon avahi-utils

systemctl enable --now avahi-daemon

# Ensure MediaMTX starts after Avahi so Avahi owns UDP 5353 at boot.
DROPIN_DIR="/etc/systemd/system/mediamtx.service.d"
mkdir -p "$DROPIN_DIR"
cat > "$DROPIN_DIR/10-after-avahi.conf" <<'CONF'
[Unit]
After=avahi-daemon.service
Wants=avahi-daemon.service
CONF
systemctl daemon-reload

echo "avahi-daemon installed and enabled; MediaMTX ordered after it."
