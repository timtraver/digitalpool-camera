#!/usr/bin/env python3
"""
GStreamer pipeline with dynamic PNG overlay using gdkpixbufoverlay.
Unlike gst-launch-1.0, this script can dynamically reload the PNG
by updating the gdkpixbufoverlay 'location' property at runtime.
It polls the PNG file's modification time and reloads when it changes.
"""

import sys
import os
import time
import gi
gi.require_version('Gst', '1.0')
gi.require_version('GLib', '2.0')
from gi.repository import Gst, GLib

Gst.init(None)

# ── Force the global system clock to CLOCK_REALTIME immediately after init ──
# This MUST happen before any pipeline is created, because Gst.parse_launch()
# may internally query the system clock and cache its clockid.
# GstSystemClock is a singleton — obtain() always returns the same instance.
_system_clock = Gst.SystemClock.obtain()
_clock_type_before = _system_clock.get_property("clock-type")
_system_clock.set_property("clock-type", Gst.ClockType.REALTIME)
_clock_type_after = _system_clock.get_property("clock-type")

# Verify by comparing GStreamer clock time against wall time.
# CLOCK_REALTIME returns epoch-based nanoseconds (~1.7e18), while
# CLOCK_MONOTONIC returns uptime-based nanoseconds (typically < 1e15).
_gst_time_ns = _system_clock.get_time()
_wall_time_ns = int(time.time() * 1e9)
_delta_s = abs(_gst_time_ns - _wall_time_ns) / 1e9

print(f"🕒 SystemClock clock-type: before={_clock_type_before}, after={_clock_type_after}", file=sys.stderr)
print(f"🕒 GStreamer clock time : {_gst_time_ns / 1e9:.3f} s", file=sys.stderr)
print(f"🕒 Wall clock time      : {_wall_time_ns / 1e9:.3f} s", file=sys.stderr)
print(f"🕒 Delta                : {_delta_s:.3f} s", file=sys.stderr)

if _delta_s > 60:
    print("⚠️  WARNING: GStreamer clock is NOT using CLOCK_REALTIME — delta too large!", file=sys.stderr)
    print("⚠️  The clock-type property change may have been ignored by this GStreamer version.", file=sys.stderr)
else:
    print("✅ CLOCK_REALTIME confirmed — GStreamer and wall clock are within 60 s", file=sys.stderr)

def main():
    if len(sys.argv) < 8:
        print(f"Usage: {sys.argv[0]} CAMERA_DEVICE WIDTH HEIGHT FRAMERATE BITRATE PROTOCOL DESTINATION [PNG_PATH] [OVERLAY_TEXT] [SHOW_TIMESTAMP] [FONT_SIZE] [COLOR] [BACKGROUND] [TIMESTAMP_FORMAT] [TITLE_POS] [TIMESTAMP_POS]", file=sys.stderr)
        sys.exit(1)

    camera_device = sys.argv[1]
    width = int(sys.argv[2])
    height = int(sys.argv[3])
    framerate = int(sys.argv[4])
    bitrate = int(sys.argv[5])
    protocol = sys.argv[6]        # 'srt' or 'rtmp'
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
    # H.265 is incompatible with RTMP (FLV container only supports H.264)
    requested_codec = sys.argv[21] if len(sys.argv) > 21 else "h264"
    codec = "h264" if protocol == "rtmp" else requested_codec
    # Input source type and RTSP URL (optional — default to USB v4l2src)
    input_type    = sys.argv[22] if len(sys.argv) > 22 else "usb"
    input_rtsp_url = sys.argv[23] if len(sys.argv) > 23 else ""

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

    # All diagnostic output goes to stderr so stdout is reserved for clean binary
    # MPEG-TS data when running in hybrid SRT+audio mode (fdsink fd=1 → ffmpeg pipe).
    print(f"🎨 Starting stream with dynamic PNG overlay (Python GStreamer)...", file=sys.stderr)
    print(f"Camera: {camera_device}", file=sys.stderr)
    print(f"Resolution: {width}x{height}@{framerate}fps", file=sys.stderr)
    print(f"Protocol: {protocol}", file=sys.stderr)
    print(f"Destination: {destination}", file=sys.stderr)
    print(f"PNG Overlay: {png_path} (auto-reload on change)", file=sys.stderr)
    print(f"Text Overlay: {overlay_text}", file=sys.stderr)
    print(f"Show Timestamp: {show_timestamp}", file=sys.stderr)
    print(f"Title: color={overlay_color}, size={font_size}, bg={overlay_background}", file=sys.stderr)
    print(f"Timestamp: color={ts_color}, size={ts_font_size}, bg={ts_background}", file=sys.stderr)
    print(f"Timestamp Format: {timestamp_format}", file=sys.stderr)

    # Build pipeline string - same as the shell script but with named overlay element
    text_overlay = ""
    if overlay_text:
        t_valign, t_halign = parse_position(title_position)
        text_overlay = f'! textoverlay text="{overlay_text}" valignment={t_valign} halignment={t_halign} font-desc="Sans Bold {font_size}" color={overlay_color} xpad=20 ypad=20 {title_shaded_bg}'

    timestamp_overlay = ""
    if show_timestamp == "true":
        ts_valign, ts_halign = parse_position(timestamp_position)
        timestamp_overlay = f'! clockoverlay valignment={ts_valign} halignment={ts_halign} font-desc="Sans Bold {ts_font_size}" color={ts_color} time-format="{timestamp_format}" xpad=20 ypad=20 {ts_shaded_bg}'

    # Detect RTSP audio passthrough sentinel set by streamController.js.
    # When input_type is "rtsp" and audioEnabled is true, Node.js passes "rtsp"
    # as the audio_device arg instead of an ALSA device name.  In this mode we:
    #   1. Name the decodebin so we can tap its audio pad via pad-added.
    #   2. Clear audio_device so the output_sink uses direct GStreamer mode
    #      (srtsink / rtmpsink) rather than the ffmpeg fdsink hybrid.
    #   3. After Gst.parse_launch() we attach a pad-added handler that links
    #      the audio pad to audioconvert → audioresample → avenc_aac → mux.
    use_rtsp_audio = (audio_device == "rtsp")
    if use_rtsp_audio:
        audio_device = ""  # treat as no-ALSA for output_sink selection below

    # Build protocol-specific output sink
    if protocol == "srt":
        srt_uri = destination if destination else "srt://:8891"
        if audio_device:
            # Hybrid mode: GStreamer outputs VIDEO-ONLY MPEG-TS to stdout (fdsink fd=1).
            # ffmpeg (spawned by Node.js) captures ALSA audio and muxes it with the
            # incoming video before forwarding to SRT.
            #
            # Why no audio in the GStreamer mux:
            # mpegtsmux stalls video output whenever a USB mic underrun creates a gap
            # in the audio timestamp stream — even a 10 ms stall produces pixelation.
            # With video as the only mux input there is nothing to wait for and video
            # flows uninterrupted.
            # Clock strategy: GStreamer uses CLOCK_REALTIME (set below) and ffmpeg
            # uses -use_wallclock_as_timestamps 1 (av_gettime), both reading the
            # same system wall clock — no drift can accumulate regardless of how
            # long the session runs. aresample=async=1000 is a safety net for
            # sub-frame ALSA buffer boundary jitter only.
            print(f"🎤 SRT hybrid mode — video-only GStreamer mux, audio via ffmpeg ALSA", file=sys.stderr)
            output_sink = (
                f'! mpegtsmux name=mux alignment=7 '
                f'! fdsink fd=1 sync=false async=false '
            )
            audio_mux_target = None  # No audio in GStreamer mux — ffmpeg handles it
        else:
            # No audio — GStreamer handles SRT directly (stable, no muxer sync issue)
            output_sink = (
                f'! mpegtsmux name=mux alignment=7 '
                f'! srtsink uri="{srt_uri}" wait-for-connection=false latency=500 sync=false async=false '
            )
            audio_mux_target = 'mux.'
    elif protocol == "rtmp":
        rtmp_url = destination if destination else "rtmp://localhost:1935/stream"
        if audio_device:
            # Hybrid mode: GStreamer outputs VIDEO-ONLY MPEG-TS to stdout (fdsink fd=1).
            # ffmpeg (spawned by Node.js) captures ALSA audio and muxes it with the
            # incoming video before pushing to the RTMP server as FLV.
            #
            # Clock strategy: GStreamer uses CLOCK_REALTIME (set below) and ffmpeg
            # uses -use_wallclock_as_timestamps 1 (av_gettime), both reading the
            # same NTP-corrected system wall clock. The USB mic oscillator runs
            # ~0.12% faster than the system clock (~764 µs/s drift), but since
            # both processes share CLOCK_REALTIME as their time base, their PTS
            # streams stay aligned indefinitely — no accumulation possible.
            # aresample=async=1000 is a safety net for sub-frame jitter only.
            print(f"🎤 RTMP hybrid mode — video-only GStreamer mux, audio via ffmpeg ALSA → RTMP", file=sys.stderr)
            output_sink = (
                f'! mpegtsmux name=mux alignment=7 '
                f'! fdsink fd=1 sync=false async=false '
            )
            audio_mux_target = None  # No audio in GStreamer mux — ffmpeg handles it
        else:
            # No audio — GStreamer handles RTMP directly via flvmux (no drift to worry about).
            # Do NOT add a second h264parse here. The h264parse config-interval=-1 upstream
            # negotiates stream-format=avc,alignment=au directly with flvmux through the
            # queue. A second parse re-splits SPS+PPS+IDR access units into separate NAL
            # buffers with identical DTS values, causing MediaMTX to drop readers.
            output_sink = (
                f'! video/x-h264,stream-format=avc,alignment=au '
                f'! flvmux name=mux streamable=true '
                f'! rtmpsink location={rtmp_url} sync=false async=false '
            )
            audio_mux_target = None  # No audio
    else:
        print(f"❌ Unsupported protocol: {protocol}", file=sys.stderr)
        sys.exit(1)

    # Determine whether a PNG overlay element is needed.
    # An empty png_path means the pipeline is being routed through Python purely
    # for CLOCK_REALTIME (audio sync) — skip gdkpixbufoverlay entirely.
    has_png_overlay = bool(png_path)

    # Determine if ANY overlay is active. When none are, skip the expensive
    # software NV12→BGRA→NV12 round-trip entirely — the hardware encoder
    # (mpph264enc) accepts NV12 directly from mppjpegdec. This is critical
    # for high-resolution streams (e.g. 4K@30fps) where the colorspace
    # conversion is the primary CPU/memory-bandwidth bottleneck.
    has_any_overlay = has_png_overlay or bool(overlay_text) or show_timestamp == "true"

    # Maximum resolution at which overlay compositing runs in software.
    # NV12↔BGRA conversion scales with pixel count — at 4K@30fps it requires
    # ~2 GB/s of memory bandwidth, which stalls the pipeline on this hardware.
    # Anything above 1080p is downscaled proportionally before compositing and
    # then encoded at that lower resolution (the encode resolution = overlay
    # resolution, not the original capture resolution).
    # Benefit: 4K→1080p downsampling still looks sharper than a native 1080p
    # capture because the full-sensor readout is used.
    OVERLAY_MAX_WIDTH  = 1920
    OVERLAY_MAX_HEIGHT = 1080

    if has_any_overlay and (width > OVERLAY_MAX_WIDTH or height > OVERLAY_MAX_HEIGHT):
        scale_factor   = min(OVERLAY_MAX_WIDTH / width, OVERLAY_MAX_HEIGHT / height)
        overlay_width  = int(width  * scale_factor)
        overlay_height = int(height * scale_factor)
        # Codec requirement: dimensions must be even
        overlay_width  = overlay_width  - (overlay_width  % 2)
        overlay_height = overlay_height - (overlay_height % 2)
        prescale = (
            f'! videoscale '
            f'! video/x-raw,width={overlay_width},height={overlay_height} '
        )
        print(f"📐 Overlays active — scaling {width}x{height} → {overlay_width}x{overlay_height} before compositing", file=sys.stderr)
    else:
        overlay_width  = width
        overlay_height = height
        prescale = ''

    # Pre-compute the gdkpixbufoverlay fragment so it can be safely interpolated
    # as a plain f-string variable inside pipeline_str (Python's implicit string
    # concatenation does not support ternary expressions mid-tuple).
    # Uses overlay_width/overlay_height (post-scale) so the PNG fills the frame.
    png_overlay_element = (
        f'! gdkpixbufoverlay name=overlay location={png_path} '
        f'overlay-width={overlay_width} overlay-height={overlay_height} '
        if has_png_overlay else ''
    )

    # When overlays are present we must convert to BGRA for compositing, then
    # back to NV12 for the hardware encoder. When there are no overlays, skip
    # both conversions — mppjpegdec already emits NV12 which mpph264enc accepts.
    if has_any_overlay:
        overlay_section = (
            f'{prescale}'
            f'! videoconvert ! video/x-raw,format=BGRA '
            f'{png_overlay_element}'
            f'{text_overlay}'
            f'{timestamp_overlay}'
        )
        encode_convert = f'! videoconvert ! video/x-raw,format=NV12 '
    else:
        overlay_section = ''
        encode_convert = ''

    # Build the capture/decode source section based on input type.
    # Both paths end with raw video at the configured framerate, ready for
    # overlay compositing and encoding by the common downstream pipeline.
    if input_type == "rtsp" and input_rtsp_url:
        print(f"📡 Input source: RTSP → {input_rtsp_url}", file=sys.stderr)
        # decodebin emits dynamic caps — videoconvert + videoscale normalise them
        # to a fixed resolution/format before videorate enforces the target fps.
        #
        # When use_rtsp_audio is True we name the decodebin "dec" so that the
        # pad-added handler below can tap its audio pad at runtime.  We also
        # explicitly start the video chain with "dec. ! videoconvert" so GStreamer
        # knows to connect the video pad here (rather than auto-selecting any pad).
        dec_name = "name=dec " if use_rtsp_audio else ""
        dec_ref  = "dec. "    if use_rtsp_audio else ""
        source_str = (
            f'rtspsrc location={input_rtsp_url} latency=200 protocols=tcp '
            f'! decodebin {dec_name}'
            f'{dec_ref}! videoconvert '
            f'! videoscale '
            f'! video/x-raw,width={width},height={height} '
            f'! videorate ! video/x-raw,framerate={framerate}/1 '
        )
    else:
        print(f"📹 Input source: USB v4l2src → {camera_device}", file=sys.stderr)
        source_str = (
            f'v4l2src device={camera_device} do-timestamp=true '
            f'! image/jpeg,width={width},height={height},framerate={framerate}/1 '
            f'! jpegparse ! mppjpegdec '
            f'! videorate ! video/x-raw,framerate={framerate}/1 '
        )

    # Thread architecture (each queue creates a new thread boundary):
    #   Thread 1: source (v4l2src or rtspsrc+decodebin) — capture/decode
    #   Thread 2: queue → [if overlays: videoscale(if>1080p) → videoconvert(BGRA) → overlays → videoconvert(NV12)] → tee
    #             (when no overlays: queue feeds tee directly in NV12 — no colorspace conversion)
    #   Thread 3: queue → mpph264enc → h264parse → queue → mux → fdsink (encode+stream)
    #   Thread 4: queue → videorate → videoscale → jpegenc → tcpserversink (preview)
    #   Audio is handled by ffmpeg (ALSA capture) outside this pipeline.
    pipeline_str = (
        f'{source_str}'
        # Thread boundary: isolate overlay compositing (or just buffering) from capture
        f'! queue max-size-buffers=3 max-size-time=0 max-size-bytes=0 leaky=downstream '
        f'{overlay_section}'
        f'! tee name=t '
        # Encode branch (own thread)
        f't. ! queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 leaky=downstream '
        f'{encode_convert}'
        # Constrained VBR: bps_max=1.6x target allows the encoder to burst for high-motion
        # frames (fast pool shots) rather than raising quantizer and pixelating.
        # SRT latency=500ms absorbs the short bursts; average bitrate stays near bps target.
        + (
            # H.265 (HEVC) — Rockchip MPP hardware encoder, SRT / RTSP only
            f'! mpph265enc bps={bitrate} bps-max={round(bitrate * 1.6)} rc-mode=vbr gop=5 header-mode=each-idr profile=main '
            f'! video/x-h265,stream-format=byte-stream '
            f'! h265parse config-interval=-1 '
            if codec == "h265" else
            # H.264 (default) — Rockchip MPP hardware encoder, all protocols
            f'! mpph264enc bps={bitrate} bps-max={round(bitrate * 1.6)} rc-mode=vbr gop=5 header-mode=each-idr profile=baseline '
            f'! video/x-h264,stream-format=byte-stream '
            # RTMP+audio hybrid: config-interval=0 — SPS/PPS go only into the MPEG-TS PMT.
            # ffmpeg reads them once at startup and writes ONE AVC sequence header in FLV.
            # With config-interval=-1, ffmpeg sees inline SPS/PPS before every IDR and
            # emits a sequence header + IDR NALU with identical DTS → MediaMTX drops the
            # connection with "DTS is not monotonically increasing".
            # All other paths use -1 so OBS/players can resync after any packet loss.
            f'! h264parse config-interval={"0" if protocol == "rtmp" and audio_device else "-1"} '
        )
        # Thread boundary before mux to decouple encoder from network I/O.
        # RTMP without audio still uses flvmux (which requires DTS monotonicity) —
        # no leaky, 2s buffer. All other paths use mpegtsmux with a single video-only
        # input so leaky=downstream is safe and 500ms is sufficient.
        + (f'! queue max-size-buffers=0 max-size-time=2000000000 max-size-bytes=0 '
           if protocol == "rtmp" and not audio_device else
           # SRT or RTMP+audio (mpegtsmux, video-only): 500 ms absorbs PNG overlay
           # reload CPU spikes; leaky is safe since mpegtsmux never waits on audio.
           f'! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 leaky=downstream ')
        + output_sink +
        (
            # Audio branch: audiomixer → voaacenc → mux.
            # audiomixer runs at a fixed pipeline-clock rate and fills any USB mic gap
            # with silence — mpegtsmux always sees continuous audio → no video stall.
            # Both streams share the single pipeline clock → automatic A/V sync.
            f'audiomixer name=amix latency=200000000 '
            f'! voaacenc bitrate=128000 '
            f'! aacparse '
            f'! queue max-size-buffers=0 max-size-time=200000000 max-size-bytes=0 leaky=downstream '
            f'! {audio_mux_target} '
            f'alsasrc device={audio_device} provide-clock=false do-timestamp=true '
            f'buffer-time=50000 latency-time=25000 '
            f'! audio/x-raw,rate=32000,channels=2,format=S16LE '
            f'! queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 leaky=downstream '
            f'! audiorate '
            f'! audioconvert ! audioresample '
            f'! audio/x-raw,rate=48000,channels=2 '
            f'! amix. '
            if audio_device and audio_mux_target else ''
        ) +
        # Preview branch (own thread, low priority)
        f't. ! queue max-size-buffers=10 leaky=downstream '
        f'! videorate ! video/x-raw,framerate=1/1 '
        f'! videoconvert ! videoscale '
        f'! video/x-raw,width=1280,height=720 '
        f'! jpegenc quality=65 '
        f'! multipartmux boundary=--jpgboundary '
        f'! tcpserversink host=0.0.0.0 port=8555 sync=false recover-policy=keyframe'
    )

    print(f"\nPipeline: {pipeline_str}\n", file=sys.stderr)

    pipeline = Gst.parse_launch(pipeline_str)

    # ── RTSP audio passthrough ─────────────────────────────────────────────
    # When the input is an RTSP source that carries audio, decodebin creates an
    # audio pad dynamically at PLAYING time.  We connect a pad-added handler to
    # route that pad through: audioconvert → audioresample → avenc_aac → mux.
    # If the RTSP stream has no audio track the callback simply never fires for
    # an audio pad and the pipeline runs silently as video-only — no error.
    if use_rtsp_audio:
        dec_element = pipeline.get_by_name("dec")
        mux_element = pipeline.get_by_name("mux")

        if dec_element and mux_element:
            # Guard flag: ensures we only build the audio chain once even if
            # decodebin fires pad-added multiple times (e.g. RTSP reconnects).
            # Without this, each reconnect leaks 5 new GStreamer elements that
            # are added to the pipeline but never cleaned up.
            _rtsp_audio_linked = [False]

            def on_rtsp_pad_added(element, pad, mux):
                # Only handle audio pads — video is already wired in the string.
                pad_caps = pad.get_current_caps() or pad.query_caps(None)
                if not pad_caps:
                    return
                struct = pad_caps.get_structure(0)
                if not struct or not struct.get_name().startswith("audio/"):
                    return

                if _rtsp_audio_linked[0]:
                    print("🔊 RTSP audio pad fired again — already linked, skipping", file=sys.stderr)
                    return
                _rtsp_audio_linked[0] = True

                print("🔊 RTSP audio pad detected — linking passthrough to mux", file=sys.stderr)

                audioqueue   = Gst.ElementFactory.make("queue",          None)
                audioconv    = Gst.ElementFactory.make("audioconvert",   None)
                audiores     = Gst.ElementFactory.make("audioresample",  None)
                aacenc       = Gst.ElementFactory.make("avenc_aac",      None)
                aacparse_el  = Gst.ElementFactory.make("aacparse",       None)

                if not all([audioqueue, audioconv, audiores, aacenc, aacparse_el]):
                    print("❌ Could not create audio passthrough elements", file=sys.stderr)
                    return

                aacenc.set_property("bitrate", 128000)

                for elem in [audioqueue, audioconv, audiores, aacenc, aacparse_el]:
                    pipeline.add(elem)
                    elem.sync_state_with_parent()

                pad.link(audioqueue.get_static_pad("sink"))
                audioqueue.link(audioconv)
                audioconv.link(audiores)
                audiores.link(aacenc)
                aacenc.link(aacparse_el)

                # Request the audio sink pad from the mux.
                # flvmux (RTMP) uses "audio"; mpegtsmux (SRT) uses "audio_%u".
                mux_factory = mux.get_factory().get_name() if mux.get_factory() else ""
                pad_name = "audio" if mux_factory == "flvmux" else "audio_%u"
                mux_sink = mux.get_request_pad(pad_name)
                if mux_sink:
                    aacparse_el.get_static_pad("src").link(mux_sink)
                    print(f"🔊 RTSP audio linked to {mux_factory}.{pad_name}", file=sys.stderr)
                else:
                    print(f"⚠️  Could not get {mux_factory} audio request pad", file=sys.stderr)

            dec_element.connect("pad-added", on_rtsp_pad_added, mux_element)
            print("🔊 RTSP audio passthrough: pad-added handler installed", file=sys.stderr)
        else:
            print("⚠️  RTSP audio: could not find 'dec' or 'mux' element — audio disabled", file=sys.stderr)

    # Attach the global CLOCK_REALTIME system clock to this pipeline.
    # The clock-type was already set to REALTIME at module load (above Gst.init).
    pipeline.use_clock(_system_clock)
    print(f"🕒 Pipeline clock attached (clock-type={_system_clock.get_property('clock-type')})", file=sys.stderr)

    overlay_element = pipeline.get_by_name("overlay")

    if has_png_overlay and not overlay_element:
        print("❌ Could not find overlay element in pipeline", file=sys.stderr)
        sys.exit(1)

    # Track PNG file modification time for auto-reload (only when overlay is active)
    last_mtime = 0
    if has_png_overlay:
        try:
            last_mtime = os.path.getmtime(png_path)
        except OSError:
            pass

    def check_png_update():
        """Poll PNG file for changes and reload overlay when modified.

        gdkpixbufoverlay leaks the old GdkPixbuf on some GStreamer versions when
        the 'location' property is changed while the pipeline is PLAYING.  To cap
        leak rate we poll every 10 s (not 2 s), and we only set the property when
        the file has actually changed — so a static overlay never triggers a reload.
        """
        nonlocal last_mtime
        if not overlay_element:
            return True  # No overlay element — nothing to update
        try:
            current_mtime = os.path.getmtime(png_path)
            if current_mtime != last_mtime:
                last_mtime = current_mtime
                overlay_element.set_property("location", png_path)
                print(f"🔄 Overlay PNG reloaded (mtime changed)", file=sys.stderr)
        except OSError:
            pass  # File doesn't exist yet or was briefly removed during atomic write
        return True  # Keep the timer running

    # Poll every 10 s instead of 2 s — reduces gdkpixbufoverlay pixbuf churn by 5x.
    # Most overlays update at most once per second from Puppeteer; 10 s latency is
    # imperceptible for scoreboard / timestamp overlays.
    if overlay_element:
        GLib.timeout_add(10000, check_png_update)

    # Handle pipeline messages
    bus = pipeline.get_bus()
    bus.add_signal_watch()

    loop = GLib.MainLoop()

    def on_message(bus, message):
        t = message.type
        if t == Gst.MessageType.EOS:
            print("🛑 End of stream", file=sys.stderr)
            loop.quit()
        elif t == Gst.MessageType.ERROR:
            err, debug = message.parse_error()
            print(f"❌ GStreamer error: {err.message}", file=sys.stderr)
            if debug:
                print(f"   Debug: {debug}", file=sys.stderr)
            loop.quit()
        elif t == Gst.MessageType.STATE_CHANGED:
            if message.src == pipeline:
                old, new, pending = message.parse_state_changed()
                print(f"Pipeline state: {old.value_nick} → {new.value_nick}", file=sys.stderr)

    bus.connect("message", on_message)

    # Start pipeline
    ret = pipeline.set_state(Gst.State.PLAYING)
    if ret == Gst.StateChangeReturn.FAILURE:
        print("❌ Failed to start pipeline", file=sys.stderr)
        # Check bus for the actual error message
        bus = pipeline.get_bus()
        msg = bus.timed_pop_filtered(5 * Gst.SECOND, Gst.MessageType.ERROR)
        if msg:
            err, debug = msg.parse_error()
            print(f"   Error: {err.message}", file=sys.stderr)
            if debug:
                print(f"   Debug: {debug}", file=sys.stderr)
        pipeline.set_state(Gst.State.NULL)
        sys.exit(1)

    overlay_msg = " (overlay auto-reloads on PNG change)" if overlay_element else ""
    print(f"✅ Pipeline started{overlay_msg} [CLOCK_REALTIME — no long-term A/V drift]", file=sys.stderr)

    # ── Periodic drift monitor ────────────────────────────────────────────
    # Every 60 s, log the pipeline's running_time vs wall-clock elapsed time.
    # If the two diverge by more than ~10 ms/min, the clock fix isn't working.
    _start_wall = time.time()

    def _log_drift():
        _ok, position = pipeline.query_position(Gst.Format.TIME)
        if _ok and position >= 0:
            wall_elapsed = time.time() - _start_wall
            gst_elapsed = position / 1e9  # nanoseconds → seconds
            drift = gst_elapsed - wall_elapsed
            ppm = (drift / wall_elapsed * 1e6) if wall_elapsed > 0 else 0
            print(
                f"🕒 Drift check — GStreamer: {gst_elapsed:.3f}s  "
                f"Wall: {wall_elapsed:.3f}s  "
                f"Δ: {drift:+.3f}s  ({ppm:+.1f} ppm)",
                file=sys.stderr,
            )
        return True  # keep timer running

    GLib.timeout_add_seconds(60, _log_drift)

    try:
        loop.run()
    except KeyboardInterrupt:
        print("\n🛑 Interrupted", file=sys.stderr)
    finally:
        pipeline.set_state(Gst.State.NULL)

if __name__ == "__main__":
    main()

