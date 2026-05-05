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
    # NDI source name (arg 24, optional — only used when input_type == "ndi")
    input_ndi_name = sys.argv[24] if len(sys.argv) > 24 else ""

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

    # Detect NDI audio passthrough sentinel set by streamController.js.
    # When input_type is "ndi" and audioEnabled is true, Node.js passes "ndi"
    # as the audio_device arg.  ndisrcdemux exposes an "audio" src pad (dynamic,
    # but referenced by name in the pipeline string — gst-parse waits for it).
    # No ALSA device or pad-added callback is needed.
    use_ndi_audio = (audio_device == "ndi")
    if use_ndi_audio:
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
            # No ALSA audio — GStreamer handles RTMP directly via flvmux.
            # For NDI audio: a static audiotestsrc→audiomixer→avenc_aac chain is
            # wired to mux.audio in the pipeline string so flvmux always has audio
            # data flowing (silence until NDI audio arrives).  The pad-added
            # callback then mixes real NDI audio into the audiomixer.
            # For RTSP audio: the pad-added callback requests mux.audio directly.
            output_sink = (
                f'! video/x-h264,stream-format=avc,alignment=au '
                f'! flvmux name=mux streamable=true '
                f'! rtmpsink location={rtmp_url} sync=false async=false '
            )
            if use_ndi_audio:
                audio_mux_target = 'mux.audio'  # static chain references it
            else:
                audio_mux_target = None  # RTSP audio / video-only: pad-added or nothing
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
    # All paths end with raw video at the configured framerate, ready for
    # overlay compositing and encoding by the common downstream pipeline.
    if input_type == "ndi" and input_ndi_name:
        print(f"📡 Input source: NDI → {input_ndi_name}", file=sys.stderr)
        # ndisrc outputs application/x-ndi (proprietary).  ndisrcdemux splits that
        # into separate "video" (video/x-raw) and "audio" (audio/x-raw) src pads.
        # Both pads are "Sometimes" (dynamic) — gst-parse handles the named-pad
        # references automatically, waiting for the pads to appear at PLAYING time.
        # Name the demux "ndi_demux" so the audio chain below can reference
        # "ndi_demux.audio" without a separate pad-added callback.
        source_str = (
            # timestamp-mode=receive-time stamps each frame with the Pi's own
            # CLOCK_REALTIME at the moment the frame arrives over the network.
            f'ndisrc ndi-name="{input_ndi_name}" connect-timeout=5000 timestamp-mode=receive-time '
            f'! ndisrcdemux name=ndi_demux '
            # ── Intentional chain break (space, not !) ────────────────────────
            # The video processing elements (videoconvert → videoscale →
            # capsfilter → videorate) are built and linked DYNAMICALLY in
            # on_ndi_video_pad_added when ndisrcdemux creates its video pad.
            #
            # If those elements were in the parse string they would be in PAUSED
            # when the pipeline starts and the downstream caps (1920×1080 @60fps)
            # would back-propagate into ndi_in_q.sink, making pad.link() return
            # NOT_NEGOTIATED when the NDI source sends a different resolution.
            #
            # ndi_in_q is the static injection point for the dynamic chain and
            # also serves as the thread-boundary queue that non-NDI sources get
            # from the "! queue" line in pipeline_str (which is skipped for NDI).
            f'queue name=ndi_in_q max-size-buffers=3 max-size-time=0 max-size-bytes=0 leaky=downstream '
        )
    elif input_type == "rtsp" and input_rtsp_url:
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
        # Thread boundary: isolate overlay compositing (or just buffering) from capture.
        # NDI skips this queue — ndi_in_q (the chain-break queue in source_str) already
        # acts as the thread boundary AND the dynamic-video injection point.
        + ('' if input_type == 'ndi' else
           '! queue max-size-buffers=3 max-size-time=0 max-size-bytes=0 leaky=downstream ')
        + f'{overlay_section}'
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
            # config-interval=0 is only needed for the ALSA hybrid mode where ffmpeg
            # reads the MPEG-TS stdout.  In that path a DTS monotonicity issue arises
            # because ffmpeg re-emits inline SPS+PPS+IDR as two buffers with the same
            # DTS, causing MediaMTX to drop the connection.
            # For pure-GStreamer paths (NDI, RTSP audio, video-only RTMP), mpph264enc
            # uses header-mode=each-idr which already inlines SPS+PPS before every IDR;
            # keeping config-interval=-1 lets h264parse pass them through as-is so
            # flvmux always sees the decoder configuration record alongside the keyframe.
            f'! h264parse config-interval={"0" if protocol == "rtmp" and audio_device else "-1"} '
        )
        # Thread boundary before mux to decouple encoder from network I/O.
        # All RTMP paths (video-only, NDI audio, RTSP audio) use flvmux which
        # requires strict DTS monotonicity — no leaky, 2s buffer.
        # SRT or RTMP+ALSA-audio (mpegtsmux, video-only branch): 500 ms leaky queue
        # is safe because mpegtsmux has only one input and never stalls on audio.
        + (f'! queue max-size-buffers=0 max-size-time=2000000000 max-size-bytes=0 '
           if protocol == "rtmp" and not audio_device else
           f'! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 leaky=downstream ')
        + output_sink +
        (
            # ALSA audio branch: audiomixer → voaacenc → mux.
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
        (
            # NDI audio branch: a silent audiotestsrc feeds an audiomixer so
            # flvmux always has audio data (never stalls waiting for the first
            # NDI audio buffer).  The pad-added callback mixes real NDI audio
            # into ndi_amix when it arrives; until then only silence is encoded.
            # audioconvert + audioresample after the mixer ensure avenc_aac gets
            # a supported format (S16LE/F32LE) regardless of audiomixer's output.
            f'audiotestsrc is-live=true volume=0 '
            f'! audio/x-raw,rate=48000,channels=2 '
            f'! audiomixer name=ndi_amix '
            f'! audioconvert ! audioresample '
            f'! audio/x-raw,rate=48000,channels=2 '
            f'! avenc_aac bitrate=128000 '
            f'! aacparse '
            f'! queue max-size-buffers=0 max-size-time=200000000 max-size-bytes=0 leaky=downstream '
            f'! {audio_mux_target} '
            if use_ndi_audio and audio_mux_target else ''
        ) +
        # Preview branch (own thread, low priority)
        f't. ! queue max-size-buffers=10 leaky=downstream '
        f'! videorate ! video/x-raw,framerate=1/1 '
        f'! videoconvert ! videoscale '
        f'! video/x-raw,width=1280,height=720 '
        f'! jpegenc quality=65 '
        f'! multipartmux boundary=--jpgboundary '
        # async=false: tcpserversink must not participate in preroll.
        # With the dynamic NDI video chain, ndi_in_q.sink is unlinked at
        # parse time, so the preview branch (tee → queue → ... → tcpserversink)
        # is not downstream of any live source at pipeline construction time.
        # tcpserversink defaults to async=true (waits for a preroll buffer
        # before acking the PAUSED state change), which blocks the pipeline
        # from ever reaching PLAYING — a deadlock since ndisrc only pushes
        # data in PLAYING state.  async=false opts this sink out of preroll
        # so the PAUSED→PLAYING transition completes immediately.
        f'! tcpserversink host=0.0.0.0 port=8555 sync=false async=false recover-policy=keyframe'
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

                # Step 1: add all elements (stay in NULL state).
                for elem in [audioqueue, audioconv, audiores, aacenc, aacparse_el]:
                    pipeline.add(elem)

                # Step 2: link fully so caps are known before state sync.
                pad.link(audioqueue.get_static_pad("sink"))
                audioqueue.link(audioconv)
                audioconv.link(audiores)
                audiores.link(aacenc)
                aacenc.link(aacparse_el)

                # Request the audio sink pad from the mux.
                # flvmux (RTMP) uses "audio"; mpegtsmux (SRT) uses "audio_%u".
                mux_factory = mux.get_factory().get_name() if mux.get_factory() else ""
                pad_name = "audio" if mux_factory == "flvmux" else "audio_%u"
                mux_sink = mux.request_pad_simple(pad_name)
                if mux_sink:
                    aacparse_el.get_static_pad("src").link(mux_sink)
                    print(f"🔊 RTSP audio linked to {mux_factory}.{pad_name}", file=sys.stderr)
                else:
                    print(f"⚠️  Could not get {mux_factory} audio request pad", file=sys.stderr)

                # Step 3: sync state after full linking.
                for elem in [audioqueue, audioconv, audiores, aacenc, aacparse_el]:
                    elem.sync_state_with_parent()

            dec_element.connect("pad-added", on_rtsp_pad_added, mux_element)
            print("🔊 RTSP audio passthrough: pad-added handler installed", file=sys.stderr)
        else:
            print("⚠️  RTSP audio: could not find 'dec' or 'mux' element — audio disabled", file=sys.stderr)

    # ── NDI audio passthrough ──────────────────────────────────────────────────
    # The static pipeline string contains:
    #   audiotestsrc is-live=true volume=0 ! audiomixer name=ndi_amix ! avenc_aac ! … ! mux.audio
    # This keeps flvmux fed with audio at all times (silence until real NDI audio
    # arrives) so it never stalls waiting for the first audio buffer.  When
    # ndisrcdemux creates its "audio" pad we only add two lightweight converter
    # elements (audioconvert + audioresample) and link them to the already-running
    # audiomixer — avenc_aac is static so no encoder state-sync during transitions.
    if use_ndi_audio:
        ndi_demux_el = pipeline.get_by_name("ndi_demux")
        ndi_amix_el  = pipeline.get_by_name("ndi_amix")

        if ndi_demux_el and ndi_amix_el:
            _ndi_audio_linked = [False]

            def _do_link_ndi_audio_to_amix(pad, amix):
                """Mix real NDI audio into ndi_amix (runs on GLib main loop).
                Only adds audioconvert + audioresample — no encoder state-syncing."""
                if _ndi_audio_linked[0]:
                    return False

                audioconv = Gst.ElementFactory.make("audioconvert",  None)
                audiores  = Gst.ElementFactory.make("audioresample", None)

                if not all([audioconv, audiores]):
                    print("❌ Could not create NDI audio converter elements", file=sys.stderr)
                    return False

                # Step 1: add (stay in NULL).
                for elem in [audioconv, audiores]:
                    pipeline.add(elem)

                # Step 2: link — ndi_demux.audio → audioconvert → audioresample → amix.
                pad.link(audioconv.get_static_pad("sink"))
                audioconv.link(audiores)
                amix_sink = amix.request_pad_simple("sink_%u")
                if amix_sink:
                    audiores.get_static_pad("src").link(amix_sink)
                else:
                    print("⚠️  Could not get audiomixer sink pad — NDI audio skipped", file=sys.stderr)
                    return False

                # Step 3: sync state after linking.
                for elem in [audioconv, audiores]:
                    elem.sync_state_with_parent()

                _ndi_audio_linked[0] = True
                print("🔊 NDI audio mixed into audiomixer", file=sys.stderr)
                return False  # run once

            def on_ndi_pad_added(element, pad, amix):
                if pad.get_name() != "audio":
                    return
                if _ndi_audio_linked[0]:
                    return
                print("🔊 NDI audio pad detected — dropping frames until chain linked", file=sys.stderr)

                # Use a DROP probe (not BLOCK) to silently discard audio frames
                # until the downstream chain is set up on the main loop.
                #
                # BLOCK_DOWNSTREAM would deadlock: the probe suspends the
                # streaming thread, but idle_add calls sync_state_with_parent()
                # which needs that same thread free to ack the state change.
                #
                # DROP returns GST_FLOW_OK to ndisrcdemux before GStreamer even
                # checks whether the pad is linked, so NOT_LINKED is never
                # returned.  The handful of audio frames dropped during the
                # < 50 ms setup window are inaudible.
                probe_id = pad.add_probe(
                    Gst.PadProbeType.BUFFER,
                    lambda p, info: Gst.PadProbeReturn.DROP,
                )

                def _do_link_then_stop_dropping(pad, amix):
                    _do_link_ndi_audio_to_amix(pad, amix)
                    pad.remove_probe(probe_id)   # stop dropping — audio flows
                    return False

                GLib.idle_add(_do_link_then_stop_dropping, pad, amix)

            ndi_demux_el.connect("pad-added", on_ndi_pad_added, ndi_amix_el)
            print("🔊 NDI audio: silent baseline + pad-added handler installed", file=sys.stderr)
        else:
            print("⚠️  NDI audio: could not find 'ndi_demux' or 'ndi_amix' — audio disabled", file=sys.stderr)

    # ── NDI video pad: NOT_LINKED race guard ──────────────────────────────────
    # gst_parse_launch registers its own pad-added listener to link
    # "ndi_demux.video → ndi_vq" but the Teltek ndisrcdemux can push its first
    # buffer before that link completes, returning NOT_LINKED which kills the
    # whole pipeline.
    #
    # Fix: install a BUFFER DROP probe the instant the video pad appears (before
    # any push).  On the GLib main loop we then confirm the link is established
    # (or do it manually if gst_parse lost the race), then remove the probe so
    # video flows normally.  The handful of frames dropped during the <50 ms
    # setup window are imperceptible.
    if input_type == "ndi":
        _ndi_vdmx_el = pipeline.get_by_name("ndi_demux")
        if _ndi_vdmx_el:
            _ndi_video_linked = [False]

            def on_ndi_video_pad_added(element, pad, pl):
                # ── Audio pad: always guard, even when use_ndi_audio=False ──
                # When use_ndi_audio is False the audio pad-added handler above
                # is never installed.  ndisrcdemux still creates an "audio" src
                # pad and immediately starts pushing buffers.  Without a sink the
                # push returns NOT_LINKED which propagates back through ndisrc and
                # kills the whole pipeline.  Install a permanent DROP probe so
                # those buffers are silently discarded before GStreamer checks
                # whether the pad is linked.
                if pad.get_name() == "audio" and not use_ndi_audio:
                    pad.add_probe(
                        Gst.PadProbeType.BUFFER,
                        lambda p, info: Gst.PadProbeReturn.DROP,
                    )
                    print("🔇 NDI audio pad: DROP probe installed (audio not used)", file=sys.stderr)
                    return

                if pad.get_name() != "video":
                    return
                if _ndi_video_linked[0]:
                    return

                print("🎥 NDI video pad detected — installing DROP probe", file=sys.stderr)
                probe_id_box = [None]
                probe_id_box[0] = pad.add_probe(
                    Gst.PadProbeType.BUFFER,
                    lambda p, info: Gst.PadProbeReturn.DROP,
                )

                def _build_chain_and_unblock():
                    if _ndi_video_linked[0]:
                        return False

                    ndi_in_q = pl.get_by_name("ndi_in_q")
                    if not ndi_in_q:
                        print("⚠️  ndi_in_q not found — NDI video may stall", file=sys.stderr)
                        _ndi_video_linked[0] = True
                        return False

                    # Build the video processing chain fresh here — no element
                    # exists in the pipeline yet so ndi_in_q.sink has ANY caps
                    # and accepts whatever format/size the NDI source sends.
                    vconv  = Gst.ElementFactory.make("videoconvert", None)
                    vscale = Gst.ElementFactory.make("videoscale",   None)
                    vcaps  = Gst.ElementFactory.make("capsfilter",   None)
                    vrate  = Gst.ElementFactory.make("videorate",    None)

                    if not all([vconv, vscale, vcaps, vrate]):
                        print("❌ Could not create NDI video chain elements", file=sys.stderr)
                        _ndi_video_linked[0] = True
                        return False

                    # Single capsfilter enforces both size AND framerate downstream
                    # of videorate so the encoder always receives a stable format.
                    vcaps.set_property("caps",
                        Gst.Caps.from_string(
                            f"video/x-raw,width={width},height={height},framerate={framerate}/1"))
                    vrate.set_property("drop-only", True)

                    for el in [vconv, vscale, vcaps, vrate]:
                        pl.add(el)

                    # ndi_demux.video → vconv → vscale → videorate(drop-only)
                    #   → capsfilter(W×H @fps) → ndi_in_q
                    #
                    # Use link_full(CHECK_NOTHING) throughout: freshly-created elements
                    # have no negotiated caps yet, and GStreamer's link-time template
                    # check can spuriously return NOFORMAT when upstream elements
                    # (especially capsfilter) have already fixed some fields but the
                    # peer is still ANY.  Real caps negotiation happens when the first
                    # buffer flows — CHECK_NOTHING just establishes the structural link.
                    def _link(src_pad, sink_pad, label):
                        ret = src_pad.link_full(sink_pad, Gst.PadLinkCheck.NOTHING)
                        if ret != Gst.PadLinkReturn.OK:
                            print(f"❌ NDI video link FAILED [{label}]: {ret}", file=sys.stderr)
                        else:
                            print(f"🔗 NDI video link OK  [{label}]", file=sys.stderr)
                        return ret

                    _link(pad,                           vconv.get_static_pad("sink"),  "demux→vconv")
                    _link(vconv.get_static_pad("src"),   vscale.get_static_pad("sink"), "vconv→vscale")
                    _link(vscale.get_static_pad("src"),  vrate.get_static_pad("sink"),  "vscale→vrate")
                    _link(vrate.get_static_pad("src"),   vcaps.get_static_pad("sink"),  "vrate→vcaps")
                    _link(vcaps.get_static_pad("src"),   ndi_in_q.get_static_pad("sink"), "vcaps→ndi_in_q")

                    for el in [vconv, vscale, vcaps, vrate]:
                        el.sync_state_with_parent()

                    print("🎥 NDI video chain built and linked dynamically", file=sys.stderr)

                    if probe_id_box[0] is not None:
                        pad.remove_probe(probe_id_box[0])
                        probe_id_box[0] = None
                    _ndi_video_linked[0] = True
                    return False  # run once

                GLib.idle_add(_build_chain_and_unblock)

            _ndi_vdmx_el.connect("pad-added", on_ndi_video_pad_added, pipeline)
            print("🎥 NDI video: DROP probe race-guard installed", file=sys.stderr)
        else:
            print("⚠️  NDI video guard: could not find 'ndi_demux'", file=sys.stderr)

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

