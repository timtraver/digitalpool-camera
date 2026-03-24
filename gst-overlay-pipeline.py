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
    if len(sys.argv) < 8:
        print(f"Usage: {sys.argv[0]} CAMERA_DEVICE WIDTH HEIGHT FRAMERATE BITRATE PROTOCOL DESTINATION [PNG_PATH] [OVERLAY_TEXT] [SHOW_TIMESTAMP] [FONT_SIZE] [COLOR] [BACKGROUND] [TIMESTAMP_FORMAT] [TITLE_POS] [TIMESTAMP_POS]")
        sys.exit(1)

    camera_device = sys.argv[1]
    width = int(sys.argv[2])
    height = int(sys.argv[3])
    framerate = int(sys.argv[4])
    bitrate = int(sys.argv[5])
    protocol = sys.argv[6]        # 'srt', 'rtmp', or 'udp'
    destination = sys.argv[7]     # Full destination URL
    png_path = sys.argv[8] if len(sys.argv) > 8 else "/tmp/graphics-overlay.png"
    overlay_text = sys.argv[9] if len(sys.argv) > 9 else ""
    show_timestamp = sys.argv[10] if len(sys.argv) > 10 else "false"
    font_size = sys.argv[11] if len(sys.argv) > 11 else "48"
    overlay_color = sys.argv[12] if len(sys.argv) > 12 else "4294967295"
    overlay_background = sys.argv[13] if len(sys.argv) > 13 else "transparent"
    timestamp_format = sys.argv[14] if len(sys.argv) > 14 else "%Y-%m-%d %H:%M:%S"
    title_position = sys.argv[15] if len(sys.argv) > 15 else "top-left"
    timestamp_position = sys.argv[16] if len(sys.argv) > 16 else "bottom-right"
    audio_device = sys.argv[17] if len(sys.argv) > 17 else ""
    # Per-element timestamp formatting (new args, optional for backward compat)
    ts_font_size = sys.argv[18] if len(sys.argv) > 18 else font_size
    ts_color = sys.argv[19] if len(sys.argv) > 19 else overlay_color
    ts_background = sys.argv[20] if len(sys.argv) > 20 else overlay_background

    bitrate_kbps = bitrate // 1000

    # Parse positions (format: "top-left" -> valignment=top, halignment=left)
    def parse_position(pos_str):
        parts = pos_str.split("-")
        vpos = parts[0] if len(parts) > 0 else "bottom"
        hpos = parts[1] if len(parts) > 1 else "left"
        valign = {"top": "top", "center": "center", "bottom": "bottom"}.get(vpos, "bottom")
        halign = {"left": "left", "center": "center", "right": "right"}.get(hpos, "left")
        return valign, halign

    # Shaded background properties (per-element)
    title_shaded_bg = "shaded-background=true " if overlay_background != "transparent" else ""
    ts_shaded_bg = "shaded-background=true " if ts_background != "transparent" else ""

    print(f"🎨 Starting stream with dynamic PNG overlay (Python GStreamer)...")
    print(f"Camera: {camera_device}")
    print(f"Resolution: {width}x{height}@{framerate}fps")
    print(f"Protocol: {protocol}")
    print(f"Destination: {destination}")
    print(f"PNG Overlay: {png_path} (auto-reload on change)")
    print(f"Text Overlay: {overlay_text}")
    print(f"Show Timestamp: {show_timestamp}")
    print(f"Title: color={overlay_color}, size={font_size}, bg={overlay_background}")
    print(f"Timestamp: color={ts_color}, size={ts_font_size}, bg={ts_background}")
    print(f"Timestamp Format: {timestamp_format}")

    # Build pipeline string - same as the shell script but with named overlay element
    text_overlay = ""
    if overlay_text:
        t_valign, t_halign = parse_position(title_position)
        text_overlay = f'! textoverlay text="{overlay_text}" valignment={t_valign} halignment={t_halign} font-desc="Sans Bold {font_size}" color={overlay_color} xpad=20 ypad=20 {title_shaded_bg}'

    timestamp_overlay = ""
    if show_timestamp == "true":
        ts_valign, ts_halign = parse_position(timestamp_position)
        timestamp_overlay = f'! clockoverlay valignment={ts_valign} halignment={ts_halign} font-desc="Sans Bold {ts_font_size}" color={ts_color} time-format="{timestamp_format}" xpad=20 ypad=20 {ts_shaded_bg}'

    # Build protocol-specific output sink
    if protocol == "srt":
        # SRT: use mpegtsmux → srtsink (listener mode)
        # latency=500ms: larger retransmit window prevents packet drops from VBR bursts or jitter
        srt_uri = destination if destination else "srt://:8891"
        output_sink = (
            f'! mpegtsmux name=mux alignment=7 '
            f'! srtsink uri="{srt_uri}" wait-for-connection=false latency=500 sync=false async=false '
        )
        audio_mux_target = 'mux.'
    elif protocol == "rtmp":
        # RTMP: use flvmux → rtmpsink
        # Do NOT add a second h264parse here. The h264parse config-interval=-1 upstream
        # will negotiate stream-format=avc,alignment=au directly with flvmux through the
        # queue (caps negotiation is transparent to queues). A second parse re-splits
        # SPS+PPS+IDR access units into separate NAL buffers with identical DTS values,
        # which causes MediaMTX to drop readers with "DTS is not monotonically increasing".
        rtmp_url = destination if destination else "rtmp://localhost:1935/stream"
        output_sink = (
            f'! video/x-h264,stream-format=avc,alignment=au '
            f'! flvmux name=mux streamable=true '
            f'! rtmpsink location={rtmp_url} sync=false async=false '
        )
        audio_mux_target = 'mux.'
    elif protocol == "udp":
        # UDP: use mpegtsmux → udpsink
        # Parse host:port from destination like udp://HOST:PORT
        udp_dest = destination.replace("udp://", "")
        udp_parts = udp_dest.split(":")
        udp_host = udp_parts[0] if len(udp_parts) > 0 else "127.0.0.1"
        udp_port = udp_parts[1] if len(udp_parts) > 1 else "5000"
        output_sink = (
            f'! mpegtsmux name=mux '
            f'! udpsink host={udp_host} port={udp_port} sync=false async=false '
        )
        audio_mux_target = 'mux.'
    else:
        print(f"❌ Unsupported protocol: {protocol}")
        sys.exit(1)

    # Thread architecture (each queue creates a new thread boundary):
    #   Thread 1: v4l2src → mppjpegdec (capture)
    #   Thread 2: queue → videoconvert(BGRA) → overlay → tee (overlay compositing)
    #   Thread 3: queue → videoconvert(NV12) → mpph264enc → h264parse → queue → mux → sink (encode+stream)
    #   Thread 4: queue → audioresample → voaacenc → aacparse → queue → mux. (audio - fully isolated)
    #   Thread 5: queue → videorate → videoscale → jpegenc → tcpserversink (preview)
    pipeline_str = (
        f'v4l2src device={camera_device} do-timestamp=true '
        f'! image/jpeg,width={width},height={height},framerate={framerate}/1 '
        f'! jpegparse ! mppjpegdec '
        # Thread boundary: isolate overlay compositing from capture
        f'! queue max-size-buffers=3 max-size-time=0 max-size-bytes=0 leaky=downstream '
        f'! videoconvert ! video/x-raw,format=BGRA '
        f'! gdkpixbufoverlay name=overlay location={png_path} overlay-width={width} overlay-height={height} '
        f'{text_overlay}'
        f'{timestamp_overlay}'
        f'! tee name=t '
        # Encode branch (own thread)
        f't. ! queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 leaky=downstream '
        f'! videoconvert ! video/x-raw,format=NV12 '
        # CBR for SRT: constant bitrate keeps SRT's retransmit buffer from overflowing.
        # gop=15 (0.5s at 30fps): faster visual recovery when any packet loss does occur.
        + (f'! mpph264enc bps={bitrate} bps-max={bitrate} rc-mode=cbr gop=15 header-mode=each-idr profile=baseline '
           if protocol == "srt" else
           f'! mpph264enc bps={bitrate} bps-max=0 rc-mode=vbr gop=15 header-mode=each-idr profile=baseline ')
        + f"! video/x-h264,stream-format=byte-stream "
        f'! h264parse config-interval=-1 '
        # Thread boundary before mux to decouple encoder from network I/O
        # Larger buffer absorbs spikes from PNG overlay reloads
        # No leaky for RTMP — dropping encoded H264 frames causes DTS duplicates/gaps
        + (f'! queue max-size-buffers=0 max-size-time=2000000000 max-size-bytes=0 '
           if protocol == "rtmp" else
           f'! queue max-size-buffers=0 max-size-time=1000000000 max-size-bytes=0 leaky=downstream ')
        + output_sink +
        (
            # Audio branch: fully isolated in its own thread
            # The queue right after alsasrc caps ensures audio capture+encode
            # never competes with video processing for CPU time
            f'alsasrc device={audio_device} provide-clock=false '
            f'! audio/x-raw,rate=32000,channels=2,format=S16LE '
            f'! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 '  # 500ms buffer
            f'! audioconvert ! audioresample '
            f'! audio/x-raw,rate=48000,channels=2 '
            f'! voaacenc bitrate=128000 '
            f'! aacparse '
            # Thread boundary before mux to avoid blocking on mux lock
            f'! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 '
            f'! {audio_mux_target} '
            if audio_device else ''
        ) +
        # Preview branch (own thread, low priority)
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

    # Check for PNG updates every 2 seconds (screenshot only changes every 5s)
    GLib.timeout_add(2000, check_png_update)

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

