#!/usr/bin/env bash
# 0004-hardware-watchdog.sh — arm the hardware watchdog so a FULLY FROZEN system
# reboots itself.
#
# Failure mode this addresses: a kernel/driver lockup (e.g. the Wi-Fi driver going
# down after an OOM event) that freezes the whole box. systemd's Restart=always and
# the network-watchdog timer both assume userspace is still being scheduled — a hard
# freeze defeats them. The hardware watchdog does not: while the system is healthy,
# systemd (PID 1) pets /dev/watchdog every RuntimeWatchdogSec/2 seconds; if the
# machine hangs long enough that it can't, the watchdog silicon hard-resets it.
# This is the last-resort layer already referenced in digitalpool-camera.service.
#
# Cross-platform: Intel N97 gets /dev/watchdog from the iTCO_wdt driver (loaded
# here and set to load at boot); Rockchip RK3588 exposes a built-in /dev/watchdog
# already, so the module step is skipped there without failing.
#
# Idempotent: safe to run repeatedly (writes fixed files, reloads in place).
set -euo pipefail

CONF_DIR="/etc/systemd/system.conf.d"
CONF="$CONF_DIR/watchdog.conf"

# 1. Ensure a watchdog device exists. On Intel the iTCO_wdt module provides
#    /dev/watchdog but isn't always auto-loaded; load it now and at every boot.
#    On non-Intel hosts the module isn't present — skip it without aborting.
if modinfo iTCO_wdt >/dev/null 2>&1; then
  modprobe iTCO_wdt || true
  echo "iTCO_wdt" > /etc/modules-load.d/watchdog.conf
  echo "✅ iTCO_wdt watchdog module loaded + set to load at boot"
else
  echo "ℹ️  iTCO_wdt not available (non-Intel host) — using the built-in /dev/watchdog"
fi

if [ -e /dev/watchdog ]; then
  echo "✅ Watchdog device present: /dev/watchdog"
else
  echo "⚠️  No /dev/watchdog yet — systemd will arm it once a watchdog driver is present."
fi

# 2. Arm systemd's hardware watchdog via a drop-in (cleaner than editing the stock
#    /etc/systemd/system.conf; survives package updates).
#      RuntimeWatchdogSec=60   → HW resets the box if PID 1 can't pet it within 60s.
#      RebootWatchdogSec=10min → force-reset if a clean reboot itself hangs.
mkdir -p "$CONF_DIR"
cat > "$CONF" <<'CONF'
[Manager]
RuntimeWatchdogSec=60
RebootWatchdogSec=10min
CONF
echo "✅ Wrote $CONF"

# 3. Apply to the RUNNING systemd. Manager-config (system.conf) changes require a
#    re-exec of PID 1 — daemon-reload only reloads unit files. daemon-reexec
#    re-reads the config and opens/arms the watchdog with no reboot; it re-execs
#    PID 1 in place and does NOT restart running services (streaming keeps going).
systemctl daemon-reexec

# 4. Report the armed state so the migration log proves it took effect.
ARMED="$(systemctl show -p RuntimeWatchdogUSec --value 2>/dev/null || echo '')"
echo "🐕 Hardware watchdog armed — RuntimeWatchdogUSec=${ARMED:-unknown}"
if [ -z "$ARMED" ] || [ "$ARMED" = "0" ]; then
  echo "⚠️  RuntimeWatchdog reads as DISABLED — check that /dev/watchdog exists and"
  echo "    isn't already held by a userspace watchdog daemon (e.g. 'watchdog' /"
  echo "    'wd_keepalive'): systemctl status watchdog wd_keepalive 2>/dev/null"
fi
