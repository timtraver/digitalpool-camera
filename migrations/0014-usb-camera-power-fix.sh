#!/usr/bin/env bash
# 0014-usb-camera-power-fix.sh — actually pin USB cameras to power/control=on.
#
# 0008 installed 90-digitalpool-usb-camera-power.rules to stop the kernel
# autosuspending a capture device mid-stream.  A fleet audit on 2026-10-04 found
# it had NOT taken on 4 of 7 devices: the camera sat at power/control=auto while
# only the USB audio dongle read "on".
#
#   cc64  1-2  OBSBOT Tiny SE   auto      119c  1-2  OBSBOT Tiny SE   on
#   c889  1-1  OBSBOT Tiny SE   auto      76ff  1-1  OBSBOT Tiny SE   on
#   2e27  1-1  4K U3 Camera     auto      9605  1-2  OBSBOT Tiny SE   on
#   71a6  1-2  OBSBOT Tiny SE   auto
#
# A dry run of the sweep below then turned up a THIRD capture device that the
# audit's product-name filter had missed entirely: an AVer AN-VC22BA (2574:0562,
# two UVC interfaces + audio) at 2-1.1, sitting at "auto" on every device
# checked.  That is exactly why the sweep keys on interface CLASS rather than on
# a list of product names or vendors.
#
# Two defects in the old rules:
#
#   1. Two of the three rules match ATTR{bInterfaceClass}, which exists only on a
#      usb_INTERFACE.  power/control belongs to the usb_DEVICE that owns the
#      interface, so those rules could never set anything — assigning
#      ATTR{power/control} on an interface is a no-op.  Only the idVendor rule
#      could ever work, and it covers OBSBOT alone (the ELP "4K U3 Camera" on
#      2e27 is 32e4:6678 and matched nothing at all).
#
#   2. Even the vendor rule evidently did not stick on every device.  Rather than
#      keep guessing at udev ordering, this migration stops relying on the rule
#      being sufficient: it also sweeps every already-enumerated device now, and
#      installs a boot-time oneshot that sweeps again after udev has settled.
#
# Fix: match the INTERFACE (where bInterfaceClass lives) and write to its PARENT
# device, which is where power/control lives.  Belt and braces with device-level
# vendor rules, an immediate sweep, and a boot-time sweep.
#
# Idempotent: rewrites fixed files, re-runs the sweep, safe to repeat.
set -euo pipefail

RULES=/etc/udev/rules.d/90-digitalpool-usb-camera-power.rules
SWEEP=/usr/local/sbin/dp-usb-power-on.sh
UNIT=/etc/systemd/system/dp-usb-power.service

echo "── Before ───────────────────────────────────────────────────────────────"
for d in /sys/bus/usb/devices/*-*; do
  [ -f "$d/product" ] || continue
  printf '  %-10s %-30s %s\n' "$(basename "$d")" "$(cat "$d/product" 2>/dev/null)" \
         "$(cat "$d/power/control" 2>/dev/null || echo n/a)"
done

# ── 1. The sweep script — the part that is guaranteed to work ────────────────
# Walks every USB device that exposes a video (0e) or audio (01) interface and
# pins the owning device to "on".  Driven both from this migration and at boot.
cat > "$SWEEP" <<'SWEEPEOF'
#!/usr/bin/env bash
# dp-usb-power-on.sh — pin every USB capture device to power/control=on.
# Installed by migrations/0014-usb-camera-power-fix.sh — do not edit by hand.
#
# A UVC camera that the kernel autosuspends mid-capture drops off the bus.  udev
# rules are the primary mechanism; this sweep is the backstop that does not
# depend on event ordering or on a rule matching the right sysfs node.
set -uo pipefail
changed=0
for dev in /sys/bus/usb/devices/*-*; do
  # usb_device nodes have idVendor; interfaces (1-2:1.0) do not.
  [ -f "$dev/idVendor" ] || continue
  [ -w "$dev/power/control" ] || continue
  # Does this device expose a video or audio capture interface?
  capture=no
  for intf in "$dev"/*:*; do
    [ -f "$intf/bInterfaceClass" ] || continue
    case "$(cat "$intf/bInterfaceClass" 2>/dev/null)" in
      0e|01) capture=yes; break;;
    esac
  done
  [ "$capture" = "yes" ] || continue
  if [ "$(cat "$dev/power/control" 2>/dev/null)" != "on" ]; then
    echo on > "$dev/power/control" 2>/dev/null && {
      echo "  pinned $(basename "$dev") ($(cat "$dev/product" 2>/dev/null || echo '?')) -> on"
      changed=$((changed+1))
    }
  fi
done
[ "$changed" -eq 0 ] && echo "  all USB capture devices already pinned to 'on'"
exit 0
SWEEPEOF
chmod 0755 "$SWEEP"
echo "✅ Installed $SWEEP"

# ── 2. Replace the udev rules with ones that target the right sysfs node ─────
cat > "$RULES" <<'RULESEOF'
# Installed by migrations/0014-usb-camera-power-fix.sh — do not edit by hand.
# Supersedes the rules written by 0008.
#
# Keep USB capture devices powered on so the kernel never suspends a camera
# mid-capture, and re-apply on every re-enumeration.
#
# bInterfaceClass is an attribute of the usb_INTERFACE; power/control belongs to
# the usb_DEVICE that owns it.  The 0008 rules assigned ATTR{power/control} on
# interface events, which is a no-op — so match the interface and write to the
# parent device instead (/sys%p/.. is the owning device's syspath).
ACTION=="add", SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_interface", ATTR{bInterfaceClass}=="0e", RUN+="/bin/sh -c 'echo on > /sys%p/../power/control 2>/dev/null || true'"
ACTION=="add", SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_interface", ATTR{bInterfaceClass}=="01", RUN+="/bin/sh -c 'echo on > /sys%p/../power/control 2>/dev/null || true'"

# Belt and braces at the device level for the camera vendors in the fleet:
#   3564 = Remo Tech (OBSBOT Tiny SE / Tiny 2 Lite)
#   32e4 = ELP / "4K U3 Camera"
#   2574 = AVer Information (AN-VC22BA)
#   0573 = Zoran/Nogatech ("USB Audio and HID" dongle)
# The interface-class rules above already cover all of these; these are only a
# second line of defence for devices whose interfaces enumerate oddly.
ACTION=="add", SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="3564", TEST=="power/control", ATTR{power/control}="on"
ACTION=="add", SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="32e4", TEST=="power/control", ATTR{power/control}="on"
ACTION=="add", SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="2574", TEST=="power/control", ATTR{power/control}="on"
ACTION=="add", SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0573", TEST=="power/control", ATTR{power/control}="on"
RULESEOF
echo "✅ Wrote $RULES"
udevadm control --reload-rules || true

# ── 3. Boot-time sweep, after udev has settled ───────────────────────────────
# The udev rules above should be enough, but 0008 "should" have been enough too.
# This oneshot removes the dependence on that being true.
cat > "$UNIT" <<'UNITEOF'
[Unit]
Description=Pin USB capture devices to power/control=on (anti-autosuspend)
After=systemd-udev-settle.service multi-user.target
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
echo "✅ Enabled dp-usb-power.service (boot-time sweep)"

# ── 4. Apply to everything already on the bus, right now ─────────────────────
echo "── Sweeping currently-enumerated devices ────────────────────────────────"
"$SWEEP"

# ── 5. Report, and fail loudly if a capture device is still on autosuspend ───
echo "── After ────────────────────────────────────────────────────────────────"
still_auto=0
for d in /sys/bus/usb/devices/*-*; do
  [ -f "$d/idVendor" ] || continue
  capture=no
  for intf in "$d"/*:*; do
    [ -f "$intf/bInterfaceClass" ] || continue
    case "$(cat "$intf/bInterfaceClass" 2>/dev/null)" in 0e|01) capture=yes; break;; esac
  done
  [ "$capture" = "yes" ] || continue
  ctrl="$(cat "$d/power/control" 2>/dev/null || echo n/a)"
  printf '  %-10s %-30s %s\n' "$(basename "$d")" "$(cat "$d/product" 2>/dev/null)" "$ctrl"
  [ "$ctrl" = "on" ] || still_auto=$((still_auto+1))
done

if [ "$still_auto" -gt 0 ]; then
  echo "⚠️  $still_auto USB capture device(s) still NOT pinned to 'on' — investigate."
  exit 1
fi
echo "🔌 All USB capture devices pinned to power/control=on"
