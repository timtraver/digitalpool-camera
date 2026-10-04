#!/usr/bin/env bash
# 0015-watchdog-actually-arm.sh — make the watchdog real, or say plainly that it
# cannot be.
#
# 0004 claimed to arm a hardware watchdog.  A fleet audit on 2026-10-04 found
# that on ALL 7 devices it is inert: no /dev/watchdog, /sys/class/watchdog empty,
# iTCO_wdt not loaded — while watchdog.conf and `systemctl show
# -p RuntimeWatchdogUSec` both read exactly as expected.  Everything looked armed
# and nothing was.
#
# Why 0004 failed, and why it reported success anyway:
#
#   * Ubuntu deny-lists the module in /lib/modprobe.d/blacklist_linux_<ver>.conf
#     ("blacklist iTCO_wdt"), and systemd-modules-load honours the kmod
#     deny-list.  So 0004's `echo iTCO_wdt > /etc/modules-load.d/watchdog.conf`
#     is skipped at every boot:
#         systemd-modules-load[417]: Module 'iTCO_wdt' is deny-listed (by kmod)
#   * 0004's `modprobe iTCO_wdt || true` swallowed its own failure, so the
#     migration was recorded as applied regardless of the outcome.
#
# An explicit `modprobe iTCO_wdt` is NOT blocked by a deny-list (that only
# suppresses alias-based autoloading), so this migration can settle the question
# the audit could not: it loads the module directly and looks for a device.
#
# On c889 the initramfs workaround is already fully in place — both iTCO_wdt and
# iTCO_vendor_support are in the initramfs image and lpc_ich loads — and there is
# STILL no /dev/watchdog and no ACPI WDAT table.  So the likely answer on these
# Alder Lake-N boards is that the TCO watchdog is simply not reachable.  This
# migration therefore handles both outcomes rather than assuming one:
#
#   hardware available → persist it properly (initramfs, since modules-load.d is
#                        deny-listed) and arm it.
#   hardware absent    → fall back to softdog, and say so LOUDLY.  softdog is a
#                        kernel timer: it catches a wedged PID 1 or starved
#                        userspace, but NOT a hard kernel lockup with interrupts
#                        disabled.  It is strictly better than today's nothing,
#                        and it is not the protection CLAUDE.md describes.
#
# Idempotent: re-running re-probes and re-reports; nothing is duplicated.
set -uo pipefail

MODULES_FILE=/etc/initramfs-tools/modules
MODE=""

have_dev() { [ -e /dev/watchdog ]; }

report_state() {
  echo "   /dev/watchdog      : $(have_dev && ls -l /dev/watchdog || echo ABSENT)"
  echo "   /sys/class/watchdog: $(ls /sys/class/watchdog/ 2>/dev/null | tr '\n' ' ' || true)"
  for w in /sys/class/watchdog/watchdog*; do
    [ -d "$w" ] || continue
    echo "   $(basename "$w") identity=$(cat "$w/identity" 2>/dev/null) state=$(cat "$w/state" 2>/dev/null) bootstatus=$(cat "$w/bootstatus" 2>/dev/null)"
  done
}

persist_in_initramfs() {
  # modules-load.d cannot be used: kmod deny-lists iTCO_wdt and
  # systemd-modules-load honours that.  The initramfs loads modules before PID 1
  # starts, which is also what systemd needs in order to arm the watchdog at all.
  local changed=0
  for m in "$@"; do
    if ! grep -qE "^${m}\b" "$MODULES_FILE" 2>/dev/null; then
      echo "$m" >> "$MODULES_FILE"
      changed=1
    fi
  done
  if [ "$changed" = "1" ]; then
    echo "   added to $MODULES_FILE: $* — rebuilding initramfs…"
    update-initramfs -u >/dev/null 2>&1 && echo "   ✅ initramfs rebuilt" \
      || echo "   ⚠️  update-initramfs failed — module will not load at next boot"
  else
    echo "   $MODULES_FILE already lists: $*"
  fi
}

echo "── Starting state ───────────────────────────────────────────────────────"
report_state

# ── 1. Try the real hardware watchdog ────────────────────────────────────────
if ! have_dev; then
  echo "── Probing hardware watchdog (iTCO_wdt) ─────────────────────────────────"
  # lpc_ich is what normally instantiates the iTCO platform device.
  modprobe lpc_ich 2>&1 | sed 's/^/   /' || true
  modprobe iTCO_vendor_support 2>&1 | sed 's/^/   /' || true
  if modprobe iTCO_wdt 2>&1 | sed 's/^/   /'; then
    echo "   modprobe iTCO_wdt returned 0"
  else
    echo "   modprobe iTCO_wdt FAILED"
  fi
  # Give the driver a moment to register a character device.
  for _ in 1 2 3 4 5; do have_dev && break; sleep 1; done
fi

if have_dev && lsmod | grep -qE '^iTCO_wdt'; then
  MODE=hardware
  echo "✅ Hardware watchdog present (iTCO_wdt)"
  persist_in_initramfs lpc_ich iTCO_vendor_support iTCO_wdt
fi

# ── 2. Fall back to softdog ──────────────────────────────────────────────────
if [ -z "$MODE" ]; then
  echo "── No hardware watchdog — falling back to softdog ───────────────────────"
  echo "   (no /dev/watchdog after loading iTCO_wdt; this board most likely does"
  echo "    not expose the TCO watchdog, and it has no ACPI WDAT table either)"
  modprobe softdog 2>&1 | sed 's/^/   /' || true
  for _ in 1 2 3; do have_dev && break; sleep 1; done
  if have_dev; then
    MODE=softdog
    persist_in_initramfs softdog
  fi
fi

# ── 3. Arm whatever we ended up with ─────────────────────────────────────────
# Manager config (RuntimeWatchdogSec, set by 0004) is only re-read on a re-exec
# of PID 1.  daemon-reexec re-reads it and opens/arms the device in place — it
# does NOT restart running services, so streaming keeps going.
if [ -n "$MODE" ]; then
  systemctl daemon-reexec
  sleep 1
fi

echo "── Final state ──────────────────────────────────────────────────────────"
report_state
ARMED="$(systemctl show -p RuntimeWatchdogUSec --value 2>/dev/null || echo '')"
echo "   RuntimeWatchdogUSec: ${ARMED:-unknown}"

case "$MODE" in
  hardware)
    echo "🐕 HARDWARE watchdog armed — a full freeze will now reset this box."
    ;;
  softdog)
    echo "⚠️  ========================================================="
    echo "⚠️   SOFTWARE watchdog (softdog) only — no hardware watchdog"
    echo "⚠️   on this board.  This catches a wedged PID 1 or starved"
    echo "⚠️   userspace.  It does NOT catch a hard kernel lockup."
    echo "⚠️   CLAUDE.md's 'last-resort hardware watchdog' is NOT true"
    echo "⚠️   for this device.  To undo: rmmod softdog, drop it from"
    echo "⚠️   $MODULES_FILE, update-initramfs -u."
    echo "⚠️  ========================================================="
    ;;
  *)
    echo "❌ NO watchdog of any kind could be armed — neither iTCO_wdt nor softdog"
    echo "   produced /dev/watchdog.  systemd will keep reporting"
    echo "   RuntimeWatchdogUSec=${ARMED:-unknown}, which is misleading: nothing"
    echo "   is actually watching this box.  Investigate before relying on it."
    exit 1
    ;;
esac
