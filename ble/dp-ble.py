#!/usr/bin/env python3
"""dp-ble.py — the BLE onboarding daemon.

What it is: a thin pipe between a phone and the Node app. It owns the GATT
server, the advertisement, the pairing agent and the message framing, and it
forwards whole reassembled messages to Node over a unix socket. It never reads
what is inside them. Everything that decides anything — auth, network changes,
registration — lives in Node, so the web UI and the app share one code path.

See BLUETOOTH_ONBOARDING.md: §4 for the architecture, §5 for advertising, §6
for the GATT protocol.

Run it from digitalpool-ble.service. It deliberately does NOT depend on
digitalpool-camera.service: if Node restarts, this keeps advertising and
answers UNAVAILABLE until the socket comes back.
"""

import argparse
import errno
import json
import os
import random
import socket
import string
import sys
import time

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

# ──────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────

BLUEZ = "org.bluez"
ADAPTER_IFACE = "org.bluez.Adapter1"
DEVICE_IFACE = "org.bluez.Device1"
GATT_MANAGER_IFACE = "org.bluez.GattManager1"
GATT_SERVICE_IFACE = "org.bluez.GattService1"
GATT_CHRC_IFACE = "org.bluez.GattCharacteristic1"
LE_ADV_MANAGER_IFACE = "org.bluez.LEAdvertisingManager1"
LE_ADV_IFACE = "org.bluez.LEAdvertisement1"
AGENT_MANAGER_IFACE = "org.bluez.AgentManager1"
AGENT_IFACE = "org.bluez.Agent1"
DBUS_OM_IFACE = "org.freedesktop.DBus.ObjectManager"
DBUS_PROP_IFACE = "org.freedesktop.DBus.Properties"

# §6.1
SERVICE_UUID = "3f8abaa2-7312-4a07-be35-7c7f1618bb6a"
RX_UUID = "b81717c7-da32-444b-804d-5dbe7e7d756c"
TX_UUID = "ea362436-362f-4ceb-8211-f6db458206a3"

# §5.2 — 0xFFFF is the Bluetooth SIG's "for testing" company id. If DigitalPool
# ever registers one of its own this is the single place it changes.
COMPANY_ID = 0xFFFF
PROTO = 1

# §5.1 — what a phone sees in its list. The product name, not the hostname:
# "dp-stream-b1b5" means nothing to somebody setting a camera up for the first
# time. The four hex digits are the last of the primary MAC, so they match the
# hostname suffix, the hotspot SSID and the sticker on the box.
BLE_NAME_PREFIX = "DP-DuoCast-"

# ── A note on ATT handles, and why they are NOT pinned ────────────────────
#
# BlueZ allocates handles dynamically at RegisterApplication, so they move
# whenever this daemon restarts. A bonded iOS client caches the GATT database
# by handle and does not re-read it, so after a restart its next connect fails
# with ATT 0x01 "Invalid Handle" on the first subscribe, and the user has to
# forget the box in Settings › Bluetooth. That is a real problem — field boxes
# get software updates — and BlueZ documents a `Handle` property (≥ 5.51) that
# looks like the answer.
#
# It was tried on 2026-11-11 and reverted the same evening. BlueZ 5.72 honours
# the request on the SERVICE and does not honour it on the CHARACTERISTICS: it
# placed the first characteristic's value at the service's own handle whatever
# was asked for, producing a table with DUPLICATE handles:
#
#     service 0x0040   char 0x0040   desc 0x0042   char 0x0043
#
# BlueZ and bleak-on-BlueZ tolerate that. Apple does not, and fails hard:
# CoreBluetooth resolves the duplicated handle to the service, puts a CBService
# into the characteristics list, and the iOS app dies inside its discovery
# callback (EXC_BREAKPOINT in RxBluetoothKit's compactMap). bleak on macOS
# dies the same way — 'CBService' object has no attribute 'handle', then a
# segfault. So pinning made every Apple device unable to connect to any box,
# which is far worse than the problem it was meant to fix.
#
# If this is attempted again: BlueZ-to-BlueZ testing CANNOT catch it. Validate
# the attribute table from a CoreBluetooth client, and assert the handles are
# unique and strictly ascending — not merely stable, which was the mistake
# the first time. ble/tools/handlecheck is the shape of that test.
#
# Until then, a daemon restart may cost paired phones one "forget". The app
# detects ATT 0x01/0x0A and tells the user to do exactly that.

BASE_PATH = "/com/digitalpool/ble"
AGENT_PATH = BASE_PATH + "/agent"

SOCKET_PATH = "/run/digitalpool-camera/ble.sock"

# §8.1. The unit is always enabled; this file decides whether the box actually
# advertises. Keeping the switch here rather than in systemd means flipping a
# box between onboarding modes is an .env write the app can do as `dp`, with no
# root and no `systemctl enable`.
ENV_FILE = "/home/dp/digitalpool-camera/.env"
MODE_RECHECK = True

# §6.2
CHUNK_HEADER = 3            # msgId, index, count
MAX_MESSAGE = 16 * 1024
REASSEMBLY_TIMEOUT = 5.0    # drop a partial message after this long
DEFAULT_MTU = 23            # what a phone that never negotiates gives us

# §5.3
SELF_CHECK_SECONDS = 60
SOCKET_RETRY_MIN = 1.0
SOCKET_RETRY_MAX = 30.0

# §5.4
MAX_BONDS = 20

# Notifications are emitted as PropertiesChanged signals. Pacing them keeps a
# slow or busy connection from having chunks coalesced out from under it; the
# cost on a 3 KB scan result is about a tenth of a second.
TX_PACING_MS = 10

LOG_PREFIX = "dp-ble"


def primary_mac():
    """This box's primary MAC, lowercase.

    Mirrors getPrimaryMac() in server.js and primary_mac() in dp-firstboot.sh:
    the wired NIC wins even with no cable, because that is what the hostname
    suffix, the hotspot SSID and the grant binding (§7.2) are all derived from.
    Reading sysfs rather than asking for live interfaces is what makes a
    cable-less wired port still count.
    """
    net_dir = "/sys/class/net"

    def rank(name):
        if name.startswith("en") or name.startswith("eth"):
            return 0
        if name.startswith("wl"):
            return 1
        return 2

    try:
        for iface in sorted(os.listdir(net_dir), key=rank):
            if iface == "lo":
                continue
            # No backing device means a virtual interface — bridges, wireguard.
            if not os.path.exists(os.path.join(net_dir, iface, "device")):
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


def short_id(mac):
    """The last four hex digits of a MAC, as an int, or 0."""
    try:
        return int(mac.replace(":", "")[-4:], 16)
    except (ValueError, AttributeError):
        return 0


def onboarding_mode():
    """`auto` | `ble` | `hotspot`, from the environment or .env (§8.1).

    Read fresh every time rather than cached at startup, so a mode change takes
    effect on the next self-check tick instead of at the next reboot.
    """
    mode = os.environ.get("ONBOARDING_MODE")
    if not mode:
        try:
            with open(ENV_FILE) as handle:
                for line in handle:
                    line = line.strip()
                    if line.startswith("ONBOARDING_MODE="):
                        mode = line.split("=", 1)[1].strip()
        except OSError:
            pass
    mode = (mode or "auto").lower()
    return mode if mode in ("auto", "ble", "hotspot") else "auto"


def log(msg):
    """Journal lines, unbuffered — systemd captures stdout."""
    print("[%s] %s" % (LOG_PREFIX, msg), flush=True)


class InvalidArgs(dbus.exceptions.DBusException):
    _dbus_error_name = "org.freedesktop.DBus.Error.InvalidArgs"


class Failed(dbus.exceptions.DBusException):
    _dbus_error_name = "org.bluez.Error.Failed"


class NotSupported(dbus.exceptions.DBusException):
    _dbus_error_name = "org.bluez.Error.NotSupported"


class Rejected(dbus.exceptions.DBusException):
    _dbus_error_name = "org.bluez.Error.Rejected"


# ──────────────────────────────────────────────────────────────────────────
# GATT objects
# ──────────────────────────────────────────────────────────────────────────


class Application(dbus.service.Object):
    """The ObjectManager root BlueZ reads our GATT tree from."""

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
        out = {}
        for service in self.services:
            out[service.get_path()] = service.get_properties()
            for chrc in service.characteristics:
                out[chrc.get_path()] = chrc.get_properties()
        return out


class OnboardingService(dbus.service.Object):
    def __init__(self, bus, index=0):
        self.path = "%s/service%d" % (BASE_PATH, index)
        self.characteristics = []
        dbus.service.Object.__init__(self, bus, self.path)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def add_characteristic(self, chrc):
        self.characteristics.append(chrc)

    def get_properties(self):
        return {
            GATT_SERVICE_IFACE: {
                "UUID": SERVICE_UUID,
                "Primary": dbus.Boolean(True),
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

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="ssv")
    def Set(self, interface, prop, value):
        if interface == GATT_SERVICE_IFACE and prop == "Handle":
            self.handle = int(value)


class BaseCharacteristic(dbus.service.Object):
    def __init__(self, bus, index, uuid, flags, service, handle=0):
        self.path = "%s/char%d" % (service.path, index)
        self.uuid = uuid
        self.flags = flags
        self.service = service
        self.handle = handle
        dbus.service.Object.__init__(self, bus, self.path)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def get_properties(self):
        return {
            GATT_CHRC_IFACE: {
                "UUID": self.uuid,
                "Service": self.service.get_path(),
                "Flags": dbus.Array(self.flags, signature="s"),
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="ssv")
    def Set(self, interface, prop, value):
        # BlueZ writes Handle back after allocation. Accepting it keeps our
        # view and the database's in step; refusing would make BlueZ log an
        # error on every registration.
        if interface == GATT_CHRC_IFACE and prop == "Handle":
            self.handle = int(value)

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != GATT_CHRC_IFACE:
            raise InvalidArgs()
        return self.get_properties()[GATT_CHRC_IFACE]

    @dbus.service.signal(DBUS_PROP_IFACE, signature="sa{sv}as")
    def PropertiesChanged(self, interface, changed, invalidated):
        pass

    def negotiated_mtu(self):
        """The ATT MTU for this link, learned from BlueZ.

        It comes from the `mtu` key BlueZ puts in WriteValue's options — i.e.
        from the phone's first write — and NOT from a property on this object.
        An earlier version read `GattCharacteristic1.MTU` off `self.path` via
        org.bluez, which cannot work: that path is exported by THIS process,
        not by bluetoothd, so every call raised and silently fell back to 23.
        The effect was invisible and expensive — every message chunked at 17
        bytes, about ten times the packets needed, so a venue list went out as
        a long burst of tiny notifications. On a BT 4.2 controller the real
        value is nearer 247 (§3.4).
        """
        # REVERTED 2026-11-11, deliberately. See the note below.
        #
        # Using the value BlueZ reports broke iPhone connections within the
        # hour: for an iOS link it reported 517, which iOS does not negotiate.
        # Chunking to 511 bytes against a link that cannot carry them means the
        # notifications are truncated or dropped, the app never reassembles a
        # complete message, and `info` times out with no error anywhere — the
        # box logs a happy send, the phone waits 15 s and gives up.
        #
        # The honest problem: there is no source on the box for the TRUE
        # notification MTU short of AcquireNotify, which returns it alongside
        # an fd and is a different notification path altogether. The value in
        # WriteValue's options is not it. And ANY value above 23 that turns out
        # to be wrong fails silently and identically, so guessing — clamping to
        # 185, or 247 — is not safer, it just moves which phones break.
        #
        # 23 is the only size the spec guarantees every link can carry, and it
        # is what worked all day before this. It costs packets, not
        # correctness. Doing this properly means AcquireNotify, which is worth
        # doing on its own, with a phone to test against, and not at the end of
        # a long day of changes to this file.
        #
        # The learned value is still recorded in the journal, so the data for
        # that work is being collected.
        return DEFAULT_MTU


class TxCharacteristic(BaseCharacteristic):
    """box → phone. Notifications, chunked and paced."""

    def __init__(self, bus, index, service, daemon, encrypted=True):
        flags = ["encrypt-notify"] if encrypted else ["notify"]
        BaseCharacteristic.__init__(self, bus, index, TX_UUID, flags, service,
                                    )
        self.daemon = daemon
        self.notifying = False
        self._queue = []        # list of bytes, each one chunk
        self._pump_source = None
        self._next_msg_id = random.randint(0, 255)

    @dbus.service.method(GATT_CHRC_IFACE)
    def StartNotify(self):
        if self.notifying:
            return
        self.notifying = True
        log("TX: subscribed (MTU %s)"
            % (self.daemon.att_mtu if self.daemon.att_mtu else "not yet known"))
        self.daemon.report_notify(True)

    @dbus.service.method(GATT_CHRC_IFACE)
    def StopNotify(self):
        self.notifying = False
        self._queue = []
        log("TX: unsubscribed")
        # Node uses this to spot a link iOS is holding open after the app has
        # gone: the app unsubscribes, the link stays up, and on an N97 that
        # makes the box undiscoverable until something terminates it.
        self.daemon.report_notify(False)

    # `notifying` is kept for the journal only — see send() for why it is not
    # what decides whether a message goes out.

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, options):
        # Notify-only. A phone that reads this gets nothing useful rather than
        # an error, which keeps generic BLE explorers from looking broken.
        raise NotSupported()

    def send(self, obj):
        """Frame one JSON message into chunks and queue them (§6.2).

        Note what is NOT checked here: `self.notifying`. BlueZ keeps a bonded
        client's CCCD across connections and restores it on reconnect without
        calling StartNotify on us again, so after the very first pairing this
        object never hears that the phone subscribed — and gating on it meant
        dropping every reply from the second connection onwards, which is to
        say every connection after setup. Emitting regardless is safe: BlueZ
        discards a notification nobody is subscribed to.
        """
        if not self.daemon.connections:
            log("TX: no connection, dropping a message")
            return
        payload = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        if len(payload) > MAX_MESSAGE:
            log("TX: refusing to send %d bytes (limit %d)" % (len(payload), MAX_MESSAGE))
            return

        body = self.negotiated_mtu() - 3 - CHUNK_HEADER
        if body < 1:
            body = DEFAULT_MTU - 3 - CHUNK_HEADER
        count = max(1, (len(payload) + body - 1) // body)
        if count > 255:
            log("TX: message needs %d chunks, over the 255 limit" % count)
            return

        msg_id = self._next_msg_id
        self._next_msg_id = (self._next_msg_id + 1) % 256
        for index in range(count):
            piece = payload[index * body:(index + 1) * body]
            self._queue.append(bytes([msg_id, index, count]) + piece)

        if self._pump_source is None:
            self._pump_source = GLib.timeout_add(TX_PACING_MS, self._pump)

    def _pump(self):
        if not self._queue or not self.daemon.connections:
            self._pump_source = None
            return False
        chunk = self._queue.pop(0)
        self.PropertiesChanged(
            GATT_CHRC_IFACE,
            {"Value": dbus.Array([dbus.Byte(b) for b in chunk], signature="y")},
            [],
        )
        if not self._queue:
            self._pump_source = None
            return False
        return True


class RxCharacteristic(BaseCharacteristic):
    """phone → box. Writes, reassembled then handed to Node."""

    def __init__(self, bus, index, service, daemon, encrypted=True):
        flags = ["encrypt-write"] if encrypted else ["write"]
        BaseCharacteristic.__init__(self, bus, index, RX_UUID, flags, service,
                                    )
        self.daemon = daemon
        # device path -> {"id": msgId, "count": n, "parts": {}, "at": t}
        self._partial = {}

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="aya{sv}")
    def WriteValue(self, value, options):
        data = bytes(bytearray(value))
        device = str(options.get("device", ""))
        if len(data) < CHUNK_HEADER:
            log("RX: runt chunk (%d bytes), ignoring" % len(data))
            return

        # BlueZ reports the negotiated ATT MTU here. It is the only place we
        # get it, so take it on every write — the first one usually arrives
        # before we have anything to send back.
        try:
            mtu = int(options.get("mtu", 0))
            if mtu >= DEFAULT_MTU and mtu != self.daemon.att_mtu:
                self.daemon.att_mtu = mtu
                # Recorded, NOT used for chunking — see negotiated_mtu().
                log("ATT MTU reported for this link: %d (notifications still "
                    "chunked at %d; see negotiated_mtu)" % (mtu, DEFAULT_MTU))
        except (TypeError, ValueError):
            pass

        msg_id, index, count = data[0], data[1], data[2]
        piece = data[CHUNK_HEADER:]
        if count == 0 or index >= count:
            log("RX: malformed header id=%d i=%d n=%d" % (msg_id, index, count))
            return

        state = self._partial.get(device)
        now = time.monotonic()
        # A new msgId, or a stale partial, replaces whatever was in progress.
        if (
            state is None
            or state["id"] != msg_id
            or now - state["at"] > REASSEMBLY_TIMEOUT
        ):
            state = {"id": msg_id, "count": count, "parts": {}, "at": now}
            self._partial[device] = state

        state["parts"][index] = piece
        state["at"] = now

        if sum(len(p) for p in state["parts"].values()) > MAX_MESSAGE:
            log("RX: message over %d bytes, dropping" % MAX_MESSAGE)
            self._partial.pop(device, None)
            return

        if len(state["parts"]) < state["count"]:
            return

        self._partial.pop(device, None)
        raw = b"".join(state["parts"][i] for i in range(state["count"]))
        try:
            obj = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            # Size and the exception only — never the content, which carries
            # ID tokens and WiFi passwords. The size is what distinguishes a
            # truncated reassembly from genuine rubbish.
            log("RX: %d bytes in %d chunk(s) did not parse as JSON (%s)"
                % (len(raw), state["count"], exc))
            self.daemon.send_error(device, None, "BAD_REQUEST", "Malformed JSON")
            return
        self.daemon.on_message(device, obj)

    def forget(self, device):
        self._partial.pop(device, None)


# ──────────────────────────────────────────────────────────────────────────
# Advertisement and pairing agent
# ──────────────────────────────────────────────────────────────────────────


class Advertisement(dbus.service.Object):
    def __init__(self, bus, daemon, index=0):
        self.path = "%s/advertisement%d" % (BASE_PATH, index)
        self.daemon = daemon
        dbus.service.Object.__init__(self, bus, self.path)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def get_properties(self):
        return {
            LE_ADV_IFACE: {
                "Type": "peripheral",
                # §5.5: without this BlueZ inherits Adapter1.Discoverable,
                # which is false, and builds an AD flagged "not discoverable".
                # The controller transmits it and every scanner drops it — the
                # box looks perfectly healthy from here and is invisible.
                "Discoverable": dbus.Boolean(True),
                "ServiceUUIDs": dbus.Array([SERVICE_UUID], signature="s"),
                "LocalName": dbus.String(self.daemon.local_name),
                "ManufacturerData": dbus.Dictionary(
                    {
                        dbus.UInt16(COMPANY_ID): dbus.Array(
                            [dbus.Byte(b) for b in self.daemon.mfg_data()],
                            signature="y",
                        )
                    },
                    signature="qv",
                ),
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != LE_ADV_IFACE:
            raise InvalidArgs()
        return self.get_properties()[LE_ADV_IFACE]

    @dbus.service.method(LE_ADV_IFACE)
    def Release(self):
        # BlueZ releases the advertisement when it stops honouring it — on a
        # controller reset, for instance. The self-check puts it back.
        log("advertisement released by BlueZ")
        self.daemon.advertising = False


class PairingAgent(dbus.service.Object):
    """NoInputNoOutput — "Just Works" LE Secure Connections pairing (§5.4).

    The box has no display and no keypad, so there is nothing to compare and no
    defence against an active man-in-the-middle. What this buys is an ECDH-
    encrypted link, so a WiFi password cannot be read off the air by a passive
    listener. The grant signature (§7) is what stops a stranger issuing
    commands.
    """

    def __init__(self, bus):
        dbus.service.Object.__init__(self, bus, AGENT_PATH)

    @dbus.service.method(AGENT_IFACE, in_signature="", out_signature="")
    def Release(self):
        log("pairing agent released")

    @dbus.service.method(AGENT_IFACE, in_signature="o", out_signature="")
    def RequestAuthorization(self, device):
        log("pairing: authorising %s" % device)

    @dbus.service.method(AGENT_IFACE, in_signature="os", out_signature="")
    def AuthorizeService(self, device, uuid):
        # Only our own service. Anything else is a phone probing, and saying no
        # costs nothing.
        if uuid.lower() != SERVICE_UUID:
            raise Rejected("Not an onboarding service")

    @dbus.service.method(AGENT_IFACE, in_signature="ou", out_signature="")
    def RequestConfirmation(self, device, passkey):
        # Reached when the phone offers numeric comparison. With no display we
        # cannot show the number, so accepting is the only workable answer and
        # is what NoInputNoOutput implies anyway.
        log("pairing: confirming %s" % device)

    @dbus.service.method(AGENT_IFACE, in_signature="o", out_signature="s")
    def RequestPinCode(self, device):
        raise Rejected("No input on this device")

    @dbus.service.method(AGENT_IFACE, in_signature="o", out_signature="u")
    def RequestPasskey(self, device):
        raise Rejected("No input on this device")

    @dbus.service.method(AGENT_IFACE, in_signature="", out_signature="")
    def Cancel(self):
        log("pairing cancelled")


# ──────────────────────────────────────────────────────────────────────────
# The daemon
# ──────────────────────────────────────────────────────────────────────────


class BleDaemon:
    def __init__(self, socket_path, encrypted=True):
        self.socket_path = socket_path
        self.encrypted = encrypted
        self.bus = dbus.SystemBus()
        self.loop = GLib.MainLoop()

        self.adapter_path = None
        self.app = None
        self.service = None
        self.tx = None
        self.rx = None
        self.adv = None
        self.agent = None
        self.agent_registered = False
        self.advertising = False
        self._adv_reassert_failures = 0
        self._adv_blocked_while_connected = False
        self.gatt_registered = False

        # The ATT MTU of the current link, learned from the first write and
        # reset when the phone goes away. None until we have been told.
        self.att_mtu = None
        self.primary_mac = primary_mac()
        self.local_name = "DP-DuoCast-0000"
        self.address = ""
        self.state_bits = 0

        # device object path -> conn id. §4.3: conn is a fresh random id per
        # connection, never the phone's address, so nothing downstream can
        # accidentally key on a identifier that follows a person around.
        self.connections = {}

        self.sock = None
        self.sock_buf = b""
        self.sock_watch = None
        self.sock_retry = SOCKET_RETRY_MIN

    # ── identity ──────────────────────────────────────────────────────────

    def mfg_data(self):
        """The 4 manufacturer bytes from §5.2.

        shortId is taken from the primary MAC, NOT from the Bluetooth adapter's
        own address — those differ (the BT half of a combo card gets its own
        address), and the app matches this against the name on the box and
        against the MAC a grant is bound to.
        """
        short = short_id(self.primary_mac)
        return bytes([PROTO, self.state_bits & 0xFF, short & 0xFF, (short >> 8) & 0xFF])

    def _default_name(self):
        """DP-DuoCast-XXXX, computed here so the box is findable even before
        Node connects and sends the authoritative name."""
        mac = self.primary_mac
        if not mac:
            return BLE_NAME_PREFIX + "0000"
        return (BLE_NAME_PREFIX + mac.replace(":", "")[-4:].upper())[:20]

    # ── adapter ───────────────────────────────────────────────────────────

    def find_adapter(self):
        try:
            manager = dbus.Interface(self.bus.get_object(BLUEZ, "/"), DBUS_OM_IFACE)
            objects = manager.GetManagedObjects()
        except dbus.DBusException:
            return None
        for path, ifaces in objects.items():
            if GATT_MANAGER_IFACE in ifaces and LE_ADV_MANAGER_IFACE in ifaces:
                return path
        return None

    def adapter_props(self):
        return dbus.Interface(
            self.bus.get_object(BLUEZ, self.adapter_path), DBUS_PROP_IFACE
        )

    def setup_adapter(self):
        """Find a controller, power it on, and name it after the box."""
        self.adapter_path = self.find_adapter()
        if not self.adapter_path:
            return False

        props = self.adapter_props()
        self.address = str(props.Get(ADAPTER_IFACE, "Address"))
        if not props.Get(ADAPTER_IFACE, "Powered"):
            props.Set(ADAPTER_IFACE, "Powered", dbus.Boolean(True))

        # §5.1. Node pushes the authoritative name in its first `adv`; this is
        # what the box advertises until then, and on a box whose Node is down
        # it is what a phone keeps seeing. Both compute the same string.
        self.primary_mac = primary_mac() or self.primary_mac
        self.local_name = self._default_name()
        try:
            props.Set(ADAPTER_IFACE, "Alias", dbus.String(self.local_name))
        except dbus.DBusException as exc:
            log("could not set adapter alias: %s" % exc)

        # The box is a peripheral. Classic inquiry discoverability is a
        # different thing from LE advertising (§5.5) and stays off.
        try:
            props.Set(ADAPTER_IFACE, "Discoverable", dbus.Boolean(False))
            props.Set(ADAPTER_IFACE, "Pairable", dbus.Boolean(True))
        except dbus.DBusException:
            pass

        log("adapter %s (%s) as %s" % (self.adapter_path, self.address, self.local_name))
        return True

    # ── registration of our objects ───────────────────────────────────────

    def build_objects(self):
        if self.app is not None:
            return
        self.app = Application(self.bus)
        self.service = OnboardingService(self.bus)
        self.tx = TxCharacteristic(self.bus, 0, self.service, self, self.encrypted)
        self.rx = RxCharacteristic(self.bus, 1, self.service, self, self.encrypted)
        self.service.add_characteristic(self.tx)
        self.service.add_characteristic(self.rx)
        self.app.add_service(self.service)
        self.adv = Advertisement(self.bus, self)
        self.agent = PairingAgent(self.bus)

    def register_agent(self):
        if self.agent_registered:
            return
        try:
            manager = dbus.Interface(
                self.bus.get_object(BLUEZ, "/org/bluez"), AGENT_MANAGER_IFACE
            )
            manager.RegisterAgent(AGENT_PATH, "NoInputNoOutput")
            manager.RequestDefaultAgent(AGENT_PATH)
            self.agent_registered = True
            log("pairing agent registered (NoInputNoOutput)")
        except dbus.DBusException as exc:
            if "AlreadyExists" in str(exc):
                self.agent_registered = True
            else:
                log("agent registration failed: %s" % exc)

    def register_gatt(self):
        if self.gatt_registered:
            return
        manager = dbus.Interface(
            self.bus.get_object(BLUEZ, self.adapter_path), GATT_MANAGER_IFACE
        )

        def ok():
            self.gatt_registered = True
            log("GATT application registered")

        def failed(error):
            # A restart can race its own predecessor: the new process asks
            # before bluetoothd has finished releasing the old one's objects.
            # The registration we wanted exists, so this is success wearing an
            # error's clothes — and logging it as a failure is what makes
            # somebody at a venue think a working box is broken. The 60-second
            # self-check reads the controller's real state, so a flag set
            # wrongly here is corrected rather than believed forever.
            if "AlreadyExists" in str(error):
                self.gatt_registered = True
                log("GATT application was already registered (restart race)")
                return
            log("GATT registration failed: %s" % error)

        manager.RegisterApplication(
            self.app.get_path(), {}, reply_handler=ok, error_handler=failed
        )

    def register_advertisement(self, force=False):
        """Register the advertisement.

        `force` skips the "already advertising" guard, which a refresh must do.
        BlueZ reads the manufacturer data by calling GetAll on the
        advertisement object **at registration time**, so the payload on the
        air is whatever state_bits held at that instant — and a refresh that
        quietly no-ops leaves the old payload broadcasting forever while the
        log cheerfully reports the new one.
        """
        if self.advertising and not force:
            return
        # From here on we are registering: anything that checks the flag
        # meanwhile must not conclude there is nothing in flight.
        self.advertising = False
        manager = dbus.Interface(
            self.bus.get_object(BLUEZ, self.adapter_path), LE_ADV_MANAGER_IFACE
        )

        def ok():
            self.advertising = True
            log("advertising as %s, state bits 0x%02x" % (self.local_name, self.state_bits))

        def failed(error):
            if "AlreadyExists" in str(error):
                # NOT benign, unlike the GATT case. The advertisement that is
                # still registered carries the OLD manufacturer data, so
                # accepting this leaves the daemon believing it published state
                # bits that never went on the air — which is precisely what
                # happened on 2026-11-11: the box advertised `state none` while
                # its log said 0x06, so the app's badges were wrong and nobody
                # could tell from the box. Drop it and try once more.
                log("advertisement already registered with stale data — replacing it")
                self.advertising = False
                GLib.timeout_add(300, self._replace_advertisement)
                return
            self.advertising = False
            if self.connections:
                # Unambiguous: a register that fails while a link is up means
                # this controller cannot do both. Learn it from ONE failure.
                # Retrying is what broke service discovery — every attempt is
                # mgmt traffic during the window the phone is enumerating
                # services, and iOS gives up before we do.
                self._adv_blocked_while_connected = True
                log("cannot advertise while a phone is connected on this "
                    "controller — not retrying until it disconnects")
                self.send_to_node({"t": "caps", "advertisesWhileConnected": False})
                return
            log("advertisement registration failed: %s" % error)

        manager.RegisterAdvertisement(
            self.adv.get_path(), {}, reply_handler=ok, error_handler=failed
        )

    def unregister_advertisement(self, force=False):
        """Drop the advertisement.

        `force` unregisters even when the flag says we are not advertising.
        That case is real and was the bug: a registration dispatched but not
        yet acknowledged leaves advertising=False while BlueZ is already
        holding the object, so a guarded unregister did nothing, the following
        register found one in flight and did nothing either, and the box spent
        the rest of its life advertising the state bits it had at boot.
        """
        if not self.advertising and not force:
            return
        try:
            manager = dbus.Interface(
                self.bus.get_object(BLUEZ, self.adapter_path), LE_ADV_MANAGER_IFACE
            )
            manager.UnregisterAdvertisement(self.adv.get_path())
        except dbus.DBusException:
            pass
        self.advertising = False

    def active_instances(self):
        """How many advertisements the CONTROLLER actually has on air.

        `self.advertising` only records that BlueZ accepted the registration.
        It does not track what the hardware did next, and on these controllers
        those are different things: a connectable legacy advertisement is
        terminated by the controller the moment a connection completes, and
        nothing tells us. Reading this is the only way to know whether the box
        is really discoverable.
        """
        if not self.adapter_path:
            return 0
        try:
            props = dbus.Interface(
                self.bus.get_object(BLUEZ, self.adapter_path), DBUS_PROP_IFACE
            )
            return int(props.Get(LE_ADV_MANAGER_IFACE, "ActiveInstances"))
        except dbus.DBusException:
            return 0

    def reassert_advertising(self):
        """Put the advertisement back if the controller dropped it. One-shot."""
        if onboarding_mode() == "hotspot" or not self.adapter_path:
            return False
        if self.active_instances() > 0:
            return False
        if self._adv_reassert_failures >= 3:
            return False
        log("advertisement was dropped by the controller — putting it back")
        self.advertising = False          # or register_advertisement() no-ops
        try:
            manager = dbus.Interface(
                self.bus.get_object(BLUEZ, self.adapter_path), LE_ADV_MANAGER_IFACE
            )
            manager.UnregisterAdvertisement(self.adv.get_path())
        except dbus.DBusException:
            pass
        self.register_advertisement()
        GLib.timeout_add_seconds(2, self._check_reassert_worked)
        return False

    def _reassert_after_connect(self):
        """Replace the advertisement after a connection, no questions asked."""
        if onboarding_mode() == "hotspot" or not self.adapter_path:
            return False
        self._adv_reassert_failures = 0
        self.refresh_advertisement()
        return False

    def _check_reassert_worked(self):
        """Notice a controller that will not advertise while connected.

        Rather than retry forever and churn the radio, give up after three
        attempts and say so once. The box is still perfectly usable by the
        phone holding the link; it just is not discoverable until that one
        leaves, which is the behaviour this was trying to remove.
        """
        if self.active_instances() > 0:
            self._adv_reassert_failures = 0
            return False
        self._adv_reassert_failures += 1
        if self._adv_reassert_failures >= 3 and self.connections:
            self._adv_blocked_while_connected = True
            log("this controller cannot advertise while a phone is connected; "
                "the box is discoverable only when idle")
        return False

    def refresh_advertisement(self):
        """Re-register so the controller picks up changed manufacturer data.

        BlueZ has no "the properties changed, resend" call for an already
        registered advertisement, so replacing it is the only way to move the
        state bits (§5.2).

        The unregister and the register are deliberately NOT back to back.
        RegisterAdvertisement is asynchronous, and issuing it in the same
        iteration as the unregister lost the race often enough to matter: the
        register came back AlreadyExists, the old payload stayed on the air,
        and the box advertised stale state bits indefinitely. A short gap, and
        then a check that something is actually being broadcast.
        """
        if not self.adapter_path or onboarding_mode() == "hotspot":
            return
        self.unregister_advertisement(force=True)
        GLib.timeout_add(250, self._replace_advertisement)

    def _replace_advertisement(self):
        """Register the advertisement, then confirm the controller took it."""
        if onboarding_mode() == "hotspot" or not self.adapter_path:
            return False
        if self.connections and self._adv_blocked_while_connected:
            return False
        self.register_advertisement(force=True)
        GLib.timeout_add_seconds(2, self._verify_on_air)
        return False

    def _verify_on_air(self):
        """Believe the controller, not our own bookkeeping.

        `self.advertising` records that BlueZ accepted a call. This is the only
        thing that says a box is actually discoverable.
        """
        if onboarding_mode() == "hotspot" or not self.adapter_path:
            return False
        if self.connections and self._adv_blocked_while_connected:
            # Already know why nothing is on the air, and retrying is what
            # puts mgmt traffic through the window a phone spends enumerating
            # services. One attempt per daemon run is the whole budget.
            return False
        if self.active_instances() > 0:
            self._adv_reassert_failures = 0
            return False
        log("nothing is on the air after re-registering — retrying")
        self._adv_reassert_failures += 1
        if self._adv_reassert_failures < 3:
            self.advertising = False
            GLib.timeout_add(500, self._replace_advertisement)
        elif self.connections:
            # Not a fault — this controller simply cannot do both. Remember it,
            # so no later connection pays for rediscovering the fact. Retrying
            # mid-link is what broke service discovery on 85E4.
            self._adv_blocked_while_connected = True
            log("this controller cannot advertise while a phone is connected; "
                "the box is discoverable only when idle")
        else:
            log("could not get an advertisement on the air after 3 attempts")
        return False

    def drop_stale_connections(self):
        """Disconnect anything that was connected before we started.

        A GATT link survives this process dying, and an iPhone keeps one open
        even with the app in the background. So after a restart the controller
        can still be holding a link whose session — subscriptions, nonce,
        scope, everything — died with the previous process. That link is worse
        than no link: the phone cannot do anything with it, and because one
        phone at a time means we stop advertising (D8), nobody else can see the
        box either. The box looks dead to everyone until the idle kick fires,
        and the idle timer restarts every time Node does, so it may never fire.

        Dropping the link costs the phone a reconnect, which it is built to do.
        """
        try:
            manager = dbus.Interface(self.bus.get_object(BLUEZ, "/"), DBUS_OM_IFACE)
            objects = manager.GetManagedObjects()
        except dbus.DBusException:
            return

        for path, ifaces in objects.items():
            props = ifaces.get(DEVICE_IFACE)
            if not props or not props.get("Connected", False):
                continue
            if self.adapter_path and not path.startswith(str(self.adapter_path)):
                continue
            log("dropping a link left over from before this process started: %s" % path)
            self._disconnect_device(path)

    def bring_up(self):
        """Everything that has to be true for a phone to find us."""
        # `hotspot` means this box onboards through its WiFi AP and must not
        # advertise — a venue tablet may be living on that hotspot. `auto`
        # resolves to BLE exactly when a controller exists, which is what
        # covers boards with no radio.
        if onboarding_mode() == "hotspot":
            if self.advertising or self.gatt_registered:
                log("ONBOARDING_MODE=hotspot — standing down")
                self.unregister_advertisement()
            return False
        if not self.setup_adapter():
            return False
        self.build_objects()
        self.register_agent()
        self.register_gatt()
        if not self.connections:
            self.drop_stale_connections()
        # Always — a connected phone is no reason to be invisible to everyone
        # else. See _on_device_connected().
        self.register_advertisement()
        return True

    def tear_down(self):
        """Forget BlueZ-side registrations so bring_up() can redo them."""
        self.advertising = False
        self._adv_reassert_failures = 0
        self._adv_blocked_while_connected = False
        self.gatt_registered = False
        self.agent_registered = False
        self.adapter_path = None
        for device in list(self.connections):
            self._on_device_disconnected(device)

    # ── §5.3 staying connectable ──────────────────────────────────────────

    def watch_bluez(self):
        # bluetoothd restarting takes our GATT application and advertisement
        # with it, silently. Watching the bus name is the only way to notice.
        self.bus.add_signal_receiver(
            self._on_name_owner_changed,
            signal_name="NameOwnerChanged",
            dbus_interface="org.freedesktop.DBus",
            arg0=BLUEZ,
        )
        # The adapter itself can go away and come back — a USB reset, rfkill.
        self.bus.add_signal_receiver(
            self._on_interfaces_added,
            signal_name="InterfacesAdded",
            dbus_interface=DBUS_OM_IFACE,
        )
        self.bus.add_signal_receiver(
            self._on_interfaces_removed,
            signal_name="InterfacesRemoved",
            dbus_interface=DBUS_OM_IFACE,
        )
        # Connections are observed through Device1.Connected rather than
        # anything GATT-specific, because BlueZ has no per-application
        # connection signal.
        self.bus.add_signal_receiver(
            self._on_properties_changed,
            signal_name="PropertiesChanged",
            dbus_interface=DBUS_PROP_IFACE,
            path_keyword="path",
        )

    def _on_name_owner_changed(self, name, old, new):
        if name != BLUEZ:
            return
        if new:
            log("bluetoothd came back — re-registering")
            self.tear_down()
            GLib.timeout_add_seconds(1, lambda: (self.bring_up(), False)[1])
        else:
            log("bluetoothd went away")
            self.tear_down()

    def _on_interfaces_added(self, path, interfaces):
        if ADAPTER_IFACE in interfaces and not self.adapter_path:
            log("adapter appeared at %s" % path)
            GLib.timeout_add_seconds(1, lambda: (self.bring_up(), False)[1])

    def _on_interfaces_removed(self, path, interfaces):
        if ADAPTER_IFACE in interfaces and path == self.adapter_path:
            log("adapter removed")
            self.tear_down()

    def _on_properties_changed(self, interface, changed, invalidated, path=None):
        if interface != DEVICE_IFACE or "Connected" not in changed:
            return
        if changed["Connected"]:
            self._on_device_connected(path)
        else:
            self._on_device_disconnected(path)

    def self_check(self):
        """The thing that makes "always on" actually mean always on (§5.3).

        It also picks up a mode change: a box switched to `hotspot` stops
        advertising within a minute, and one switched back comes up again,
        without anybody needing root to restart this service.
        """
        if onboarding_mode() == "hotspot":
            if self.advertising:
                log("ONBOARDING_MODE=hotspot — standing down")
                self.unregister_advertisement()
            return True

        if not self.adapter_path:
            if self.bring_up():
                log("self-check: adapter recovered")
            return True

        try:
            powered = bool(self.adapter_props().Get(ADAPTER_IFACE, "Powered"))
        except dbus.DBusException:
            log("self-check: adapter unreachable, tearing down")
            self.tear_down()
            return True

        if not powered:
            log("self-check: adapter was off, powering on")
            try:
                self.adapter_props().Set(ADAPTER_IFACE, "Powered", dbus.Boolean(True))
            except dbus.DBusException:
                pass
            return True

        if not self.gatt_registered:
            log("self-check: GATT application missing, re-registering")
            self.register_gatt()

        if self.connections and self._adv_blocked_while_connected:
            # Known-incapable controller with a live link: leave it alone. This
            # branch used to re-register every 60 s regardless, which is how
            # churn survived the previous fix.
            return True

        if not self.advertising:
            log("self-check: advertisement missing, re-registering")
            self.register_advertisement()
        elif self.active_instances() == 0 and not (
            self.connections and self._adv_blocked_while_connected
        ):
            # We believe we are advertising and the controller disagrees. This
            # is the state a connection leaves behind, and the box is invisible
            # until it is fixed — except on a controller already known to
            # refuse while connected, where retrying every 60 s would disturb
            # a live link for nothing.
            self.reassert_advertising()

        return True

    # ── connections ───────────────────────────────────────────────────────

    def _new_conn_id(self):
        alphabet = string.ascii_lowercase + string.digits
        return "".join(random.choice(alphabet) for _ in range(12))

    def _on_device_connected(self, device):
        if device in self.connections:
            return
        # D8: one phone at a time. A second phone is disconnected rather than
        # queued — BlueZ notifies every subscriber, so serving two would mean
        # routing each reply to the right one, and a setup flow never needs it.
        if self.connections:
            # It still SEES the box, because we keep advertising; it just
            # cannot take the session out from under whoever holds it.
            log("second phone at %s — disconnecting it (D8)" % device)
            self._disconnect_device(device)
            return

        conn = self._new_conn_id()
        self.connections[device] = conn
        log("phone connected (%s)" % conn)
        # Keep advertising. D8 is about serving one SESSION at a time, which
        # is a notification-routing problem; it was never a reason to become
        # invisible. Stopping meant the box vanished from every scanner the
        # moment anyone connected — including from the app's own "nearby boxes"
        # screen while that same app held the link, so an owner who had just
        # finished setting a camera up was told there were none nearby.
        #
        # The controller terminates a connectable advertisement when the
        # connection completes, so registering here is not enough: replace it
        # once the link has settled.
        #
        # Unconditionally, NOT "only if ActiveInstances says it is gone". That
        # check was the bug: on this controller ActiveInstances keeps reading 1
        # after the radio has stopped broadcasting, so the repair never fired
        # and the box went silently undiscoverable the moment a phone
        # connected — which is the exact failure this code exists to prevent.
        # Re-registering something that was in fact still fine costs
        # milliseconds; trusting BlueZ's bookkeeping costs the box.
        GLib.timeout_add(1500, self._reassert_after_connect)
        self.send_to_node({"t": "connect", "conn": conn})

    def _on_device_disconnected(self, device):
        conn = self.connections.pop(device, None)
        if conn is None:
            return
        log("phone disconnected (%s)" % conn)
        if self.rx:
            self.rx.forget(device)
        # The next phone negotiates its own.
        self.att_mtu = None
        if self.tx:
            self.tx.notifying = False
            self.tx._queue = []
        self.send_to_node({"t": "disconnect", "conn": conn})
        if not self.connections:
            # Deliberately NOT clearing _adv_blocked_while_connected: it
            # describes the controller, which does not change between
            # connections. Clearing it meant re-learning on every connect, at
            # the cost of a failed registration during each link setup.
            self._adv_reassert_failures = 0
            self.register_advertisement()
        GLib.timeout_add_seconds(2, self._prune_bonds_once)

    def _disconnect_device(self, device):
        try:
            dbus.Interface(
                self.bus.get_object(BLUEZ, device), DEVICE_IFACE
            ).Disconnect()
        except dbus.DBusException as exc:
            log("could not disconnect %s: %s" % (device, exc))

    def _device_for_conn(self, conn):
        for device, value in self.connections.items():
            if value == conn:
                return device
        return None

    def _prune_bonds_once(self):
        """Keep /var/lib/bluetooth from growing without bound (§5.4)."""
        try:
            manager = dbus.Interface(self.bus.get_object(BLUEZ, "/"), DBUS_OM_IFACE)
            objects = manager.GetManagedObjects()
        except dbus.DBusException:
            return False

        bonded = [
            path
            for path, ifaces in objects.items()
            if DEVICE_IFACE in ifaces
            and path.startswith(str(self.adapter_path or ""))
            and ifaces[DEVICE_IFACE].get("Paired", False)
            and not ifaces[DEVICE_IFACE].get("Connected", False)
        ]
        if len(bonded) <= MAX_BONDS:
            return False

        # BlueZ gives no last-seen for a bond, so "oldest" is approximated by
        # object path order, which is stable. Removing a bond is not
        # destructive: JustWorksRepairing=always lets that phone pair again.
        adapter = dbus.Interface(
            self.bus.get_object(BLUEZ, self.adapter_path), ADAPTER_IFACE
        )
        for path in sorted(bonded)[: len(bonded) - MAX_BONDS]:
            try:
                adapter.RemoveDevice(path)
                log("pruned old bond %s" % path)
            except dbus.DBusException:
                pass
        return False

    # ── the socket to Node ────────────────────────────────────────────────

    def connect_socket(self):
        if self.sock is not None:
            return True
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.connect(self.socket_path)
            sock.setblocking(False)
        except (OSError, socket.error) as exc:
            if exc.errno not in (errno.ENOENT, errno.ECONNREFUSED):
                log("socket connect failed: %s" % exc)
            self._schedule_socket_retry()
            return False

        self.sock = sock
        self.sock_buf = b""
        self.sock_retry = SOCKET_RETRY_MIN
        self.sock_watch = GLib.io_add_watch(
            sock.fileno(),
            GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR,
            self._on_socket_readable,
        )
        log("connected to Node at %s" % self.socket_path)
        self.send_to_node(
            {
                "t": "hello",
                "proto": PROTO,
                "adapter": (self.adapter_path or "").split("/")[-1],
                "address": self.address,
                # Whether this controller can advertise while a phone is
                # connected. The app needs it to decide whether holding the
                # link while the web UI is open is free (N100) or makes the
                # box invisible to everyone (N97).
                "advertisesWhileConnected": not self._adv_blocked_while_connected,
            }
        )
        # Any phone still connected at this point reconnected after Node did,
        # so tell Node about it.
        for conn in self.connections.values():
            self.send_to_node({"t": "connect", "conn": conn})
        return True

    def _schedule_socket_retry(self):
        delay = self.sock_retry
        self.sock_retry = min(self.sock_retry * 2, SOCKET_RETRY_MAX)
        GLib.timeout_add(int(delay * 1000), lambda: (self.connect_socket(), False)[1])

    def _drop_socket(self):
        if self.sock_watch is not None:
            GLib.source_remove(self.sock_watch)
            self.sock_watch = None
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock = None
        self.sock_buf = b""
        log("Node went away — answering UNAVAILABLE until it is back")
        # Node holds the per-connection session state, so a phone connected
        # right now has just lost everything that made its link useful. Keeping
        # it would also keep us from advertising (D8), so the box would be
        # invisible to every phone including that one. Let it go and advertise
        # again; the app reconnects once Node is back.
        for device in list(self.connections):
            log("releasing the connection slot because Node restarted")
            self._disconnect_device(device)
            self._on_device_disconnected(device)
        self._schedule_socket_retry()

    def _on_socket_readable(self, fd, condition):
        if condition & (GLib.IO_HUP | GLib.IO_ERR):
            self._drop_socket()
            return False
        try:
            data = self.sock.recv(65536)
        except BlockingIOError:
            return True
        except OSError:
            self._drop_socket()
            return False
        if not data:
            self._drop_socket()
            return False

        self.sock_buf += data
        while b"\n" in self.sock_buf:
            line, self.sock_buf = self.sock_buf.split(b"\n", 1)
            if not line.strip():
                continue
            try:
                self.on_node_message(json.loads(line.decode("utf-8")))
            except Exception as exc:
                log("bad line from Node: %s" % exc)
        return True

    def send_to_node(self, obj):
        if self.sock is None:
            return False
        try:
            self.sock.sendall((json.dumps(obj, separators=(",", ":")) + "\n").encode())
            return True
        except OSError:
            self._drop_socket()
            return False

    def on_node_message(self, msg):
        kind = msg.get("t")
        if kind == "send":
            conn = msg.get("conn")
            # A reply for a connection that has since gone is not an error —
            # the phone dropped while Node was working on it.
            if conn and self._device_for_conn(conn) is None:
                return
            if self.tx:
                self.tx.send(msg.get("data", {}))
        elif kind == "adv":
            state = msg.get("state", {})
            bits = int(state.get("bits", 0)) & 0xFF
            name = state.get("name")
            changed = bits != self.state_bits
            if name and name[:20] != self.local_name:
                self.local_name = name[:20]
                changed = True
                try:
                    self.adapter_props().Set(
                        ADAPTER_IFACE, "Alias", dbus.String(self.local_name)
                    )
                except dbus.DBusException:
                    pass
            self.state_bits = bits
            if changed and not self.connections:
                self.refresh_advertisement()
        elif kind == "kick":
            device = self._device_for_conn(msg.get("conn"))
            if device:
                log("Node asked to disconnect %s" % msg.get("conn"))
                self._disconnect_device(device)
        else:
            log("unknown message from Node: %r" % kind)

    # ── messages ──────────────────────────────────────────────────────────

    def on_message(self, device, obj):
        conn = self.connections.get(device)
        if conn is None:
            # A write from a device we never saw connect. Treat it as a
            # connection so nothing is silently dropped.
            self._on_device_connected(device)
            conn = self.connections.get(device)
            if conn is None:
                return
        if self.sock is None:
            self.send_error(
                device, obj.get("id"), "UNAVAILABLE", "The camera service is starting"
            )
            return
        self.send_to_node({"t": "msg", "conn": conn, "data": obj})

    def report_notify(self, subscribed):
        """Tell Node whether the phone is subscribed to notifications."""
        if not self.connections:
            return
        # One connection at a time (D8), so there is no ambiguity about whose.
        conn = next(iter(self.connections.values()))
        self.send_to_node({"t": "notify", "conn": conn, "on": bool(subscribed)})

    def send_error(self, device, msg_id, code, message):
        """Answer the phone directly, without Node. Only for UNAVAILABLE and
        malformed input — everything else is Node's to decide."""
        if not self.tx:
            return
        payload = {"ok": False, "error": {"code": code, "message": message}}
        if msg_id is not None:
            payload["id"] = msg_id
        self.tx.send(payload)

    # ── main ──────────────────────────────────────────────────────────────

    def run(self):
        self.watch_bluez()
        if not self.bring_up():
            log("no Bluetooth controller yet — waiting for one to appear")
        self.connect_socket()
        GLib.timeout_add_seconds(SELF_CHECK_SECONDS, self.self_check)
        try:
            self.loop.run()
        except KeyboardInterrupt:
            pass
        finally:
            self.unregister_advertisement()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", default=SOCKET_PATH, help="path to Node's socket")
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="drop the encryption requirement on RX/TX. Bench use only: it "
             "lets a generic BLE tool talk to the box without pairing, and it "
             "puts WiFi passwords on the air in the clear.",
    )
    args = parser.parse_args()

    if args.insecure:
        log("!!! --insecure: characteristics are unencrypted. Never on a shipped box.")

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    BleDaemon(args.socket, encrypted=not args.insecure).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
