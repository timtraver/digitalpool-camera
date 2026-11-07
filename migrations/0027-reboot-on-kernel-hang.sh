#!/usr/bin/env bash
# 0027-reboot-on-kernel-hang.sh — make the kernel reboot itself when it hangs,
# instead of relying on the hardware watchdog alone.
#
# On 2026-11-07 at ~00:43, dp-stream-71b7 (Table 2 at an event) froze solid:
# the journal and an in-progress recording both stop at the same second, it
# answered no pings, and it stayed dead for 7.5 hours until someone power-cycled
# it. Every recovery layer we have was in place and none of them fired:
#
#   * network-watchdog only reboots when every uplink is unreachable FROM a box
#     that is still running — a frozen box runs nothing.
#   * MemoryMax only restarts the service on an OOM kill. There was none.
#   * The iTCO hardware watchdog was armed (0019) and still did not reset the
#     board. Whether iTCO can reset these boards at all is untested; 0019 only
#     proves /dev/watchdog exists and systemd is petting it.
#
# And the kernel itself was configured to never recover: kernel.panic=0 (sit on
# a panic forever), panic_on_oops=0, and the soft/hard lockup detectors only
# log — to a journal nobody can write once the box is frozen.
#
# This turns those detectors into reboots, by the kernel itself, without going
# through iTCO:
#
#   kernel.panic=10           a panic reboots after 10 s instead of hanging
#   kernel.panic_on_oops=1    an oops panics (→ reboots) instead of leaving a
#                             half-dead kernel that usually freezes later anyway
#   kernel.softlockup_panic=1 a CPU stuck in kernel code for ~20 s panics
#   kernel.hardlockup_panic=1 a CPU stuck with interrupts off panics (needs the
#                             NMI watchdog, which is on by default on x86)
#
# It does not cover a hardware lockup hard enough that no CPU runs kernel code;
# only iTCO can catch that. It is also not a hung-task panic: that fires on a
# process stuck in D state for minutes, which a misbehaving USB camera can do
# without the box being in trouble, and a reboot mid-match is worse than that.
#
# The four boxes at the 2026-11-07 event had this applied by hand, to the same
# file this writes, so on them this is a no-op rewrite.
#
# Idempotent. Keys are written only if this kernel has them: hardlockup_panic in
# particular depends on the NMI watchdog, which RK3588 kernels may not build in,
# and an unknown key would make `sysctl -p` fail this migration on every run.
set -euo pipefail

CONF=/etc/sysctl.d/90-dp-panic-reboot.conf

{
  echo "# Written by migrations/0027-reboot-on-kernel-hang.sh — see that file for why."
  echo "# Reboot instead of hanging forever: a kernel crash or a CPU lockup becomes a"
  echo "# panic, and a panic reboots after 10s. This does not rely on the iTCO watchdog."
  for kv in kernel.panic=10 kernel.panic_on_oops=1 kernel.softlockup_panic=1 kernel.hardlockup_panic=1; do
    key="${kv%%=*}"
    if [ -e "/proc/sys/${key//.//}" ]; then
      echo "${key} = ${kv#*=}"
    else
      echo "# ${key}: not supported by this kernel ($(uname -r))" >&2
    fi
  done
} > "$CONF"
echo "Wrote $CONF"

# Applies live: nothing restarts, streams are not touched.
sysctl -p "$CONF" | sed 's/^/   /'

echo "── Final state ──────────────────────────────────────────────────────────"
for key in kernel.panic kernel.panic_on_oops kernel.softlockup_panic kernel.hardlockup_panic kernel.nmi_watchdog; do
  echo "   $key = $(sysctl -n "$key" 2>/dev/null || echo 'n/a')"
done
