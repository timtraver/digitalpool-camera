#!/usr/bin/env bash
# 0025-kernel-boot-guard.sh — never leave a kernel that cannot boot.
#
# The failure this exists for: an installed kernel with no initramfs. GRUB
# boots the newest kernel it finds; without an initrd there is no dm/LVM, the
# root volume cannot be opened, and the box panics somewhere nobody can reach
# it. It happened to four boxes at Ariakon on 2026-10-21 and four more were one
# reboot away.
#
# 0022/0023 fixed the DKMS build that caused it. This guards the CLASS of
# problem instead: whatever stops an initramfs being generated — a failed hook,
# a full /boot, an interrupted upgrade — the guard notices and builds it, at
# every boot and once a day. It also writes what it found where the app can
# see it, so a box that cannot be repaired says so by email rather than waiting
# silently for its next reboot.
#
# And it gives GRUB a three-second menu, so a box that does fail leaves a human
# at the venue a way in without holding Shift blind against a zero timeout.
#
# Idempotent.
set -euo pipefail

STATE_DIR=/var/lib/digitalpool-camera
GUARD=/usr/local/sbin/dp-kernel-guard

mkdir -p "$STATE_DIR"

cat > "$GUARD" <<'GUARDEOF'
#!/usr/bin/env bash
# dp-kernel-guard — make sure every installed kernel can actually boot.
#
# For each kernel in /boot, check it has an initramfs and build one if it does
# not. Writes what it found to kernel-guard.json; server.js reads that and
# emails when a box is in a state that would brick it (see _pollKernelHealth).
#
# Run by dp-kernel-guard.service at boot and dp-kernel-guard.timer daily.
set -uo pipefail

STATE=/var/lib/digitalpool-camera/kernel-guard.json
repaired=()
unbootable=()
checked=()

for vmlinuz in /boot/vmlinuz-*; do
  [ -e "$vmlinuz" ] || continue
  release="${vmlinuz#/boot/vmlinuz-}"
  # A vmlinuz with no module tree is a leftover, not a kernel this box can run.
  [ -d "/lib/modules/$release" ] || continue
  checked+=("$release")
  [ -f "/boot/initrd.img-$release" ] && continue

  echo "dp-kernel-guard: $release has no initramfs — building one"
  if update-initramfs -c -k "$release" >/dev/null 2>&1; then
    repaired+=("$release")
    echo "dp-kernel-guard: built initrd.img-$release"
  else
    unbootable+=("$release")
    echo "dp-kernel-guard: FAILED to build an initramfs for $release" >&2
  fi
done

if [ ${#repaired[@]} -gt 0 ]; then
  update-grub >/dev/null 2>&1 || echo "dp-kernel-guard: update-grub failed" >&2
fi

pending="$(dpkg --audit 2>/dev/null | grep -cE "^ [a-z]" || true)"

json_list() {
  local first=1 item
  printf '['
  for item in "$@"; do
    [ $first -eq 1 ] || printf ','
    printf '"%s"' "$item"
    first=0
  done
  printf ']'
}

tmp="$(mktemp)"
{
  printf '{"at":"%s","checked":%s,"repaired":%s,"unbootable":%s,"pendingPackages":%s}\n' \
    "$(date -Is)" \
    "$(json_list "${checked[@]+"${checked[@]}"}")" \
    "$(json_list "${repaired[@]+"${repaired[@]}"}")" \
    "$(json_list "${unbootable[@]+"${unbootable[@]}"}")" \
    "${pending:-0}"
} > "$tmp"
install -m 0644 "$tmp" "$STATE"
rm -f "$tmp"

if [ ${#unbootable[@]} -gt 0 ]; then
  echo "dp-kernel-guard: ${#unbootable[@]} kernel(s) cannot boot — THIS BOX WILL PANIC IF IT REBOOTS" >&2
  exit 1
fi
echo "dp-kernel-guard: ${#checked[@]} kernel(s) checked, ${#repaired[@]} repaired"
GUARDEOF
chmod 0755 "$GUARD"
echo "Installed $GUARD"

cat > /etc/systemd/system/dp-kernel-guard.service <<'UNIT'
[Unit]
Description=DigitalPool Camera — make sure every installed kernel can boot
# After the filesystems are up; before the app, so a repair is logged first.
After=local-fs.target
Before=digitalpool-camera.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/dp-kernel-guard
# A box that cannot repair itself must still boot and stream. The failure is
# reported by email through the app, not by refusing to start.
SuccessExitStatus=0 1
RemainAfterExit=no

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/dp-kernel-guard.timer <<'UNIT'
[Unit]
Description=DigitalPool Camera — daily check that every kernel can boot

[Timer]
# Daily, soon after a typical unattended-upgrade window, with a spread so a
# fleet does not all rebuild initramfses at the same minute.
OnCalendar=*-*-* 07:30:00
RandomizedDelaySec=1800
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable dp-kernel-guard.service >/dev/null 2>&1 || true
systemctl enable --now dp-kernel-guard.timer >/dev/null 2>&1 || true
echo "Enabled dp-kernel-guard.service (boot) and .timer (daily)"

# ── A way back in when something does go wrong ───────────────────────────────
# GRUB_TIMEOUT=0 with a hidden menu means a field failure needs somebody to
# hold Shift from power-on and hope. Three seconds costs three seconds.
if grep -q '^GRUB_TIMEOUT=0$' /etc/default/grub; then
  sed -i 's/^GRUB_TIMEOUT=0$/GRUB_TIMEOUT=3/' /etc/default/grub
  echo "GRUB_TIMEOUT 0 → 3"
fi
if grep -q '^GRUB_TIMEOUT_STYLE=hidden$' /etc/default/grub; then
  sed -i 's/^GRUB_TIMEOUT_STYLE=hidden$/GRUB_TIMEOUT_STYLE=menu/' /etc/default/grub
  echo "GRUB_TIMEOUT_STYLE hidden → menu"
fi

echo "Running the guard now:"
"$GUARD" | sed 's/^/   /' || true
update-grub >/dev/null 2>&1 || true

echo "── Final state ──────────────────────────────────────────────────────────"
sed 's/^/   /' /var/lib/digitalpool-camera/kernel-guard.json 2>/dev/null || echo "   (no state file)"
grep -E "^GRUB_TIMEOUT" /etc/default/grub | sed 's/^/   /'
