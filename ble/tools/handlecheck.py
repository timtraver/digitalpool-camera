#!/usr/bin/env python3
"""handlecheck.py — assert the box's GATT attribute table is VALID.

Not that the handles are stable — that they are legal: unique, strictly
ascending, and with every characteristic inside its service's range.

This exists because of 2026-11-11. ATT handles move on every daemon restart,
which breaks bonded iOS clients (§6.9), so the service and characteristics were
given fixed `Handle` properties. BlueZ honoured it on the service, ignored it
on the characteristics, and placed the first characteristic's value at the
service's own handle. The resulting table had duplicate handles.

BlueZ tolerated it. bleak on Linux parsed it happily. Three restarts produced
three identical readings, which looked like proof and proved the wrong thing.
Apple did not tolerate it: CoreBluetooth resolved the duplicated handle to the
service, and the iOS app died inside its discovery callback.

So: run this from a CoreBluetooth client (a Mac) whenever anything touches the
GATT layout. A Linux central cannot see this class of bug.

    python3 ble/tools/handlecheck.py DP-DuoCast-B1B5

Exits non-zero if the table is invalid.
"""
import asyncio, sys, importlib.util
spec = importlib.util.spec_from_file_location("cli", "/home/dp/digitalpool-camera/ble/tools/dpble-cli.py")
cli = importlib.util.module_from_spec(spec); spec.loader.exec_module(cli)
from bleak import BleakClient
SERVICE = "3f8abaa2-7312-4a07-be35-7c7f1618bb6a"

async def main():
    target = sys.argv[1]
    res = await cli.discover(10.0)
    dev = next((d for d, _ in res if (d.name or "") == target), None)
    if not dev: print("not found:", target); return 1
    async with BleakClient(dev) as c:
        rows = []
        for svc in c.services:
            if svc.uuid.lower() != SERVICE: continue
            rows.append(("service", svc.handle, svc.uuid))
            for ch in svc.characteristics:
                rows.append(("  char ", ch.handle, ch.uuid + "  " + ",".join(ch.properties)))
                for d in ch.descriptors:
                    rows.append(("  desc ", d.handle, d.uuid))
        if not rows:
            print("our service not found"); return 1
        print("%s attribute table:" % target)
        for kind, h, what in rows:
            print("  %s 0x%04x  %s" % (kind, h, what))
        handles = [h for _, h, _ in rows]
        dupes = len(handles) != len(set(handles))
        ascending = handles == sorted(handles)
        svc_h = rows[0][1]
        inside = all(h > svc_h for _, h, _ in rows[1:])
        print("\n  unique handles : %s" % ("NO — DUPLICATES" if dupes else "yes"))
        print("  ascending      : %s" % ("yes" if ascending else "NO"))
        print("  all inside svc : %s" % ("yes" if inside else "NO"))
        print("\n  %s" % ("VALID" if (not dupes and ascending and inside) else "*** INVALID ***"))
        return 0 if (not dupes and ascending and inside) else 1
sys.exit(asyncio.run(main()))
