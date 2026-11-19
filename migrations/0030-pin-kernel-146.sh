#!/usr/bin/env bash
# 0030-pin-kernel-146.sh — boot 6.8.0-146, not 6.8.0-147, on boxes that have both.
#
# At Ariakon on 2026-11-18 there were seven identical GMKtec G5 (N97) boxes.
# The three still running 6.8.0-146 (119c, 2e27, 9605) had been up 35 days with
# no failure. All four that booted 6.8.0-147 on Oct 22–23 failed within one or
# two weeks:
#   * 76ff, c889 and 71a6 froze silently and stayed dead for 16 to 21 days.
#   * cc64 crashed and rebooted itself on Nov 6, 10 and 13.
# A read of the 146→147 changelog found no single change that explains it (see
# memory notes / the commit message). The correlation is empirical, but it is
# 4 of 4 against 0 of 3 on identical hardware, and pinning costs nothing: 146
# is already installed, and its packages are marked manual so nothing removes
# them.
#
# GRUB boots the newest kernel by default, so a box on 146 would move to 147
# at its next power blip. This sets GRUB_DEFAULT to the 146 entry through a
# grub.d drop-in (sourced after /etc/default/grub, and kept across the
# update-grub that dp-kernel-guard runs). It holds the 146 packages as well.
#
# To undo (once a kernel is proven on a G5):
#   sudo rm /etc/default/grub.d/95-dp-kernel-pin.cfg && sudo update-grub
#   sudo apt-mark unhold 'linux-*-6.8.0-146*'
#
# A box without a complete 6.8.0-146 (another kernel line, or RK3588) is left
# alone. Idempotent.
set -euo pipefail

K=6.8.0-146-generic
PIN=/etc/default/grub.d/95-dp-kernel-pin.cfg
ENTRY="Advanced options for Ubuntu>Ubuntu, with Linux $K"

if [ ! -e "/boot/vmlinuz-$K" ] || [ ! -e "/boot/initrd.img-$K" ] || [ ! -d "/lib/modules/$K" ]; then
  echo "0030: $K is not fully installed here (running $(uname -r)) — nothing to pin."
  exit 0
fi

mkdir -p /etc/default/grub.d
cat > "$PIN" <<EOF
# Written by migrations/0030-pin-kernel-146.sh — see that file for why and how to undo.
GRUB_DEFAULT="$ENTRY"
EOF
echo "Wrote $PIN"

update-grub >/dev/null 2>&1

# Prove the entry the pin names really exists. If GRUB titles it differently,
# an unknown GRUB_DEFAULT falls back to entry 0 (147) — so fail loudly instead,
# remove the pin, and leave this migration unrecorded so it retries.
if ! grep -q "submenu 'Advanced options for Ubuntu'" /boot/grub/grub.cfg \
   || ! grep -q "menuentry 'Ubuntu, with Linux $K'" /boot/grub/grub.cfg; then
  echo "0030: grub.cfg has no '$ENTRY' entry — removing the pin" >&2
  rm -f "$PIN"
  update-grub >/dev/null 2>&1 || true
  exit 1
fi
echo "Verified grub.cfg has: $ENTRY"

# Nothing may remove 146 while it is the kernel these boxes boot.
pkgs=$(dpkg-query -W -f='${Package} ${Status}\n' "linux-*-6.8.0-146*" 2>/dev/null | awk '/ installed$/{print $1}' || true)
if [ -n "$pkgs" ]; then
  # shellcheck disable=SC2086
  apt-mark hold $pkgs | sed 's/^/   /'
fi

echo "── Final state ──────────────────────────────────────────────────────────"
echo "   running now: $(uname -r)"
echo "   next boot:   $(grep -h '^GRUB_DEFAULT' /etc/default/grub /etc/default/grub.d/*.cfg 2>/dev/null | tail -1)"
