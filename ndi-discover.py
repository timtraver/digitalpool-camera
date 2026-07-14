#!/usr/bin/env python3
"""
ndi-discover.py — Enumerate NDI sources visible on the local network.

Uses the NDI SDK (libndi.so.6) via ctypes.  Waits up to <timeout_ms>
milliseconds for mDNS/UDP discovery announcements, then prints a JSON
array of objects to stdout:

    [{"name": "DESKTOP-ABC (OBS)", "url": "192.168.1.10:5960"}, ...]

Usage:
    python3 ndi-discover.py [timeout_ms] [extra_ips]   # default: 5000, ""

`extra_ips` is an optional comma-separated list of IP addresses (or subnet
addresses) to query directly via NDI unicast discovery.  This bypasses mDNS
multicast entirely — essential on multi-homed devices (wired LAN + AP hotspot
+ VPN) where the SDK's multicast discovery goes out the wrong interface and
never reaches a source on the LAN.  Example:

    python3 ndi-discover.py 5000 192.168.1.20,192.168.1.21
"""

import ctypes
import json
import os
import sys

# Search for the NDI runtime library in the locations used by each platform:
#   /usr/local/lib/libndi.so.6          — ARM64 (Rockchip RK3588, Orange Pi 5)
#   /usr/lib/x86_64-linux-gnu/libndi.so.6 — Intel x86_64 (GMKtec G5 N97, etc.)
_NDI_LIB_CANDIDATES = [
    "/usr/local/lib/libndi.so.6",
    "/usr/lib/x86_64-linux-gnu/libndi.so.6",
    "/usr/lib/aarch64-linux-gnu/libndi.so.6",
]
NDI_LIB_PATH = next((p for p in _NDI_LIB_CANDIDATES if os.path.exists(p)), _NDI_LIB_CANDIDATES[0])


class _NDIlib_source_t(ctypes.Structure):
    _fields_ = [
        ("p_ndi_name",    ctypes.c_char_p),
        ("p_url_address", ctypes.c_char_p),
    ]


class _NDIlib_find_create_t(ctypes.Structure):
    _fields_ = [
        ("show_local_sources", ctypes.c_bool),
        ("p_groups",           ctypes.c_char_p),
        ("p_extra_ips",        ctypes.c_char_p),
    ]


def discover(timeout_ms: int = 5000, extra_ips: str = "") -> list:
    # ── Load library ──────────────────────────────────────────────────────────
    try:
        ndi = ctypes.CDLL(NDI_LIB_PATH)
    except OSError as exc:
        return [{"error": f"Cannot load NDI library: {exc}"}]

    # ── Initialise ────────────────────────────────────────────────────────────
    ndi.NDIlib_initialize.restype  = ctypes.c_bool
    ndi.NDIlib_initialize.argtypes = []
    if not ndi.NDIlib_initialize():
        return [{"error": "NDIlib_initialize() returned false"}]

    # ── Create finder ─────────────────────────────────────────────────────────
    # NDI SDK versions export different symbol names for the finder constructor.
    # libndi.so.6 (as installed on this system) exports NDIlib_find_create_v2
    # and NDIlib_find_create but NOT v3.  Probe in descending preference so the
    # script also works on other SDK versions without changes.
    create_fn = None
    for sym in ("NDIlib_find_create_v2", "NDIlib_find_create"):
        try:
            fn = getattr(ndi, sym)
            fn.restype  = ctypes.c_void_p
            fn.argtypes = [ctypes.POINTER(_NDIlib_find_create_t)]
            create_fn   = fn
            break
        except (AttributeError, OSError):
            continue

    if create_fn is None:
        ndi.NDIlib_destroy()
        return [{"error": "No NDIlib_find_create symbol found in NDI library"}]

    # When extra_ips is supplied, query those addresses directly via unicast
    # discovery.  Keep the encoded bytes in a local so ctypes doesn't free the
    # buffer before NDIlib_find_create reads it.
    extra_ips_b = extra_ips.encode("utf-8") if extra_ips else None
    settings = _NDIlib_find_create_t(
        show_local_sources=True,
        p_groups=None,
        p_extra_ips=extra_ips_b,
    )
    finder = create_fn(ctypes.byref(settings))
    if not finder:
        ndi.NDIlib_destroy()
        return [{"error": "NDIlib_find_create() returned NULL"}]

    # ── Wait for sources ──────────────────────────────────────────────────────
    ndi.NDIlib_find_wait_for_sources.restype  = ctypes.c_bool
    ndi.NDIlib_find_wait_for_sources.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    ndi.NDIlib_find_wait_for_sources(ctypes.c_void_p(finder), ctypes.c_uint32(timeout_ms))

    # ── Retrieve sources ──────────────────────────────────────────────────────
    ndi.NDIlib_find_get_current_sources.restype  = ctypes.POINTER(_NDIlib_source_t)
    ndi.NDIlib_find_get_current_sources.argtypes = [ctypes.c_void_p,
                                                     ctypes.POINTER(ctypes.c_uint32)]
    count = ctypes.c_uint32(0)
    sources_ptr = ndi.NDIlib_find_get_current_sources(
        ctypes.c_void_p(finder), ctypes.byref(count)
    )

    results = []
    for i in range(count.value):
        src  = sources_ptr[i]
        name = src.p_ndi_name.decode("utf-8", errors="replace")    if src.p_ndi_name    else ""
        url  = src.p_url_address.decode("utf-8", errors="replace") if src.p_url_address else ""
        if name:
            results.append({"name": name, "url": url})

    # ── Cleanup ───────────────────────────────────────────────────────────────
    ndi.NDIlib_find_destroy.restype  = None
    ndi.NDIlib_find_destroy.argtypes = [ctypes.c_void_p]
    ndi.NDIlib_find_destroy(ctypes.c_void_p(finder))
    ndi.NDIlib_destroy()

    return results


if __name__ == "__main__":
    timeout   = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    extra_ips = sys.argv[2]      if len(sys.argv) > 2 else ""
    print(json.dumps(discover(timeout, extra_ips)))
