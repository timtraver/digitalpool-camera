#!/usr/bin/env bash
# 0019-watchdog-survive-reboot.sh — arm the hardware watchdog on every boot, not
# just on the day a migration runs.
#
# 0015 armed the watchdog with an explicit `modprobe iTCO_wdt` (a kmod deny-list
# only suppresses alias-based autoloading, so an explicit load still works) and
# then tried to make it stick by adding the module to /etc/initramfs-tools/modules
# and rebuilding the initramfs.
#
# A fleet audit on 2026-10-12 found the live half worked and the persistence half
# never has:
#
#   * The only two boxes with /dev/watchdog — 2e27 and 119c — are the only two
#     that have NOT rebooted since 0015 ran on 2026-10-04. They are still running
#     the module 0015 modprobe'd into them by hand.
#   * 2e27's own running initramfs does not even contain iTCO_wdt, which proves
#     its module did not come from the initramfs.
#   * c889 DOES have iTCO_wdt inside its current initramfs and still boots with
#     no /dev/watchdog and no load attempt in the kernel log.
#
# So the watchdog has been surviving only until the first reboot — exactly the
# event it exists to recover from. 205 froze on 2026-10-12 and stayed frozen,
# needing a physical power cycle.
#
# The fix is to stop relying on the initramfs and repeat at every boot the one
# thing that is known to work: an explicit modprobe, followed by a re-exec of
# PID 1 so systemd picks the device up and starts petting it. RuntimeWatchdogSec
# is only read when the manager re-execs, and daemon-reexec does NOT restart
# running services, so streaming is undisturbed.
#
# Idempotent: re-running rewrites the same unit and re-probes; nothing doubles up.
set -uo pipefail

UNIT=/etc/systemd/system/dp-watchdog.service
MODULES_FILE=/etc/initramfs-tools/modules

have_dev() { [ -e /dev/watchdog ]; }

report_state() {
  echo "   /dev/watchdog      : $(have_dev && echo present || echo ABSENT)"
  for w in /sys/class/watchdog/watchdog*; do
    [ -d "$w" ] || continue
    echo "   $(basename "$w") identity=$(cat "$w/identity" 2>/dev/null) state=$(cat "$w/state" 2>/dev/null) bootstatus=$(cat "$w/bootstatus" 2>/dev/null)"
  done
  echo "   RuntimeWatchdogUSec: $(systemctl show -p RuntimeWatchdogUSec --value 2>/dev/null)"
}

echo "── Starting state ───────────────────────────────────────────────────────"
report_state

# ── 1. Install the boot-time unit ────────────────────────────────────────────
# Deliberately NOT modules-load.d: systemd-modules-load honours the kmod
# deny-list and skips iTCO_wdt every boot. A plain modprobe from a unit does not
# go through that path.
echo "── Installing $UNIT ─────────────────────────────────────────────────────"
cat > "$UNIT" <<'UNITEOF'
[Unit]
Description=Load and arm the hardware watchdog
Documentation=man:modprobe(8) man:systemd-system.conf(5)
# The module must exist before PID 1 is asked to look for the device again.
After=systemd-modules-load.service
# Nothing else depends on this; it must never be able to block the boot.
DefaultDependencies=yes

[Service]
Type=oneshot
RemainAfterExit=yes
# An explicit modprobe is not blocked by the kmod deny-list that stops
# systemd-modules-load from loading this same module.
ExecStart=-/sbin/modprobe iTCO_wdt
# RuntimeWatchdogSec is only acted on when the manager re-execs. This opens and
# arms /dev/watchdog in place and does not restart running services.
ExecStart=/bin/systemctl daemon-reexec

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable dp-watchdog.service 2>&1 | sed 's/^/   /'

# ── 2. Arm it now, so this box is protected without waiting for a reboot ──────
if ! have_dev; then
  echo "── Loading iTCO_wdt now ─────────────────────────────────────────────────"
  modprobe iTCO_wdt 2>&1 | sed 's/^/   /' || echo "   modprobe iTCO_wdt FAILED"
  for _ in 1 2 3 4 5; do have_dev && break; sleep 1; done
fi

MODE=""
if have_dev && lsmod | grep -qE '^iTCO_wdt'; then
  MODE=hardware
elif ! have_dev; then
  # Same fallback 0015 chose, and the same loud warning: softdog catches a wedged
  # PID 1 or starved userspace, but NOT a hard kernel lockup with interrupts off.
  echo "── No hardware watchdog — falling back to softdog ───────────────────────"
  modprobe softdog 2>&1 | sed 's/^/   /' || true
  for _ in 1 2 3; do have_dev && break; sleep 1; done
  if have_dev; then
    MODE=softdog
    sed -i 's|^ExecStart=-/sbin/modprobe iTCO_wdt|ExecStart=-/sbin/modprobe iTCO_wdt\nExecStart=-/sbin/modprobe softdog|' "$UNIT"
    systemctl daemon-reload
  fi
fi

# Re-exec so systemd opens whatever device we just produced.
if [ -n "$MODE" ]; then
  systemctl daemon-reexec
  sleep 1
fi

# ── 3. Correct the stale breadcrumb left by 0015 ─────────────────────────────
# It tells the next reader the initramfs handles this. It does not.
if [ -f /etc/modules-load.d/watchdog.conf ]; then
  cat > /etc/modules-load.d/watchdog.conf <<'NOTEEOF'
# This file intentionally loads nothing.
#
# systemd-modules-load honours the kmod deny-list in
# /lib/modprobe.d/blacklist_linux_<version>.conf, which deny-lists iTCO_wdt, so
# any module named here is skipped every boot with:
#   systemd-modules-load[N]: Module 'iTCO_wdt' is deny-listed (by kmod)
#
# Adding it to /etc/initramfs-tools/modules does not work either — audited
# 2026-10-12, the module sits unused inside the initramfs image.
#
# The watchdog is loaded and armed by dp-watchdog.service instead.
# Verify with: cat /sys/class/watchdog/watchdog0/state
NOTEEOF
fi

echo "── Final state ──────────────────────────────────────────────────────────"
report_state
echo "   dp-watchdog.service: $(systemctl is-enabled dp-watchdog.service 2>/dev/null)"

case "$MODE" in
  hardware)
    echo "🐕 HARDWARE watchdog armed, and it will re-arm on every boot."
    ;;
  softdog)
    echo "⚠️  SOFTWARE watchdog (softdog) only — no hardware watchdog on this board."
    echo "⚠️  Catches a wedged PID 1 or starved userspace, NOT a hard kernel lockup."
    ;;
  *)
    echo "❌ NO watchdog could be armed. systemd will keep reporting a"
    echo "   RuntimeWatchdogUSec that means nothing. Investigate before relying on it."
    exit 1
    ;;
esac
