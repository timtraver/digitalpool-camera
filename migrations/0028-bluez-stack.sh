#!/usr/bin/env bash
# 0028-bluez-stack.sh — install the Bluetooth stack that BLE onboarding needs.
#
# Every box has working Bluetooth hardware and no software to drive it. The
# kernel side is already fine on both board profiles (BLUETOOTH_ONBOARDING.md
# §3.1): btusb binds, the vendor firmware in linux-firmware loads at boot, and
# /sys/class/bluetooth/hci0 exists. What is missing is userspace — only
# libbluetooth3 is installed, pulled in as somebody else's dependency, so there
# is no bluetoothd and therefore no GATT stack at all.
#
# This installs it and configures it for our one use: acting as a BLE
# peripheral that a phone connects to in order to set the box's network up.
#
#   * ControllerMode = le     BLE only. Nothing here speaks Classic Bluetooth,
#                             and iOS will not let an app use Classic serial
#                             without Apple's MFi programme, so Classic is only
#                             attack surface. (§2 D1)
#   * JustWorksRepairing      a phone that was factory-reset, or that "forgot"
#                             the box, can pair again without somebody driving
#                             to the venue to clear the bond.
#   * Privacy = off           a fixed address. Phones cache the GATT layout per
#                             address; a rotating one makes them rediscover.
#   * AutoEnable = true       power the adapter up at boot without anybody
#                             asking it to.
#
# rfkill comes along because digitalpool-ble.service unblocks the adapter
# before it starts, and the binary is not on the image either.
#
# This migration does NOT enable digitalpool-ble.service — that unit arrives
# with the daemon. Installing the stack early is harmless: bluetoothd with no
# GATT application registered advertises nothing and accepts no connections.
#
# Idempotent.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo "Installing bluez + rfkill..."
apt-get update -y
apt-get install -y bluez rfkill

CONF=/etc/bluetooth/main.conf

# Keep the distribution's file once, the first time, so there is something to
# compare against. Everything in it is commented out — the defaults are
# compiled in — so replacing it with a short managed file changes nothing
# except the keys named below.
if [ -f "$CONF" ] && [ ! -f "$CONF.dpkg-orig" ]; then
  cp -a "$CONF" "$CONF.dpkg-orig"
fi

cat > "$CONF" <<'CONFEOF'
# Managed by digitalpool-camera migration 0028-bluez-stack.sh.
# The packaged file is kept at main.conf.dpkg-orig; every key in it was
# commented out, so only the keys below differ from BlueZ's built-in defaults.
# See BLUETOOTH_ONBOARDING.md §4.1.

[General]
# BLE only — nothing on this box speaks Classic Bluetooth.
ControllerMode = le

# Let a phone that lost its bond pair again without a site visit.
JustWorksRepairing = always

# Fixed address: phones cache the GATT layout per address.
Privacy = off

# The adapter alias is deliberately NOT set here. dp-ble.py sets Adapter1.Alias
# at startup from getDeviceName(), so the box has one name in the app, the web
# UI, NetBird and the DigitalPool backend.

[Policy]
AutoEnable = true
CONFEOF

# Let the unprivileged `dp` user register GATT applications and advertisements
# with bluetoothd. Ubuntu's packaged policy grants most of this to the
# `bluetooth` group already, but the app must not depend on the distribution's
# group rules staying as they are today.
cat > /etc/dbus-1/system.d/digitalpool-ble.conf <<'DBUSEOF'
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<!-- Managed by digitalpool-camera migration 0028-bluez-stack.sh -->
<busconfig>
  <policy user="dp">
    <allow send_destination="org.bluez"/>
    <allow send_interface="org.bluez.GattCharacteristic1"/>
    <allow send_interface="org.bluez.GattDescriptor1"/>
    <allow send_interface="org.bluez.LEAdvertisement1"/>
    <allow send_interface="org.bluez.Agent1"/>
    <allow send_interface="org.freedesktop.DBus.ObjectManager"/>
    <allow send_interface="org.freedesktop.DBus.Properties"/>
  </policy>
</busconfig>
DBUSEOF

# dp needs to be in `bluetooth` for the packaged policy's sake as well.
if getent group bluetooth >/dev/null && id dp >/dev/null 2>&1; then
  if ! id -nG dp | tr ' ' '\n' | grep -qx bluetooth; then
    usermod -aG bluetooth dp
    echo "   added dp to the bluetooth group"
  fi
fi

systemctl reload dbus 2>/dev/null || true
systemctl enable bluetooth
systemctl restart bluetooth

# Report what we actually got. A box with no controller is not a failure —
# the Orange Pi 5 has no radio and stays on hotspot onboarding — so this
# reports and exits clean either way.
sleep 2
rfkill unblock bluetooth 2>/dev/null || true

if [ -d /sys/class/bluetooth ] && [ -n "$(ls -A /sys/class/bluetooth 2>/dev/null)" ]; then
  for hci in /sys/class/bluetooth/*; do
    name=$(basename "$hci")
    echo "   controller $name present"
  done
  if command -v bluetoothctl >/dev/null; then
    timeout 10 bluetoothctl show 2>/dev/null \
      | grep -E "Controller|Powered|Discoverable|^\s+Alias" | sed 's/^/   /' || true
  fi
else
  echo "   no Bluetooth controller on this board — BLE onboarding will not be used here"
fi

echo "bluez installed and configured for BLE peripheral use."
