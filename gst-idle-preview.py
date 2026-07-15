#!/usr/bin/env python3
"""
gst-idle-preview.py — run the idle-preview GStreamer pipeline with a hot-swappable
PNG overlay.

`gst-launch-1.0` loads gdkpixbufoverlay's PNG once at startup and never re-reads it,
so the idle preview could only reflect an overlay change by rebuilding the whole
pipeline (a visible blink, and it froze on whatever frame existed at rebuild time).
This runner instead keeps the pipeline running and reloads the overlay PNG at
runtime by polling its mtime and setting gdkpixbufoverlay's "location" property —
the same Path-B reload gst-overlay-pipeline.py uses. Switching or refreshing the
overlay then updates the live preview within one poll interval, with no rebuild.

The pipeline is built with Gst.parse_launchv(argv) — the exact function
gst-launch-1.0 uses internally — so the pipeline is byte-identical to what the old
`gst-launch-1.0 <args>` invocation produced. The only added behavior is the mtime
poll on the element named "overlay" (if present).

Usage:
    gst-idle-preview.py <png_path> <gst-launch element/property/link tokens...>

    <png_path>  Overlay PNG to watch for changes. May be "" when the pipeline has
                no overlay element (overlay disabled) — then no poll is installed.
    <args...>   The same tokens gst-launch-1.0 would receive. For hot-swap to work
                the pipeline must contain `gdkpixbufoverlay name=overlay ...`.
"""

import os
import sys
import signal

import gi
gi.require_version("Gst", "1.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gst, GLib


def main():
    if len(sys.argv) < 3:
        print("usage: gst-idle-preview.py <png_path> <gst args...>", file=sys.stderr)
        return 2

    png_path = sys.argv[1]
    pipeline_args = sys.argv[2:]

    Gst.init(None)

    # parse_launchv takes the argv vector directly — identical to how
    # gst-launch-1.0 constructs the pipeline, so no string-join/quoting drift.
    try:
        pipeline = Gst.parse_launchv(pipeline_args)
    except GLib.Error as exc:
        print(f"❌ parse_launchv failed: {exc}", file=sys.stderr)
        return 1
    if pipeline is None:
        print("❌ parse_launchv returned no pipeline", file=sys.stderr)
        return 1

    loop = GLib.MainLoop()

    # ── Hot-swap: reload the overlay PNG when its mtime changes ──────────────
    overlay = pipeline.get_by_name("overlay")
    if overlay is not None and png_path:
        last_mtime = [0.0]
        try:
            last_mtime[0] = os.path.getmtime(png_path)
        except OSError:
            pass

        def check_png_update():
            try:
                m = os.path.getmtime(png_path)
                if m != last_mtime[0]:
                    last_mtime[0] = m
                    # Re-setting location makes gdkpixbufoverlay reload the file.
                    overlay.set_property("location", png_path)
            except OSError:
                pass  # file briefly absent during atomic rename — retry next tick
            except Exception as exc:
                print(f"⚠️  overlay reload failed: {exc}", file=sys.stderr)
            return True  # keep the timer running

        GLib.timeout_add(2000, check_png_update)
        print(f"🔄 Idle preview hot-swap active for overlay PNG: {png_path}", file=sys.stderr)
    else:
        print("ℹ️  Idle preview running without a hot-swap overlay element", file=sys.stderr)

    # ── Bus: exit on error / EOS so the Node supervisor can restart us ───────
    bus = pipeline.get_bus()
    bus.add_signal_watch()

    def on_message(_bus, msg):
        if msg.type == Gst.MessageType.ERROR:
            err, dbg = msg.parse_error()
            print(f"❌ GStreamer error: {err.message} ({dbg})", file=sys.stderr)
            loop.quit()
        elif msg.type == Gst.MessageType.EOS:
            print("ℹ️  End of stream", file=sys.stderr)
            loop.quit()
        return True

    bus.connect("message", on_message)

    # Clean shutdown on the signals Node sends to stop/restart the preview.
    def _shutdown(*_args):
        loop.quit()
        return GLib.SOURCE_REMOVE

    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, _shutdown)
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, _shutdown)

    if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
        print("❌ Failed to set idle preview pipeline to PLAYING", file=sys.stderr)
        pipeline.set_state(Gst.State.NULL)
        return 1

    try:
        loop.run()
    finally:
        pipeline.set_state(Gst.State.NULL)

    return 0


if __name__ == "__main__":
    sys.exit(main())
