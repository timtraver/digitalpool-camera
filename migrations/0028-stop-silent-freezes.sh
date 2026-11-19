#!/usr/bin/env bash
# 0028-stop-silent-freezes.sh — remove the two most likely causes of the silent
# whole-box freezes on the GMKtec G5 (N97), and keep the evidence when one happens.
#
# On 2026-11-18 at Ariakon, three G5 boxes (dp-stream-76ff, c889, 71a6) had been
# frozen solid for 16 to 21 days: c889 from about Oct 28, 71a6 from about Nov 1,
# 76ff from about Nov 2. They needed a physical power cycle. The iTCO watchdog
# was armed and being petted on all three and never reset them. 71b7 and 1077
# froze the same way on 2026-11-05 and 11-07. These freezes are silent: no
# lockup, oops or MCE line, and no BERT record at the next boot. By contrast,
# cc64 hit a firmware-reported hardware error on Nov 13, and the board reset
# itself within a minute.
#
# Every G5 that has frozen runs the hotspot on a Realtek 8821CE (rtw88_8821ce)
# with PCIe ASPM and deep LPS on. That driver is well known for hanging the
# whole platform on an ASPM transition, in a way the kernel never sees. The
# modprobe file already on these boxes sets options for rtw_8822bu, a
# different driver, so it does nothing here. The other known freeze source on
# Alder Lake-N is the deep package C-states (C8/C10).
#
# This migration:
#   1. Turns ASPM and deep LPS off for rtw88. They are set live, through the
#      writable module parameters, so they take effect from the next power
#      transition. They are also set in modprobe.d for every boot after this.
#      The hotspot is not interrupted.
#   2. Disables the cpuidle states deeper than C1E (C6, C8, C10) at every
#      boot through a small unit, and once now. That costs a few watts on a
#      mains-powered box and nothing in stream performance. On a CPU without
#      those state names (RK3588), nothing matches and nothing changes.
#   3. Stops journald deleting the one boot we need. MaxRetentionSec=1week
#      erased every log line of the frozen boots as soon as the boxes came back
#      more than a week later. Now only size bounds the journal (1G on a 231G
#      volume), with no age limit.
#
# Idempotent: every file is rewritten whole, and every live write is
# re-applicable.
set -euo pipefail

# ── 1. rtw88: no ASPM, no deep LPS ──────────────────────────────────────────
cat > /etc/modprobe.d/dp-rtw88-no-aspm.conf <<'EOF'
# Written by migrations/0028-stop-silent-freezes.sh — see that file for why.
# The RTL8821CE hangs the whole box on PCIe ASPM / deep-LPS transitions.
options rtw88_pci disable_aspm=1
options rtw88_core disable_lps_deep=1
EOF
echo "Wrote /etc/modprobe.d/dp-rtw88-no-aspm.conf"

for p in /sys/module/rtw88_pci/parameters/disable_aspm /sys/module/rtw88_core/parameters/disable_lps_deep; do
  if [ -w "$p" ]; then
    echo Y > "$p" && echo "   live: $p = $(cat "$p")" || echo "   live: could not write $p (applies at next boot)"
  fi
done

# ── 2. No package C-states deeper than C1E ──────────────────────────────────
cat > /usr/local/sbin/dp-limit-cstates <<'EOF'
#!/bin/sh
# Written by migrations/0028-stop-silent-freezes.sh — disable deep cpuidle states.
for s in /sys/devices/system/cpu/cpu*/cpuidle/state*; do
  case "$(cat "$s/name" 2>/dev/null)" in
    C6|C6S|C7|C7S|C8|C9|C10) echo 1 > "$s/disable" 2>/dev/null || true ;;
  esac
done
exit 0
EOF
chmod 755 /usr/local/sbin/dp-limit-cstates

cat > /etc/systemd/system/dp-limit-cstates.service <<'EOF'
# Written by migrations/0028-stop-silent-freezes.sh — see that file for why.
[Unit]
Description=Disable deep CPU idle states (silent-freeze mitigation)
After=sysinit.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/dp-limit-cstates
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable dp-limit-cstates.service
/usr/local/sbin/dp-limit-cstates

# ── 3. Keep the journal of a boot that died ─────────────────────────────────
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/90-dp-keep-evidence.conf <<'EOF'
# Written by migrations/0028-stop-silent-freezes.sh — see that file for why.
# Overrides size-limit.conf: bound by size only, never by age, so the log of
# a box that sat frozen for weeks is still there when it comes back.
[Journal]
Storage=persistent
SystemMaxUse=1G
MaxRetentionSec=0
EOF
systemctl restart systemd-journald
echo "Wrote /etc/systemd/journald.conf.d/90-dp-keep-evidence.conf"

echo "── Final state ──────────────────────────────────────────────────────────"
for p in /sys/module/rtw88_pci/parameters/disable_aspm /sys/module/rtw88_core/parameters/disable_lps_deep; do
  [ -e "$p" ] && echo "   $p = $(cat "$p")"
done
for s in /sys/devices/system/cpu/cpu0/cpuidle/state*; do
  [ -e "$s/name" ] && echo "   cpu0 $(cat "$s/name"): disable=$(cat "$s/disable")"
done
echo "   journald: $(systemd-analyze cat-config systemd/journald.conf 2>/dev/null | grep -E '^(SystemMaxUse|MaxRetentionSec)=' | tr '\n' ' ')"
