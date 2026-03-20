#!/usr/bin/env python3
"""
GStreamer pipeline with dynamic PNG overlay using gdkpixbufoverlay.
Unlike gst-launch-1.0, this script can dynamically reload the PNG
by updating the gdkpixbufoverlay 'location' property at runtime.
It polls the PNG file's modification time and reloads when it changes.
"""

import sys
import os
import gi
gi.require_version('Gst', '1.0')
gi.require_version('GLib', '2.0')
from gi.repository import Gst, GLib

Gst.init(None)

def main():
    if len(sys.argv) < 7:
        print(f"Usage: {sys.argv[0]} CAMERA_DEVICE WIDTH HEIGHT FRAMERATE BITRATE SRT_PORT [PNG_PATH] [OVERLAY_TEXT] [SHOW_TIMESTAMP] [FONT_SIZE]")
        sys.exit(1)

    camera_device = sys.argv[1]
    width = int(sys.argv[2])
    height = int(sys.argv[3])
    framerate = int(sys.argv[4])
    bitrate = int(sys.argv[5])
    srt_port = sys.argv[6]
    png_path = sys.argv[7] if len(sys.argv) > 7 else "/tmp/graphics-overlay.png"
    overlay_text = sys.argv[8] if len(sys.argv) > 8 else ""
    show_timestamp = sys.argv[9] if len(sys.argv) > 9 else "false"
    font_size = sys.argv[10] if len(sys.argv) > 10 else "48"

    bitrate_kbps = bitrate // 1000

    print(f"🎨 Starting stream with dynamic PNG overlay (Python GStreamer)...")
    print(f"Camera: {camera_device}")
    print(f"Resolution: {width}x{height}@{framerate}fps")
    print(f"SRT Port: {srt_port}")
    print(f"PNG Overlay: {png_path} (auto-reload on change)")
    print(f"Text Overlay: {overlay_text}")
    print(f"Show Timestamp: {show_timestamp}")

    # Build pipeline string - same as the shell script but with named overlay element
    text_overlay = ""
    if overlay_text:
        text_overlay = f'! textoverlay text="{overlay_text}" valignment=bottom halignment=left font-desc="Sans Bold {font_size}" color=4294967295 xpad=20 ypad=20 shaded-background=true '

    timestamp_overlay = ""
    if show_timestamp == "true":
        timestamp_overlay = f'! clockoverlay valignment=bottom halignment=right font-desc="Sans Bold {font_size}" color=4294967295 time-format="%Y-%m-%d %H:%M:%S" xpad=20 ypad=20 shaded-background=true '

    pipeline_str = (
        f'v4l2src device={camera_device} do-timestamp=true '
        f'! image/jpeg,width={width},height={height},framerate={framerate}/1 '
        f'! jpegdec '
        f'! videoconvert '
        f'! gdkpixbufoverlay name=overlay location={png_path} overlay-width={width} overlay-height={height} '
        f'! videoconvert '
        f'{text_overlay}'
        f'{timestamp_overlay}'
        f'! tee name=t '
        f't. ! queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 leaky=downstream ! videoconvert '
        f"! video/x-raw,format=I420 "
        f'! x264enc speed-preset=ultrafast tune=zerolatency bitrate={bitrate_kbps} key-int-max=30 threads=2 '
        f"! video/x-h264,stream-format=byte-stream "
        f'! h264parse config-interval=-1 '
        f'! queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 leaky=downstream '
        f'! mpegtsmux alignment=7 '
        f'! srtsink uri="srt://:{srt_port}" wait-for-connection=false latency=125 '
        f't. ! queue max-size-buffers=10 leaky=downstream '
        f'! videoscale '
        f'! video/x-raw,width=1280,height=720 '
        f'! jpegenc quality=75 '
        f'! multipartmux boundary=--jpgboundary '
        f'! tcpserversink host=0.0.0.0 port=8555 sync=false recover-policy=keyframe'
    )

    print(f"\nPipeline: {pipeline_str}\n")

    pipeline = Gst.parse_launch(pipeline_str)
    overlay_element = pipeline.get_by_name("overlay")

    if not overlay_element:
        print("❌ Could not find overlay element in pipeline")
        sys.exit(1)

    # Track PNG file modification time for auto-reload
    last_mtime = 0
    try:
        last_mtime = os.path.getmtime(png_path)
    except OSError:
        pass

    def check_png_update():
        """Poll PNG file for changes and reload overlay when modified."""
        nonlocal last_mtime
        try:
            current_mtime = os.path.getmtime(png_path)
            if current_mtime != last_mtime:
                last_mtime = current_mtime
                overlay_element.set_property("location", png_path)
                print(f"🔄 Overlay PNG reloaded (mtime changed)")
        except OSError:
            pass  # File doesn't exist yet or was briefly removed during atomic write
        return True  # Keep the timer running

    # Check for PNG updates every 500ms
    GLib.timeout_add(500, check_png_update)

    # Handle pipeline messages
    bus = pipeline.get_bus()
    bus.add_signal_watch()

    loop = GLib.MainLoop()

    def on_message(bus, message):
        t = message.type
        if t == Gst.MessageType.EOS:
            print("🛑 End of stream")
            loop.quit()
        elif t == Gst.MessageType.ERROR:
            err, debug = message.parse_error()
            print(f"❌ GStreamer error: {err.message}")
            if debug:
                print(f"   Debug: {debug}")
            loop.quit()
        elif t == Gst.MessageType.STATE_CHANGED:
            if message.src == pipeline:
                old, new, pending = message.parse_state_changed()
                print(f"Pipeline state: {old.value_nick} → {new.value_nick}")

    bus.connect("message", on_message)

    # Start pipeline
    ret = pipeline.set_state(Gst.State.PLAYING)
    if ret == Gst.StateChangeReturn.FAILURE:
        print("❌ Failed to start pipeline")
        # Check bus for the actual error message
        bus = pipeline.get_bus()
        msg = bus.timed_pop_filtered(5 * Gst.SECOND, Gst.MessageType.ERROR)
        if msg:
            err, debug = msg.parse_error()
            print(f"   Error: {err.message}")
            if debug:
                print(f"   Debug: {debug}")
        pipeline.set_state(Gst.State.NULL)
        sys.exit(1)

    print("✅ Pipeline started, overlay will auto-reload when PNG changes")

    try:
        loop.run()
    except KeyboardInterrupt:
        print("\n🛑 Interrupted")
    finally:
        pipeline.set_state(Gst.State.NULL)

if __name__ == "__main__":
    main()

