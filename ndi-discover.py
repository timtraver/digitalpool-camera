#!/usr/bin/env python3
"""
ndi-discover.py — Enumerate NDI sources visible on the local network.

Uses the NDI SDK (libndi.so.6) via ctypes.  Waits up to <timeout_ms>
milliseconds for mDNS/UDP discovery announcements, then prints a JSON
array of objects to stdout:

    [{"name": "DESKTOP-ABC (OBS)", "url": "192.168.1.10:5960"}, ...]

Usage:
    python3 ndi-discover.py [timeout_ms]   # default: 5000
"""

import ctypes
import json
import sys

NDI_LIB_PATH = "/usr/local/lib/libndi.so.6"


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


def discover(timeout_ms: int = 5000) -> list:
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

    settings = _NDIlib_find_create_t(
        show_local_sources=True,
        p_groups=None,
        p_extra_ips=None,
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
    timeout = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    print(json.dumps(discover(timeout)))
