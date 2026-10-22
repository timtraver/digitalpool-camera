#!/usr/bin/env bash
# 0024-kernel-updates-are-deliberate.sh — stop the box taking kernels on its own.
#
# On 2026-10-13 unattended-upgrades installed 6.8.0-147 on every box. Its
# postinst failed at the DKMS hook, so no initramfs was built (see
# migrations/helpers/aic8800-monitor-channel.sh for the mechanism), and eight
# days later four boxes at Ariakon panicked on their first reboot with
# "Cannot open root device /dev/mapper/ubuntu--vg-ubuntu--lv". Nobody chose
# that upgrade and nobody saw it fail.
#
# A camera appliance has no business changing its kernel unattended. It has no
# inbound exposure — the only way in is NetBird — and the cost of a bad kernel
# is a box that needs a monitor, a keyboard and somebody standing at the venue.
# So kernels are held, and change only when a person decides they should.
#
# This does NOT stop ordinary security updates: everything that is not a kernel
# still upgrades unattended, exactly as before.
#
# To take a kernel deliberately (with someone watching, and not at a venue):
#
#   sudo apt-mark unhold linux-generic linux-image-generic linux-headers-generic
#   sudo apt-get update && sudo apt-get install -y linux-generic
#   sudo /usr/local/sbin/dp-kernel-guard      # proves every kernel can boot
#   sudo reboot                               # watch it come back
#   sudo apt-mark hold linux-generic linux-image-generic linux-headers-generic
#
# Idempotent.
set -euo pipefail

HOLD_PACKAGES="linux-generic linux-image-generic linux-headers-generic"

echo "Holding kernel packages so they cannot upgrade unattended:"
for pkg in $HOLD_PACKAGES; do
  if dpkg -l "$pkg" 2>/dev/null | grep -q "^ii"; then
    apt-mark hold "$pkg" | sed 's/^/   /'
  else
    echo "   $pkg is not installed — skipping"
  fi
done

# Belt and braces: even if a hold is lifted by hand and forgotten,
# unattended-upgrades will not pick a kernel up. APT merges list entries across
# files, so this appends to whatever 50unattended-upgrades already blacklists.
cat > /etc/apt/apt.conf.d/52-digitalpool-no-kernel <<'CONF'
// Kernels are not upgraded unattended on camera appliances. A kernel that
// fails to configure leaves the box unbootable at its next reboot, and these
// boxes live in venues where nobody can attach a monitor. Kernel upgrades are
// done deliberately — see migrations/0024-kernel-updates-are-deliberate.sh.
Unattended-Upgrade::Package-Blacklist {
    "linux-generic";
    "linux-image-.*";
    "linux-headers-.*";
    "linux-modules-.*";
};
CONF
echo "Wrote /etc/apt/apt.conf.d/52-digitalpool-no-kernel"

echo "── Final state ──────────────────────────────────────────────────────────"
apt-mark showhold | sed 's/^/   held: /'
echo "   Non-kernel updates are unaffected and still apply unattended."
