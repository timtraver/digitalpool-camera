#!/usr/bin/env python3
"""ble-smoketest.py — prove this box can be a BLE peripheral.

The M0 "hello world" from BLUETOOTH_ONBOARDING.md §14: bring up the real
service UUID with the real RX/TX characteristics and the real advertisement
layout, so a phone (nRF Connect) or a laptop can see the box, connect, write to
it and get a notification back.

It is deliberately NOT dp-ble.py. There is no pairing agent, no encryption
requirement, no chunking, no socket to Node, and no recovery when bluetoothd
restarts. RX echoes whatever it is given back on TX. What it does prove is the
whole D-Bus path the real daemon depends on: GattManager1.RegisterApplication,
LEAdvertisingManager1.RegisterAdvertisement, notifications, and that the
controller in this board will actually advertise and accept a connection.

⚠ DO NOT RUN THIS ON A BOX A REAL PHONE WILL LATER PAIR WITH.

It deliberately uses the production service and characteristic UUIDs, so that
the smoke test exercises the real path — but it exposes them UNENCRYPTED and at
different attribute handles from dp-ble.py. A phone that bonds with the box
while this is running caches that GATT layout, and iOS trusts its cache for a
bonded peripheral: discovery then appears to succeed against the real daemon
and the first write lands on a handle that no longer exists. It cost an evening
on 2026-11-11, and nothing in the box's logs points at the cause — there is no
pairing or encryption error, because the write never gets far enough to need a
key. The only way out is forgetting the device on the phone AND removing the
bond on the box.

Use it on a bench box, with a laptop or a spare handset, and remove any bonds
it created before that box meets a real phone:

    bluetoothctl paired-devices
    bluetoothctl remove <address>

Run it on the box, in the foreground, and watch:

    python3 ble/tools/ble-smoketest.py

Then scan from a phone. Ctrl-C to stop.
"""

import argparse
import os
import sys

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

BLUEZ = "org.bluez"
ADAPTER_IFACE = "org.bluez.Adapter1"
GATT_MANAGER_IFACE = "org.bluez.GattManager1"
LE_ADVERTISING_MANAGER_IFACE = "org.bluez.LEAdvertisingManager1"
LE_ADVERTISEMENT_IFACE = "org.bluez.LEAdvertisement1"
GATT_SERVICE_IFACE = "org.bluez.GattService1"
GATT_CHRC_IFACE = "org.bluez.GattCharacteristic1"
DBUS_OM_IFACE = "org.freedesktop.DBus.ObjectManager"
DBUS_PROP_IFACE = "org.freedesktop.DBus.Properties"

# BLUETOOTH_ONBOARDING.md §6.1
SERVICE_UUID = "3f8abaa2-7312-4a07-be35-7c7f1618bb6a"
RX_UUID = "b81717c7-da32-444b-804d-5dbe7e7d756c"  # phone -> box, write
TX_UUID = "ea362436-362f-4ceb-8211-f6db458206a3"  # box -> phone, notify

# §5.2 — 0xFFFF is the Bluetooth SIG's "for testing" company id.
COMPANY_ID = 0xFFFF
PROTO = 1

BASE_PATH = "/com/digitalpool/smoketest"


class InvalidArgs(dbus.exceptions.DBusException):
    _dbus_error_name = "org.freedesktop.DBus.Error.InvalidArgs"


class NotSupported(dbus.exceptions.DBusException):
    _dbus_error_name = "org.bluez.Error.NotSupported"


class Application(dbus.service.Object):
    """The object-manager root BlueZ reads the GATT tree from."""

    def __init__(self, bus):
        self.path = BASE_PATH
        self.services = []
        dbus.service.Object.__init__(self, bus, self.path)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def add_service(self, service):
        self.services.append(service)

    @dbus.service.method(DBUS_OM_IFACE, out_signature="a{oa{sa{sv}}}")
    def GetManagedObjects(self):
        response = {}
        for service in self.services:
            response[service.get_path()] = service.get_properties()
            for chrc in service.characteristics:
                response[chrc.get_path()] = chrc.get_properties()
        return response


class Service(dbus.service.Object):
    def __init__(self, bus, index, uuid, primary=True):
        self.path = "%s/service%d" % (BASE_PATH, index)
        self.uuid = uuid
        self.primary = primary
        self.characteristics = []
        dbus.service.Object.__init__(self, bus, self.path)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def add_characteristic(self, chrc):
        self.characteristics.append(chrc)

    def get_properties(self):
        return {
            GATT_SERVICE_IFACE: {
                "UUID": self.uuid,
                "Primary": self.primary,
                "Characteristics": dbus.Array(
                    [c.get_path() for c in self.characteristics], signature="o"
                ),
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != GATT_SERVICE_IFACE:
            raise InvalidArgs()
        return self.get_properties()[GATT_SERVICE_IFACE]


class Characteristic(dbus.service.Object):
    def __init__(self, bus, index, uuid, flags, service):
        self.path = "%s/char%d" % (service.path, index)
        self.uuid = uuid
        self.flags = flags
        self.service = service
        self.notifying = False
        dbus.service.Object.__init__(self, bus, self.path)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def get_properties(self):
        return {
            GATT_CHRC_IFACE: {
                "UUID": self.uuid,
                "Service": self.service.get_path(),
                "Flags": self.flags,
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != GATT_CHRC_IFACE:
            raise InvalidArgs()
        return self.get_properties()[GATT_CHRC_IFACE]

    @dbus.service.signal(DBUS_PROP_IFACE, signature="sa{sv}as")
    def PropertiesChanged(self, interface, changed, invalidated):
        pass

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, options):
        raise NotSupported()

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="aya{sv}")
    def WriteValue(self, value, options):
        raise NotSupported()

    @dbus.service.method(GATT_CHRC_IFACE)
    def StartNotify(self):
        self.notifying = True
        print("  TX: phone subscribed to notifications")

    @dbus.service.method(GATT_CHRC_IFACE)
    def StopNotify(self):
        self.notifying = False
        print("  TX: phone unsubscribed")


class TxCharacteristic(Characteristic):
    def __init__(self, bus, index, service):
        Characteristic.__init__(self, bus, index, TX_UUID, ["notify"], service)

    def notify(self, payload: bytes):
        if not self.notifying:
            print("  TX: nobody is subscribed, dropping %d bytes" % len(payload))
            return
        self.PropertiesChanged(
            GATT_CHRC_IFACE,
            {"Value": dbus.Array([dbus.Byte(b) for b in payload], signature="y")},
            [],
        )
        print("  TX: notified %d bytes" % len(payload))


class RxCharacteristic(Characteristic):
    """Echoes every write straight back out on TX."""

    def __init__(self, bus, index, service, tx):
        Characteristic.__init__(self, bus, index, RX_UUID, ["write"], service)
        self.tx = tx

    def WriteValue(self, value, options):
        payload = bytes(bytearray(value))
        device = options.get("device", "?")
        print("  RX: %d bytes from %s: %r" % (len(payload), device, payload[:64]))
        self.tx.notify(b"echo:" + payload)


class Advertisement(dbus.service.Object):
    def __init__(self, bus, index, local_name, short_id):
        self.path = "%s/advertisement%d" % (BASE_PATH, index)
        self.local_name = local_name[:20]
        # §5.2: proto, state bits, shortId (u16, little endian)
        self.mfg = bytes([PROTO, 0x00, short_id & 0xFF, (short_id >> 8) & 0xFF])
        dbus.service.Object.__init__(self, bus, self.path)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def get_properties(self):
        return {
            LE_ADVERTISEMENT_IFACE: {
                "Type": "peripheral",
                # Without this BlueZ inherits the adapter's Discoverable flag,
                # which is false, and builds an AD whose Flags byte says "not
                # discoverable". The controller transmits it and general-
                # discovery scanners drop it, so the box is invisible while
                # looking perfectly healthy from its own side.
                "Discoverable": dbus.Boolean(True),
                "ServiceUUIDs": dbus.Array([SERVICE_UUID], signature="s"),
                "LocalName": dbus.String(self.local_name),
                "ManufacturerData": dbus.Dictionary(
                    {
                        dbus.UInt16(COMPANY_ID): dbus.Array(
                            [dbus.Byte(b) for b in self.mfg], signature="y"
                        )
                    },
                    signature="qv",
                ),
                "Includes": dbus.Array(["tx-power"], signature="s"),
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != LE_ADVERTISEMENT_IFACE:
            raise InvalidArgs()
        return self.get_properties()[LE_ADVERTISEMENT_IFACE]

    @dbus.service.method(LE_ADVERTISEMENT_IFACE)
    def Release(self):
        print("Advertisement released by BlueZ")


def find_adapter(bus):
    manager = dbus.Interface(bus.get_object(BLUEZ, "/"), DBUS_OM_IFACE)
    for path, ifaces in manager.GetManagedObjects().items():
        if GATT_MANAGER_IFACE in ifaces and LE_ADVERTISING_MANAGER_IFACE in ifaces:
            return path, ifaces[ADAPTER_IFACE]
    return None, None


def primary_mac():
    """The wired NIC's MAC — the same one dp-ble.py and server.js pick."""
    net_dir = "/sys/class/net"

    def rank(name):
        if name.startswith("en") or name.startswith("eth"):
            return 0
        return 1 if name.startswith("wl") else 2

    try:
        for iface in sorted(os.listdir(net_dir), key=rank):
            if iface == "lo" or not os.path.exists(os.path.join(net_dir, iface, "device")):
                continue
            try:
                with open(os.path.join(net_dir, iface, "address")) as handle:
                    mac = handle.read().strip().lower()
            except OSError:
                continue
            if mac and mac != "00:00:00:00:00:00":
                return mac
    except OSError:
        pass
    return ""


def device_name(mac):
    """DP-DuoCast-XXXX — what the app shows and what the box is labelled."""
    suffix = mac.replace(":", "")[-4:].upper() if mac else "0000"
    return ("DP-DuoCast-" + suffix)[:20]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", help="BLE local name (default: hostname)")
    args = parser.parse_args()

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()

    adapter_path, adapter_props = find_adapter(bus)
    if not adapter_path:
        print("No Bluetooth adapter with GATT + advertising support.", file=sys.stderr)
        print("Is bluez installed and bluetooth.service running?", file=sys.stderr)
        return 1

    props = dbus.Interface(bus.get_object(BLUEZ, adapter_path), DBUS_PROP_IFACE)
    address = str(props.Get(ADAPTER_IFACE, "Address"))
    if not props.Get(ADAPTER_IFACE, "Powered"):
        print("Adapter is off; powering it on")
        props.Set(ADAPTER_IFACE, "Powered", dbus.Boolean(1))

    mac = primary_mac()
    name = args.name or device_name(mac)
    props.Set(ADAPTER_IFACE, "Alias", dbus.String(name[:20]))

    # §5.2 shortId: the last 4 hex digits of the PRIMARY MAC, not of the
    # Bluetooth adapter — a combo card's BT half has its own address, and the
    # app matches this against the name on the box.
    try:
        short_id = int((mac or address).replace(":", "")[-4:], 16)
    except ValueError:
        short_id = 0

    app = Application(bus)
    service = Service(bus, 0, SERVICE_UUID)
    tx = TxCharacteristic(bus, 0, service)
    rx = RxCharacteristic(bus, 1, service, tx)
    service.add_characteristic(tx)
    service.add_characteristic(rx)
    app.add_service(service)

    adv = Advertisement(bus, 0, name, short_id)

    gatt_mgr = dbus.Interface(bus.get_object(BLUEZ, adapter_path), GATT_MANAGER_IFACE)
    adv_mgr = dbus.Interface(
        bus.get_object(BLUEZ, adapter_path), LE_ADVERTISING_MANAGER_IFACE
    )

    loop = GLib.MainLoop()

    def fail(where):
        def handler(error):
            print("%s failed: %s" % (where, error), file=sys.stderr)
            loop.quit()

        return handler

    gatt_mgr.RegisterApplication(
        app.get_path(),
        {},
        reply_handler=lambda: print("GATT application registered"),
        error_handler=fail("RegisterApplication"),
    )
    adv_mgr.RegisterAdvertisement(
        adv.get_path(),
        {},
        reply_handler=lambda: print("Advertisement registered"),
        error_handler=fail("RegisterAdvertisement"),
    )

    print("")
    print("  adapter    %s (%s)" % (adapter_path.split("/")[-1], address))
    print("  local name %s" % name[:20])
    print("  service    %s" % SERVICE_UUID)
    print("  mfg data   company 0x%04X, %s" % (COMPANY_ID, adv.mfg.hex()))
    print("")
    print("Scan for it now. Ctrl-C to stop.")

    try:
        loop.run()
    except KeyboardInterrupt:
        print("\nStopping")
    finally:
        try:
            adv_mgr.UnregisterAdvertisement(adv.get_path())
            gatt_mgr.UnregisterApplication(app.get_path())
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
