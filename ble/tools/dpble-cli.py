#!/usr/bin/env python3
"""dpble-cli.py — talk to a camera's BLE onboarding service from a laptop.

Exists so the device protocol can be exercised without waiting for the mobile
app, and so a failure can be narrowed to one side or the other. Speaks the real
§6.2 framing and the real §6.3 envelope, so whatever works here should work
from the app.

    pip install bleak

    ./dpble-cli.py scan                        # cameras in range, decoded
    ./dpble-cli.py info --name dp-stream-b1b5
    ./dpble-cli.py net-status --name dp-stream-b1b5
    ./dpble-cli.py wifi-scan --name dp-stream-b1b5
    ./dpble-cli.py raw --cmd info --args '{}'  # anything not wrapped yet
    ./dpble-cli.py echo                        # ble-smoketest.py only

With one camera in range the --name is optional.

macOS: the first run needs Bluetooth permission for whichever terminal runs it.
Until that is granted, scans come back empty rather than failing, and a process
with no way to show the prompt (an editor's integrated task runner, say) can
hang instead. Run it from Terminal.app once to get the prompt.
"""

import argparse
import asyncio
import json
import sys

from bleak import BleakClient, BleakScanner

# BLUETOOTH_ONBOARDING.md §6.1
SERVICE_UUID = "3f8abaa2-7312-4a07-be35-7c7f1618bb6a"
RX_UUID = "b81717c7-da32-444b-804d-5dbe7e7d756c"
TX_UUID = "ea362436-362f-4ceb-8211-f6db458206a3"

COMPANY_ID = 0xFFFF
CHUNK_HEADER = 3

# §5.2
STATE_BITS = [
    (0, "registered"),
    (1, "internet"),
    (2, "wifi-configured"),
    (3, "recovery-window"),
    (4, "hotspot-up"),
]


def describe_mfg(data: bytes) -> str:
    if len(data) < 4:
        return "malformed (%d bytes)" % len(data)
    proto, state, lo, hi = data[0], data[1], data[2], data[3]
    flags = [name for bit, name in STATE_BITS if state & (1 << bit)] or ["none"]
    return "proto %d, shortId %04x, state %s" % (proto, lo | (hi << 8), ",".join(flags))


# ── discovery ─────────────────────────────────────────────────────────────


async def discover(timeout: float):
    found = {}

    def callback(device, adv):
        uuids = [u.lower() for u in (adv.service_uuids or [])]
        if SERVICE_UUID in uuids:
            found[device.address] = (device, adv)

    scanner = BleakScanner(detection_callback=callback)
    await scanner.start()
    await asyncio.sleep(timeout)
    await scanner.stop()
    return sorted(found.values(), key=lambda p: p[1].rssi or -999, reverse=True)


async def resolve(args):
    results = await discover(args.timeout)
    if args.address:
        for device, _ in results:
            if device.address.lower() == args.address.lower():
                return device
        print("No camera at %s" % args.address, file=sys.stderr)
        return None
    if args.name:
        for device, _ in results:
            if (device.name or "").lower() == args.name.lower():
                return device
        print("No camera named %r in range" % args.name, file=sys.stderr)
        return None
    if not results:
        print("No cameras in range", file=sys.stderr)
        return None
    if len(results) > 1:
        print("More than one camera in range; pass --name", file=sys.stderr)
        for device, _ in results:
            print("  %s  %s" % (device.name, device.address), file=sys.stderr)
        return None
    return results[0][0]


# ── the transport ─────────────────────────────────────────────────────────


class Session:
    """One BLE connection, with §6.2 chunking in both directions."""

    def __init__(self, client, verbose=False):
        self.client = client
        self.verbose = verbose
        self._next_id = 1
        self._next_msg_id = 0
        self._partial = None          # {"id":, "count":, "parts":{}}
        self._pending = {}            # request id -> Future
        self._events = asyncio.Queue()

    # MTU less the 3-byte ATT header less our 3-byte chunk header.
    def _body_size(self):
        mtu = getattr(self.client, "mtu_size", None) or 23
        return max(1, mtu - 3 - CHUNK_HEADER)

    async def start(self):
        await self.client.start_notify(TX_UUID, self._on_notify)

    def _on_notify(self, _handle, data):
        data = bytes(data)
        if len(data) < CHUNK_HEADER:
            return
        msg_id, index, count = data[0], data[1], data[2]
        piece = data[CHUNK_HEADER:]

        if self._partial is None or self._partial["id"] != msg_id:
            self._partial = {"id": msg_id, "count": count, "parts": {}}
        self._partial["parts"][index] = piece

        if len(self._partial["parts"]) < self._partial["count"]:
            return

        raw = b"".join(self._partial["parts"][i] for i in range(self._partial["count"]))
        self._partial = None
        try:
            msg = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            print("Bad message from the camera: %s" % exc, file=sys.stderr)
            return

        if self.verbose:
            print("  <- %s" % json.dumps(msg)[:400])

        if "event" in msg:
            self._events.put_nowait(msg)
            return
        future = self._pending.pop(msg.get("id"), None)
        if future and not future.done():
            future.set_result(msg)

    async def request(self, cmd, args=None, timeout=30.0):
        request_id = self._next_id
        self._next_id += 1
        payload = {"id": request_id, "cmd": cmd}
        if args:
            payload["args"] = args

        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future

        raw = json.dumps(payload, separators=(",", ":")).encode()
        body = self._body_size()
        count = max(1, (len(raw) + body - 1) // body)
        msg_id = self._next_msg_id
        self._next_msg_id = (self._next_msg_id + 1) % 256

        if self.verbose:
            print("  -> %s  (%d byte%s, %d chunk%s)"
                  % (json.dumps(payload), len(raw), "" if len(raw) == 1 else "s",
                     count, "" if count == 1 else "s"))

        for index in range(count):
            chunk = bytes([msg_id, index, count]) + raw[index * body:(index + 1) * body]
            await self.client.write_gatt_char(RX_UUID, chunk, response=True)

        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(request_id, None)
            raise

    async def events(self, timeout):
        """Drain events for `timeout` seconds, yielding each as it lands."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                return
            try:
                yield await asyncio.wait_for(self._events.get(), timeout=remaining)
            except asyncio.TimeoutError:
                return


async def with_session(args, body):
    device = await resolve(args)
    if device is None:
        return 1
    print("Connecting to %s (%s)..." % (device.name, device.address))
    async with BleakClient(device) as client:
        session = Session(client, verbose=args.verbose)
        await session.start()
        print("Connected, MTU %s\n" % (getattr(client, "mtu_size", "?")))
        return await body(session)


def show(response):
    """Print one §6.3 response, and say so loudly when it is an error."""
    if response.get("ok"):
        print(json.dumps(response.get("result", {}), indent=2, sort_keys=True))
        return 0
    error = response.get("error", {})
    print("%s: %s" % (error.get("code", "?"), error.get("message", "")), file=sys.stderr)
    return 1


# ── commands ──────────────────────────────────────────────────────────────


async def cmd_scan(args):
    print("Scanning %ss for cameras..." % args.timeout)
    results = await discover(args.timeout)
    if not results:
        print("\nNothing found.")
        print("  - is digitalpool-ble.service running on the box?")
        print("  - on macOS, has this terminal been granted Bluetooth permission?")
        return 1
    print("")
    for device, adv in results:
        mfg = (adv.manufacturer_data or {}).get(COMPANY_ID, b"")
        print("  %-24s rssi %4s  %s" % (device.name or "(no name)", adv.rssi, device.address))
        print("  %-24s %s" % ("", describe_mfg(bytes(mfg))))
    return 0


def simple(cmd):
    async def run(args):
        return await with_session(args, lambda s: s.request(cmd).__await__().__next__()
                                  if False else _ask(s, cmd))
    return run


async def _ask(session, cmd, cmd_args=None):
    return show(await session.request(cmd, cmd_args))


async def cmd_info(args):
    return await with_session(args, lambda s: _ask(s, "info"))


async def cmd_net_status(args):
    return await with_session(args, lambda s: _ask(s, "net.status"))


async def cmd_wifi_scan(args):
    async def body(session):
        response = await session.request("wifi.scan", timeout=45)
        if not response.get("ok"):
            return show(response)
        result = response["result"]
        networks = result.get("networks", [])
        print("%d network%s%s\n"
              % (len(networks), "" if len(networks) == 1 else "s",
                 " (cached)" if result.get("cached") else ""))
        if not networks and result.get("reason"):
            print("  %s: %s\n" % (result["reason"], result.get("message", "")))
        for network in networks:
            print("  %-32s %3s%%  %-12s%s"
                  % (network.get("ssid", ""), network.get("signal", "?"),
                     network.get("security") or "open",
                     "  <- connected" if network.get("connected") else ""))
        return 0
    return await with_session(args, body)


async def cmd_wifi_connect(args):
    """Join a network, then follow the progress events to a final stage."""
    async def body(session):
        cmd_args = {"ssid": args.ssid}
        if args.psk:
            cmd_args["psk"] = args.psk
        if args.hidden:
            cmd_args["hidden"] = True

        response = await session.request("wifi.connect", cmd_args)
        if not response.get("ok"):
            return show(response)
        print("Accepted. Watching progress (final stage is 'online' or 'failed')...\n")

        # The box has up to 45 s inside nmcli plus a scan beforehand; the app
        # uses 75 s, so use the same budget here.
        async for event in session.events(75):
            if event.get("event") != "wifi.progress":
                continue
            data = event.get("data", {})
            stage = data.get("stage")
            if stage == "failed":
                print("  failed: %s — %s"
                      % (data.get("code", "?"), data.get("message", "")), file=sys.stderr)
                return 1
            if stage == "online":
                print("  online%s"
                      % ("" if data.get("internet") else "  (joined, but no internet)"))
                return 0
            print("  %s" % stage)
        print("  no final stage within 75s", file=sys.stderr)
        return 1
    return await with_session(args, body)


async def cmd_wifi_saved(args):
    return await with_session(args, lambda s: _ask(s, "wifi.saved"))


async def cmd_wifi_disconnect(args):
    return await with_session(args, lambda s: _ask(s, "wifi.disconnect"))


async def cmd_wifi_forget(args):
    return await with_session(args, lambda s: _ask(s, "wifi.forget", {"ssid": args.ssid}))


async def cmd_web_link(args):
    """Ask for a one-time login link and print the URLs."""
    async def body(session):
        response = await session.request("web.link")
        if not response.get("ok"):
            return show(response)
        result = response["result"]
        print("valid for %ss, once\n" % result.get("expiresIn"))
        for entry in result.get("urls", []):
            print("  %-8s %s" % (entry.get("kind"), entry.get("url")))
        return 0
    return await with_session(args, body)


async def cmd_register(args):
    """Register the camera using a Firebase ID token, following the events."""
    async def body(session):
        response = await session.request("register.start", {"idToken": args.token})
        if not response.get("ok"):
            return show(response)
        print("Accepted. Watching progress...\n")
        async for event in session.events(180):
            if event.get("event") != "register.progress":
                continue
            data = event.get("data", {})
            stage = data.get("stage")
            if stage == "failed":
                print("  failed: %s — %s"
                      % (data.get("code", "?"), data.get("message", "")), file=sys.stderr)
                return 1
            if stage == "registered":
                print("  registered to %s" % json.dumps(data.get("venue", {})))
                return 0
            if stage == "chooseVenue":
                print("  choose a venue: %s" % json.dumps(data.get("venues", [])))
                return 0
            if stage == "needVenue":
                print("  the account has no venue")
                return 0
            print("  %s" % stage)
        print("  no final stage within 180s", file=sys.stderr)
        return 1
    return await with_session(args, body)


async def cmd_register_status(args):
    return await with_session(args, lambda s: _ask(s, "register.status"))


async def cmd_raw(args):
    try:
        cmd_args = json.loads(args.args) if args.args else None
    except ValueError as exc:
        print("--args is not JSON: %s" % exc, file=sys.stderr)
        return 1

    async def body(session):
        result = show(await session.request(args.cmd, cmd_args))
        if args.watch:
            print("\nWatching for events for %ss..." % args.watch)
            async for event in session.events(args.watch):
                print("  %s %s" % (event.get("event"), json.dumps(event.get("data", {}))))
        return result
    return await with_session(args, body)


async def cmd_echo(args):
    """The M0 smoke test: pairs with ble/tools/ble-smoketest.py, not dp-ble.py."""
    device = await resolve(args)
    if device is None:
        return 1
    print("Connecting to %s (%s)..." % (device.name, device.address))
    replies = asyncio.Queue()
    async with BleakClient(device) as client:
        await client.start_notify(TX_UUID, lambda _h, d: replies.put_nowait(bytes(d)))
        payload = args.message.encode()
        await client.write_gatt_char(RX_UUID, payload, response=True)
        print("Wrote %r" % payload)
        try:
            reply = await asyncio.wait_for(replies.get(), timeout=5)
        except asyncio.TimeoutError:
            print("No notification came back within 5s", file=sys.stderr)
            return 1
        print("Got back %r" % reply)
        return 0 if reply == b"echo:" + payload else 1


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--timeout", type=float, default=6.0, help="scan seconds")
    parser.add_argument("--name", help="camera's BLE local name")
    parser.add_argument("--address", help="BLE address (a UUID on macOS)")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="print every message sent and received")
    # dest is "action", not "cmd": `raw --cmd web.link` would otherwise
    # overwrite the subcommand name with the command being sent.
    sub = parser.add_subparsers(dest="action", required=True)

    sub.add_parser("scan", help="list cameras advertising the onboarding service")
    sub.add_parser("info", help="what the camera is and whether it is registered")
    sub.add_parser("net-status", help="ethernet, wifi, hotspot and internet")
    sub.add_parser("wifi-scan", help="networks the camera can see")

    connect = sub.add_parser("wifi-connect", help="join a network")
    connect.add_argument("--ssid", required=True)
    connect.add_argument("--psk", help="omit for an open network")
    connect.add_argument("--hidden", action="store_true",
                         help="the network does not broadcast its SSID")

    sub.add_parser("wifi-saved", help="networks the camera already knows")
    sub.add_parser("wifi-disconnect", help="leave the current network, keep it saved")

    forget = sub.add_parser("wifi-forget", help="delete a saved network")
    forget.add_argument("--ssid", required=True)

    sub.add_parser("web-link", help="one-time link that opens the web UI logged in")

    register = sub.add_parser("register", help="register with a Firebase ID token")
    register.add_argument("--token", required=True, help="the signed-in user's ID token")

    sub.add_parser("register-status", help="how the last registration attempt ended")

    raw = sub.add_parser("raw", help="send any command")
    raw.add_argument("--cmd", required=True)
    raw.add_argument("--args", help="JSON object")
    raw.add_argument("--watch", type=float, default=0,
                     help="after the reply, print events for this many seconds")

    echo = sub.add_parser("echo", help="round-trip against ble-smoketest.py")
    echo.add_argument("--message", default="hello from dpble-cli")

    args = parser.parse_args()
    handler = {
        "scan": cmd_scan,
        "info": cmd_info,
        "net-status": cmd_net_status,
        "wifi-scan": cmd_wifi_scan,
        "wifi-connect": cmd_wifi_connect,
        "wifi-saved": cmd_wifi_saved,
        "wifi-disconnect": cmd_wifi_disconnect,
        "wifi-forget": cmd_wifi_forget,
        "raw": cmd_raw,
        "echo": cmd_echo,
        "web-link": cmd_web_link,
        "register": cmd_register,
        "register-status": cmd_register_status,
    }[args.action]
    return asyncio.run(handler(args))


if __name__ == "__main__":
    sys.exit(main())
