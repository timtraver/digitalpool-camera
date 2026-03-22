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
        print(f"Usage: {sys.argv[0]} CAMERA_DEVICE WIDTH HEIGHT FRAMERATE BITRATE SRT_PORT [PNG_PATH] [OVERLAY_TEXT] [SHOW_TIMESTAMP] [FONT_SIZE] [COLOR] [BACKGROUND] [TIMESTAMP_FORMAT] [TITLE_POS] [TIMESTAMP_POS]")
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
    overlay_color = sys.argv[11] if len(sys.argv) > 11 else "4294967295"
    overlay_background = sys.argv[12] if len(sys.argv) > 12 else "transparent"
    timestamp_format = sys.argv[13] if len(sys.argv) > 13 else "%Y-%m-%d %H:%M:%S"
    title_position = sys.argv[14] if len(sys.argv) > 14 else "top-left"
    timestamp_position = sys.argv[15] if len(sys.argv) > 15 else "bottom-right"
    audio_device = sys.argv[16] if len(sys.argv) > 16 else ""

    bitrate_kbps = bitrate // 1000

    # Parse positions (format: "top-left" -> valignment=top, halignment=left)
    def parse_position(pos_str):
        parts = pos_str.split("-")
        vpos = parts[0] if len(parts) > 0 else "bottom"
        hpos = parts[1] if len(parts) > 1 else "left"
        valign = {"top": "top", "center": "center", "bottom": "bottom"}.get(vpos, "bottom")
        halign = {"left": "left", "center": "center", "right": "right"}.get(hpos, "left")
        return valign, halign

    # Shaded background property
    shaded_bg = "shaded-background=true " if overlay_background != "transparent" else ""

    print(f"🎨 Starting stream with dynamic PNG overlay (Python GStreamer)...")
    print(f"Camera: {camera_device}")
    print(f"Resolution: {width}x{height}@{framerate}fps")
    print(f"SRT Port: {srt_port}")
    print(f"PNG Overlay: {png_path} (auto-reload on change)")
    print(f"Text Overlay: {overlay_text}")
    print(f"Show Timestamp: {show_timestamp}")
    print(f"Overlay Color: {overlay_color}")
    print(f"Overlay Background: {overlay_background}")
    print(f"Timestamp Format: {timestamp_format}")

    # Build pipeline string - same as the shell script but with named overlay element
    text_overlay = ""
    if overlay_text:
        t_valign, t_halign = parse_position(title_position)
        text_overlay = f'! textoverlay text="{overlay_text}" valignment={t_valign} halignment={t_halign} font-desc="Sans Bold {font_size}" color={overlay_color} xpad=20 ypad=20 {shaded_bg}'

    timestamp_overlay = ""
    if show_timestamp == "true":
        ts_valign, ts_halign = parse_position(timestamp_position)
        timestamp_overlay = f'! clockoverlay valignment={ts_valign} halignment={ts_halign} font-desc="Sans Bold {font_size}" color={overlay_color} time-format="{timestamp_format}" xpad=20 ypad=20 {shaded_bg}'

    pipeline_str = (
        f'v4l2src device={camera_device} do-timestamp=true '
        f'! image/jpeg,width={width},height={height},framerate={framerate}/1 '
        f'! jpegparse ! mppjpegdec '
        f'! videoconvert ! video/x-raw,format=BGRA '
        f'! gdkpixbufoverlay name=overlay location={png_path} overlay-width={width} overlay-height={height} '
        f'{text_overlay}'
        f'{timestamp_overlay}'
        f'! tee name=t '
        f't. ! queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 leaky=downstream '
        f'! videoconvert ! video/x-raw,format=NV12 '
        f'! mpph264enc bps={bitrate} bps-max=0 rc-mode=vbr gop=30 header-mode=each-idr '
        f"! video/x-h264,stream-format=byte-stream "
        f'! h264parse config-interval=-1 '
        f'! queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 leaky=downstream '
        f'! mpegtsmux name=mux alignment=7 '
        f'! srtsink uri="srt://:{srt_port}" wait-for-connection=false latency=125 '
        + (
            f'alsasrc device={audio_device} provide-clock=false '
            f'! audio/x-raw,rate=32000,channels=2,format=S16LE '
            f'! audioconvert ! audioresample '
            f'! audio/x-raw,rate=48000,channels=2 '
            f'! voaacenc bitrate=128000 '
            f'! aacparse '
            f'! queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 '
            f'! mux. '
            if audio_device else ''
        ) +
        f't. ! queue max-size-buffers=10 leaky=downstream '
        f'! videorate ! video/x-raw,framerate=5/1 '
        f'! videoconvert ! videoscale '
        f'! video/x-raw,width=1280,height=720 '
        f'! jpegenc quality=65 '
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

