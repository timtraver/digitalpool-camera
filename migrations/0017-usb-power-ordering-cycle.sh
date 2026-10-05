#!/usr/bin/env bash
# 0017-usb-power-ordering-cycle.sh — stop systemd dropping the app at boot.
#
# 0014 wrote dp-usb-power.service with
#     After=systemd-udev-settle.service multi-user.target
#     Before=digitalpool-camera.service
#     WantedBy=multi-user.target
# which closes an ordering cycle: multi-user.target wants digitalpool-camera,
# digitalpool-camera is ordered after dp-usb-power, and dp-usb-power is ordered
# after multi-user.target.  systemd breaks a cycle by DELETING one of the jobs in
# it, and on a freshly imaged N100 it picked the one that matters:
#
#   multi-user.target: Found ordering cycle on digitalpool-camera.service/start
#   multi-user.target: Found dependency on dp-usb-power.service/start
#   multi-user.target: Found dependency on multi-user.target/start
#   multi-user.target: Job digitalpool-camera.service/start deleted to break ordering cycle
#
# The symptom is maddening to read: the unit sits "enabled" and "inactive (dead)"
# with NO journal lines at all, because the start job never existed.  The hotspot
# was up and the captive-portal redirect was in place with nothing listening on
# :3000 to answer it, so joining the WiFi got you no interface.
#
# Which job systemd deletes is not guaranteed to be stable, so any device that
# ran 0014 can lose the app on any boot — this is not only a cloned-unit problem.
#
# The rule being broken: a unit that is WantedBy a target must not also be
# ordered After that target.  Drop multi-user.target from After=.
set -euo pipefail

UNIT=/etc/systemd/system/dp-usb-power.service
[ -f "$UNIT" ] || { echo "ℹ️  $UNIT not present — nothing to fix"; exit 0; }

cat > "$UNIT" <<'UNITEOF'
[Unit]
Description=Pin USB capture devices to power/control=on (anti-autosuspend)
# NOT After=multi-user.target — this unit is WantedBy it, and digitalpool-camera
# (also WantedBy it) is ordered after this one.  That is an ordering cycle, and
# systemd resolves it by dropping a job.  See migration 0017.
After=systemd-udev-settle.service
Before=digitalpool-camera.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/dp-usb-power-on.sh

[Install]
WantedBy=multi-user.target
UNITEOF
systemctl daemon-reload
systemctl enable dp-usb-power.service >/dev/null 2>&1 || true
echo "✅ dp-usb-power.service no longer orders itself after multi-user.target"

# Fixing the unit file is not enough on a boot where the app's job was already
# deleted — nothing would start it until the next reboot.
#
# --no-block is essential: we run inside digitalpool-migrations.service, which
# digitalpool-camera.service is ordered After=, so a blocking start would wait on
# a job that cannot run until we exit.  (dp-firstboot.sh learned the same lesson
# with netbird.)
if systemctl is-active --quiet digitalpool-camera.service; then
  echo "ℹ️  digitalpool-camera already running"
else
  systemctl start --no-block digitalpool-camera.service || true
  echo "✅ Queued digitalpool-camera start (its boot job was dropped by the cycle)"
fi
