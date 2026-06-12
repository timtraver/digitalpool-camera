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
    # Video orientation (args 25-26, optional — default to no flip)
    flip_horizontal = sys.argv[25].lower() == "true" if len(sys.argv) > 25 else False
    flip_vertical   = sys.argv[26].lower() == "true" if len(sys.argv) > 26 else False
    # Camera capture format (arg 27) — 'mjpeg' (OBSBOT etc.) or 'yuyv' (YUYV-only cameras)
    capture_format  = sys.argv[27] if len(sys.argv) > 27 else "mjpeg"
    # MediaMTX RTMP preview path (arg 28) — e.g. rtmp://localhost:1935/preview or /preview2
    preview_rtmp_url = sys.argv[28] if len(sys.argv) > 28 else "rtmp://localhost:1935/preview"
    # Active encoder (arg 29) — e.g. mpph264enc (Rockchip), vaapih264enc (Intel), x264enc (soft)
    # Passed from streamController.js so this script can select the matching JPEG decoder and
    # H.264/H.265 encoder without any platform-detection logic here.
    encoder = sys.argv[29] if len(sys.argv) > 29 else "mpph264enc"
    # JPEG decoder: Rockchip MPP hardware (mppjpegdec) for mpp* encoders, software jpegdec for
    # Intel VA-API (vaapih264enc) and software (x264enc) encoders.
    jpeg_decoder = 'mppjpegdec' if encoder.startswith('mpp') else 'jpegdec'

    # GStreamer videoflip method:
    #   0 = identity (none), 2 = rotate-180, 4 = horizontal-flip, 5 = vertical-flip
    if flip_horizontal and flip_vertical:
        flip_method = 2   # 180° rotation is equivalent to H+V flip
    elif flip_horizontal:
        flip_method = 4
    elif flip_vertical:
        flip_method = 5
    else:
        flip_method = 0
    flip_str = f'! videoflip method={flip_method} ' if flip_method != 0 else ''

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
        if audio_device and encoder == 'omxh264videoenc':
            # OMX native mode: GStreamer handles RTMP + ALSA audio directly via flvmux.
            #
            # The mpegtsmux → pipe → ffmpeg hybrid path is NOT viable for the Allwinner
            # OMX encoder because:
            #   1. omxh264videoenc outputs "garbage" frames during its warm-up phase that
            #      carry no SPS/PPS headers — ffmpeg probes those frames and fails with
            #      "[flv] dimensions not set" before the first real IDR ever arrives.
            #   2. Increasing probesize/analyzeduration only delays the failure; the
            #      root cause is that the OMX encoder simply does not emit headers until
            #      the hardware has fully warmed up (several seconds after PLAYING).
            #
            # With flvmux + stream-format=avc the SPS/PPS are carried in the caps as
            # codec_data (the AVC Decoder Configuration Record).  flvmux writes a proper
            # AVC Sequence Header from those caps before writing any frame — no inline
            # SPS/PPS injection into the bitstream is required, so the warm-up frames
            # do not cause a failure.
            print(f"🎤 RTMP OMX native mode — GStreamer ALSA → voaacenc → flvmux (no ffmpeg)", file=sys.stderr)
            # Use explicit pad request "! mux.video" instead of auto-link "! flvmux".
            #
            # parse_launch's auto-link (!) propagates h264parse's src-pad caps
            # (stream-format=avc, alignment=au) through the queue and intersects them
            # against flvmux's pad template.  On GStreamer 1.18 the flvmux template
            # declares only "video/x-h264, stream-format=avc" — no alignment field.
            # GStreamer treats the un-declared field as a restriction, so the
            # intersection is empty and parse_launch fails with "queue can't handle caps".
            #
            # With "! mux.video" parse_launch directly requests the named pad on flvmux
            # without performing a template-caps intersection, sidestepping the bug.
            # flvmux (name=mux) is defined as a separate chain in the same pipeline
            # string — parse_launch resolves the forward reference in its second pass.
            # Use fakesink placeholders during parse_launch for BOTH the video
            # and audio connections to flvmux.
            #
            # GStreamer 1.18 parse_launch rejects ANY link to flvmux when the
            # upstream queue carries stream-format=avc,alignment=au — even with
            # explicit pad requests (! mux.video) or forward-declared named elements.
            # Additionally, "! mux.audio" can fail to resolve the request-pad
            # template "audio_%u" correctly on this build, causing parse_launch to
            # fall back to auto-linking the audio queue to the video pad (producing
            # the misleading error "queue can't handle caps video/x-h264").
            #
            # Solution: fakesink accepts all caps → parse_launch succeeds for both
            # branches.  After parse_launch we retrieve mainvidq/mainaudq by name,
            # remove both placeholder sinks, and manually link both queues to
            # flvmux's request pads via get_pad_template + request_pad.
            output_sink = f'! fakesink name=vidplaceholder sync=false async=false '
            audio_mux_target = 'fakesink name=audplaceholder sync=false async=false'
        elif audio_device:
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
    #
    # Flip placement: videoflip does NOT reliably handle NV12 (the format emitted
    # by mppjpegdec) on all Rockchip GStreamer builds — the pipeline enters
    # PLAYING state but stalls and produces zero frames.  The safe solution is to
    # apply the flip only after a colorspace conversion to a format that videoflip
    # fully supports on this hardware:
    #
    #   • Overlay path  → flip on BGRA  (we're converting to BGRA anyway)
    #   • No-overlay    → flip on I420  (minimal round-trip: NV12→I420→flip→NV12)
    if has_any_overlay:
        overlay_section = (
            f'{prescale}'
            f'! videoconvert ! video/x-raw,format=BGRA '
            # Flip after BGRA conversion so videoflip always receives a format it
            # fully supports (BGRA).  Overlays drawn after the flip are correct
            # orientation because flip_str is empty when flip_method == 0.
            f'{flip_str}'
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
            # Do NOT force width×height here: the RTSP camera delivers at its own
            # native resolution (e.g. 1920×1080).  Forcing a scale to the configured
            # stream resolution (e.g. 3840×2160) only to downscale again in the
            # overlay compositor wastes CPU/GPU and adds 10+ seconds of startup
            # latency that causes MediaMTX to drop the RTMP connection before the
            # first frame arrives.  The overlay/encode pipeline already contains a
            # videoscale to the correct output resolution.
            f'! videorate ! video/x-raw,framerate={framerate}/1 '
        )
    elif capture_format == "yuyv":
        # YUYV-only cameras (e.g. Minrray/Cypress): no MJPEG, use videoconvert.
        # Omit format=YUYV from caps — Rockchip's RGA-backed videoconvert doesn't
        # list YUYV in its static sink pad template.  Without the explicit format
        # constraint, GStreamer negotiates YUYV at runtime and converts to NV12.
        print(f"📹 Input source: USB v4l2src (YUYV) → {camera_device}", file=sys.stderr)
        source_str = (
            f'v4l2src device={camera_device} do-timestamp=true '
            f'! video/x-raw,width={width},height={height},framerate={framerate}/1 '
            f'! videoconvert ! video/x-raw,format=NV12 '
            f'! videorate ! video/x-raw,framerate={framerate}/1 '
        )
    else:
        # jpegparse is required before mppjpegdec (Rockchip hardware decoder needs parsed frames).
        # For software jpegdec (Intel, x86) we skip jpegparse — it is too strict and rejects
        # JPEG streams with minor header quirks (e.g. "Duplicated or bad SOF marker") that
        # jpegdec handles gracefully without the intermediary parser.
        parse_str = 'jpegparse ! ' if jpeg_decoder == 'mppjpegdec' else ''
        print(f"📹 Input source: USB v4l2src (MJPEG) → {camera_device} [{jpeg_decoder}]", file=sys.stderr)
        source_str = (
            f'v4l2src device={camera_device} do-timestamp=true '
            f'! image/jpeg,width={width},height={height} '
            f'! {parse_str}{jpeg_decoder} '
            f'! videorate ! video/x-raw,framerate={framerate}/1 '
        )

    # Thread architecture (each queue creates a new thread boundary):
    #   Thread 1: source (v4l2src or rtspsrc+decodebin) — capture/decode
    #   Thread 2: queue → [if overlays: videoscale(if>1080p) → videoconvert(BGRA) → flip → overlays → videoconvert(NV12)] → tee
    #             (when no overlays + flip: videoconvert(I420) → flip → videoconvert(NV12) → tee)
    #             (when no overlays + no flip: queue feeds tee directly in NV12 — no conversion)
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
        # No-overlay + flip: insert a format-safe round-trip so videoflip never
        # receives NV12 (unreliable on this hardware).  Overlay path skips this
        # because flip_str is already embedded inside overlay_section (after BGRA).
        + (f'! videoconvert ! video/x-raw,format=I420 {flip_str}! videoconvert ! video/x-raw,format=NV12 '
           if flip_str and not has_any_overlay else '')
        + f'{overlay_section}'
        f'! tee name=t '
        # Encode branch (own thread)
        f't. ! queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 leaky=downstream '
        f'{encode_convert}'
        # Constrained VBR: bps_max=1.6x target allows the encoder to burst for high-motion
        # frames (fast pool shots) rather than raising quantizer and pixelating.
        # SRT latency=500ms absorbs the short bursts; average bitrate stays near bps target.
        + (
            # H.265 (HEVC) — Rockchip MPP or Intel VA-API hardware encoder, SRT/RTSP only.
            # RTMP (FLV) only supports H.264 so codec is forced to h264 for RTMP above.
            (f'! mpph265enc bps={bitrate} bps-max={round(bitrate * 1.6)} rc-mode=vbr gop=5 header-mode=each-idr '
             if encoder.startswith('mpp') else
             f'! vaapih265enc bitrate={bitrate_kbps} keyframe-period=15 ')
            + f'! video/x-h265,stream-format=byte-stream '
            + f'! h265parse config-interval=-1 '
            if codec == "h265" else
            # H.264 — encoder selected by the 'encoder' argument (arg 29):
            #   mpph264enc  : Rockchip MPP hardware (bps in bits, VBR with burst headroom)
            #   vaapih264enc: Intel VA-API hardware (bitrate in kbps, keyframe-period)
            #   x264enc     : software fallback (bitrate in kbps, ultrafast/zerolatency)
            (f'! mpph264enc bps={bitrate} bps-max={round(bitrate * 1.6)} rc-mode=vbr gop=5 header-mode=each-idr profile=baseline '
             if encoder == 'mpph264enc' else
             f'! vaapih264enc bitrate={bitrate_kbps} keyframe-period=15 '
             if encoder == 'vaapih264enc' else
             # OMX (Allwinner): h264parse always comes BEFORE the stream-format cap filter.
             # The OMX encoder outputs SPS/PPS as GStreamer caps (codec_data).  h264parse
             # reads those caps and passes SPS/PPS downstream:
             #   • flvmux path (RTMP + native ALSA): stream-format=avc — SPS/PPS live in
             #     codec_data caps; flvmux writes the AVC Decoder Configuration Record
             #     before any frame.  No inline injection needed; warm-up garbage frames
             #     do NOT cause "dimensions not set" because flvmux reads caps, not bitstream.
             #   • mpegtsmux path (RTMP no-audio or SRT): stream-format=byte-stream with
             #     config-interval=-1 injects SPS+PPS inline before every IDR so the TS
             #     PMT always contains the parameters (used by ffmpeg in SRT hybrid mode).
             f'! omxh264videoenc target-bitrate={bitrate} control-rate=constant interval-intraframes=5 '
             # h264parse strategy for OMX (Allwinner A733 / Cedar VPU):
             #
             # The Cedar OMX encoder outputs stream-format=avc (NALU length-prefixed)
             # but NEVER sets codec_data in the GStreamer caps.  SPS and PPS are
             # embedded as NALUs inside each IDR frame's buffer data, not in the caps.
             # h264parse in AVC→AVC passthrough mode can't determine nal-length-size
             # without codec_data, so it cannot extract SPS/PPS → codec_data stays
             # empty → flvmux writes an empty AVC Decoder Configuration Record →
             # MediaMTX closes the RTMP connection ("Failed to write data").
             #
             # Double-h264parse workaround (native RTMP+audio / flvmux path):
             #   Pass 1: h264parse converts AVC → byte-stream.
             #           Without input codec_data it defaults to nal-length-size=4,
             #           which matches Cedar VPU output.  It finds SPS (type 7) and
             #           PPS (type 8) NALUs in the buffer, strips length prefixes,
             #           and outputs start-code NALUs.
             #   Pass 2: h264parse receives byte-stream with inline SPS+PPS,
             #           trivially finds them via start codes, builds a proper
             #           AVCDecoderConfigurationRecord (codec_data), and sends it
             #           in the output CAPS event before the first IDR buffer.
             #           flvmux receives codec_data → writes valid AVC sequence
             #           header → MediaMTX accepts the stream.
             #   config-interval=-1 on pass 2 re-sends codec_data before every IDR,
             #   keeping the sequence header current even after encoder key-frame resets.
             #
             # All other OMX paths (SRT / video-only RTMP → mpegtsmux/ffmpeg):
             #   Single h264parse with byte-stream output; ffmpeg reads inline SPS/PPS.
             + ('! h264parse '
                '! video/x-h264,stream-format=byte-stream '
                '! h264parse config-interval=-1 '
                '! video/x-h264,stream-format=avc '
                if protocol == 'rtmp' and audio_device else
                '! h264parse config-interval=-1 '
                '! video/x-h264,stream-format=byte-stream ')
             if encoder == 'omxh264videoenc' else
             f'! x264enc bitrate={bitrate_kbps} speed-preset=ultrafast tune=zerolatency key-int-max=15 ')
            + ('' if encoder == 'omxh264videoenc' else
               # Non-OMX encoders: cap filter then h264parse.
               # RTMP+audio hybrid: config-interval=0 — SPS/PPS go only into the MPEG-TS PMT.
               # ffmpeg reads them once at startup and writes ONE AVC sequence header in FLV.
               # config-interval=0 is only needed for the ALSA hybrid mode where ffmpeg
               # reads the MPEG-TS stdout.  In that path a DTS monotonicity issue arises
               # because ffmpeg re-emits inline SPS+PPS+IDR as two buffers with the same
               # DTS, causing MediaMTX to drop the connection.
               # For pure-GStreamer paths (NDI, RTSP audio, video-only RTMP), the encoder
               # uses header-mode=each-idr which already inlines SPS+PPS before every IDR;
               # keeping config-interval=-1 lets h264parse pass them through as-is so
               # flvmux always sees the decoder configuration record alongside the keyframe.
               f'! video/x-h264,stream-format=byte-stream '
               f'! h264parse config-interval={"0" if protocol == "rtmp" and audio_device else "-1"} ')
        )
        # Thread boundary before mux to decouple encoder from network I/O.
        # flvmux paths (RTMP video-only, NDI, RTSP, OMX native ALSA): 2 s non-leaky queue
        # because flvmux requires strict DTS monotonicity — dropping frames would produce
        # a DTS gap that causes MediaMTX to close the connection.
        # mpegtsmux paths (SRT, or RTMP+ALSA hybrid with non-OMX encoders): 500 ms leaky
        # queue is safe because mpegtsmux has only one video input and never stalls on audio.
        # OMX native RTMP path: name the queue so we can retrieve it by name
        # after parse_launch and manually relink it to flvmux's video pad.
        + (f'! queue name=mainvidq max-size-buffers=0 max-size-time=2000000000 max-size-bytes=0 '
           if encoder == 'omxh264videoenc' and protocol == 'rtmp' and audio_device else
           f'! queue max-size-buffers=0 max-size-time=2000000000 max-size-bytes=0 '
           if protocol == "rtmp" and (not audio_device or encoder == 'omxh264videoenc') else
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
            # OMX native RTMP: name the audio output queue so we can retrieve it
            # by name after parse_launch and programmatically link it to
            # flvmux's audio request pad (bypassing parse_launch caps checks).
            + (f'! queue name=mainaudq max-size-buffers=0 max-size-time=200000000 max-size-bytes=0 leaky=downstream '
               if encoder == 'omxh264videoenc' and protocol == 'rtmp' and audio_device else
               f'! queue max-size-buffers=0 max-size-time=200000000 max-size-bytes=0 leaky=downstream ')
            + f'! {audio_mux_target} '
            + f'alsasrc device={audio_device} provide-clock=false do-timestamp=true '
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
        # Preview branch (own thread, low priority) — H.264 push to MediaMTX for WebRTC.
        # Taps raw video from tee t, scales to 720p, encodes at 15 fps with the MPP hardware
        # encoder, and pushes to rtmp://localhost:1935/preview.  MediaMTX serves this path as
        # WebRTC via WHEP at http://localhost:8889/preview/whep, which the Node.js server
        # proxies at /api/whep/preview so the admin browser fetches it over port 3000.
        #
        # async=false: rtmpsink must not participate in preroll (same reason as the old
        # tcpserversink — with the dynamic NDI video chain, ndi_in_q.sink is unlinked at
        # parse time, so the preview branch is not downstream of any live source at pipeline
        # construction time.  A sink with async=true would block the PAUSED→PLAYING
        # transition waiting for a preroll buffer that never arrives until PLAYING).
        f't. ! queue max-size-buffers=10 leaky=downstream '
        f'! videoscale ! video/x-raw,width=1280,height=720 '
        f'! videorate ! video/x-raw,framerate=15/1 '
        f'! videoconvert ! video/x-raw,format=NV12 '
        # Preview encoder: same hardware selection as the main stream encoder.
        # Exception: omxh264videoenc (Allwinner) has a multi-second cold-start delay
        # that causes librtmp to drop the RTMP connection before the first frame arrives.
        # Fall back to x264enc for the preview branch so the WebRTC preview is always
        # available immediately.  The main stream still uses OMX hardware encoding.
        + (f'! mpph264enc bps=500000 header-mode=each-idr gop=15 '
           if encoder == 'mpph264enc' else
           f'! vaapih264enc bitrate=500 keyframe-period=15 '
           if encoder == 'vaapih264enc' else
           # OMX: fall back to x264enc — NV12→I420 conversion required for x264enc input.
           f'! videoconvert ! video/x-raw,format=I420 '
           f'! x264enc bitrate=500 speed-preset=ultrafast tune=zerolatency key-int-max=15 '
           if encoder == 'omxh264videoenc' else
           f'! x264enc bitrate=500 speed-preset=ultrafast tune=zerolatency key-int-max=15 ')
        + f'! h264parse config-interval=-1 '
        # No explicit caps filter before the unnamed preview flvmux.
        # Same issue as the main OMX path: on GStreamer 1.18 the flvmux template
        # lacks an alignment field, so any capsfilter carrying alignment=au causes
        # parse_launch to fail with "queue can't handle caps".  The preview branch
        # uses auto-link (! flvmux) which is fine here because the preview flvmux
        # is unnamed and only has one video input — no pad-request ambiguity.
        f'! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 leaky=downstream '
        f'! flvmux streamable=true '
        f'! rtmpsink location={preview_rtmp_url} sync=false async=false'
    )

    # ── OMX native RTMP: prepend flvmux definition ────────────────────────────
    # GStreamer 1.18 parse_launch resolves named-element references strictly
    # left-to-right.  "! mux.video" in the video chain fails unless the element
    # named "mux" (flvmux) has already been created earlier in the string.
    # We prepend the flvmux+rtmpsink chain so it appears before any mux.video /
    # mux.audio reference; audio and video chains then attach to its request pads.
    if encoder == 'omxh264videoenc' and protocol == 'rtmp' and audio_device:
        pipeline_str = (
            f'flvmux name=mux streamable=true '
            f'! rtmpsink location={rtmp_url} sync=false async=false '
            + pipeline_str
        )

    print(f"\nPipeline: {pipeline_str}\n", file=sys.stderr)

    pipeline = Gst.parse_launch(pipeline_str)

    # ── OMX native RTMP: relink in PAUSED + warm-up DROP probes ──────────────
    # Relink must happen in PAUSED state (before PLAYING) so that GStreamer
    # negotiates caps against pad *templates* rather than against the current
    # (runtime) caps.  Once the pipeline is PLAYING, mainvidq.src carries
    # stream-format=avc,alignment=au — GStreamer 1.18's flvmux accept_caps()
    # rejects alignment=au, so any link attempted during PLAYING returns
    # GST_PAD_LINK_NOFORMAT.  Relinking in PAUSED avoids this entirely.
    #
    # After the relink, the OMX encoder emits warm-up frames immediately when
    # the pipeline enters PLAYING.  Those frames arrive before h264parse has
    # extracted SPS/PPS and placed them in the output caps as codec_data.
    # Without codec_data, flvmux cannot write a valid AVC Decoder Configuration
    # Record — MediaMTX rejects the malformed FLV tag ("Could not write to resource").
    #
    # Fix: install BUFFER DROP probes on both mainvidq.src and mainaudq.src
    # right after the relink.  The probes discard all buffers until the video
    # probe detects the first IDR frame (no DELTA_UNIT flag).
    # Key insight: CAPS events (carrying codec_data) flow in-band with buffers
    # but are NOT intercepted by BUFFER probes.  So h264parse's CAPS event
    # (sent immediately before the IDR buffer) reaches flvmux unimpeded.
    # By the time the IDR buffer itself passes the probe, flvmux already has
    # codec_data and can write a valid AVC sequence header → MediaMTX happy.
    if encoder == 'omxh264videoenc' and protocol == 'rtmp' and audio_device:
        mainvidq = pipeline.get_by_name("mainvidq")
        mainaudq = pipeline.get_by_name("mainaudq")
        vidph    = pipeline.get_by_name("vidplaceholder")
        audph    = pipeline.get_by_name("audplaceholder")
        mux_el   = pipeline.get_by_name("mux")
        if not mainvidq or not mainaudq or not mux_el:
            print("❌ OMX relink: mainvidq, mainaudq, or mux element not found in pipeline",
                  file=sys.stderr)
            sys.exit(1)

        # ── video ──────────────────────────────────────────────────────────
        q_src = mainvidq.get_static_pad("src")
        if vidph:
            q_src.unlink(vidph.get_static_pad("sink"))
            pipeline.remove(vidph)
        # GStreamer 1.18 flvmux request-pad template is "video_%u".
        # Try "video_0" (explicit) then fall back to the template API.
        video_pad = mux_el.get_request_pad("video_0")
        if not video_pad:
            video_pad = mux_el.get_request_pad("video")
        if not video_pad:
            vtmpl = mux_el.get_pad_template("video_%u")
            if vtmpl:
                video_pad = mux_el.request_pad(vtmpl, None, None)
        if not video_pad:
            print("❌ OMX relink: flvmux has no 'video' request pad", file=sys.stderr)
            sys.exit(1)
        link_ret = q_src.link(video_pad)
        if link_ret != Gst.PadLinkReturn.OK:
            print(f"❌ OMX relink: video pad link returned {link_ret}", file=sys.stderr)
            sys.exit(1)
        print("✅ OMX relink: mainvidq.src → flvmux.video linked successfully", file=sys.stderr)

        # ── audio ──────────────────────────────────────────────────────────
        a_src = mainaudq.get_static_pad("src")
        if audph:
            a_src.unlink(audph.get_static_pad("sink"))
            pipeline.remove(audph)
        # GStreamer 1.18 flvmux request-pad template is "audio_%u".
        audio_pad = mux_el.get_request_pad("audio_0")
        if not audio_pad:
            audio_pad = mux_el.get_request_pad("audio")
        if not audio_pad:
            atmpl = mux_el.get_pad_template("audio_%u")
            if atmpl:
                audio_pad = mux_el.request_pad(atmpl, None, None)
        if not audio_pad:
            print("❌ OMX relink: flvmux has no 'audio' request pad", file=sys.stderr)
            sys.exit(1)
        link_ret = a_src.link(audio_pad)
        if link_ret != Gst.PadLinkReturn.OK:
            print(f"❌ OMX relink: audio pad link returned {link_ret}", file=sys.stderr)
            sys.exit(1)
        print("✅ OMX relink: mainaudq.src → flvmux.audio linked successfully", file=sys.stderr)

        # ── warm-up DROP probes ────────────────────────────────────────────
        # Drop all buffers on both pads until the video probe sees the first IDR
        # that also carries valid codec_data (SPS+PPS) in the current pad caps.
        #
        # OMX warm-up IDR frames are "headerless" — they carry no SPS/PPS NALUs,
        # so h264parse cannot extract codec_data from them.  Without codec_data,
        # flvmux writes an empty AVC Decoder Configuration Record.  MediaMTX
        # receives the malformed sequence header and closes the connection, causing
        # the "Failed to write data" error ~3 s later.
        #
        # codec_data detection strategy:
        #   An EVENT_DOWNSTREAM probe on mainvidq.src watches every CAPS event and
        #   sets _codec_data_seen the moment codec_data (SPS+PPS) arrives there.
        #   This is race-free: the CAPS event is serialised through the queue ahead
        #   of the IDR buffer, so by the time our BUFFER probe fires on the IDR,
        #   flvmux has already received the CAPS event carrying codec_data and can
        #   write a valid AVC Decoder Configuration Record before the first frame.
        #
        #   Using pad.get_current_caps() in the buffer probe is unreliable on some
        #   GStreamer 1.18 builds because the sticky-cap update and the probe
        #   callback share the same streaming thread but the ordering guarantee only
        #   holds for the queue's output thread — not for the probe invocation itself.
        #   The EVENT probe avoids this ambiguity entirely.
        _omx_warmup_done    = [False]
        _codec_data_seen    = [False]   # set by the CAPS event probe

        def _omx_caps_event_probe(pad, info):
            """EVENT probe — fires on every downstream event; detects codec_data."""
            event = info.get_event()
            if event.type != Gst.EventType.CAPS:
                return Gst.PadProbeReturn.OK   # not a CAPS event — pass through
            caps = event.parse_caps()
            if caps and caps.get_size() > 0:
                try:
                    val = caps.get_structure(0).get_value("codec_data")
                    if val is not None:
                        if not _codec_data_seen[0]:
                            print("📦 OMX: codec_data received in CAPS event — "
                                  "flvmux can now write AVC sequence header",
                                  file=sys.stderr)
                        _codec_data_seen[0] = True
                    else:
                        # Log every caps-without-codec_data so we can diagnose
                        # how many warm-up cycles the OMX encoder needs.
                        caps_str = caps.to_string()
                        print(f"⏳ OMX: CAPS without codec_data (still warming up): {caps_str}",
                              file=sys.stderr)
                except Exception as exc:
                    print(f"⚠️  OMX caps probe error: {exc}", file=sys.stderr)
            return Gst.PadProbeReturn.OK   # never block events

        def _omx_audio_warmup_drop(pad, info):
            if _omx_warmup_done[0]:
                return Gst.PadProbeReturn.REMOVE  # warm-up over — remove self
            return Gst.PadProbeReturn.DROP

        def _omx_video_warmup_drop(pad, info):
            if _omx_warmup_done[0]:
                return Gst.PadProbeReturn.REMOVE
            buf = info.get_buffer()
            is_keyframe = buf and not bool(buf.get_flags() & Gst.BufferFlags.DELTA_UNIT)
            if not is_keyframe:
                return Gst.PadProbeReturn.DROP  # P-frame / B-frame — discard
            if not _codec_data_seen[0]:
                # IDR arrived but codec_data hasn't been seen in a CAPS event yet.
                # Keep dropping — the next IDR will be checked again.
                return Gst.PadProbeReturn.DROP
            # First IDR after codec_data arrived — let it through.
            _omx_warmup_done[0] = True  # audio probe removes itself on next call
            print("🔑 OMX: first IDR after codec_data — stream is live", file=sys.stderr)
            return Gst.PadProbeReturn.REMOVE  # pass IDR through and remove self

        # Event probe must be installed first so it fires before any buffer probe.
        mainvidq.get_static_pad("src").add_probe(
            Gst.PadProbeType.EVENT_DOWNSTREAM, _omx_caps_event_probe)
        mainaudq.get_static_pad("src").add_probe(
            Gst.PadProbeType.BUFFER, _omx_audio_warmup_drop)
        mainvidq.get_static_pad("src").add_probe(
            Gst.PadProbeType.BUFFER, _omx_video_warmup_drop)
        print("⏳ OMX warm-up: CAPS+BUFFER probes on mainvidq, BUFFER probe on mainaudq",
              file=sys.stderr)

    # ── Programmatically disable element clock provision ───────────────────
    # v4l2src defaults to offering its USB-oscillator / kernel CLOCK_MONOTONIC
    # clock to the pipeline (via the provide_clock() virtual function).  When
    # GStreamer auto-selects the "best" clock, it can pick that instead of our
    # forced CLOCK_REALTIME, producing ~700+ ppm drift over long sessions.
    #
    # The "provide-clock" pipeline-string property is not available on all
    # GStreamer versions (hence not used in the parse string above).  Instead
    # we try to set it programmatically here — silently skipping any element
    # that doesn't support the property.  pipeline.use_clock() below is the
    # primary defence; this is a belt-and-suspenders supplement.
    _el_iter = pipeline.iterate_elements()
    while True:
        _res, _el = _el_iter.next()
        if _res != Gst.IteratorResult.OK:
            break
        try:
            _el.set_property("provide-clock", False)
            print(f"🕒 Disabled clock provision on element: {_el.get_name()}", file=sys.stderr)
        except Exception:
            pass  # Element doesn't expose the property on this GStreamer version — skip

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

    # ── RTSP audio-disabled guard ──────────────────────────────────────────────
    # rtspsrc always creates BOTH a video and an audio RTP src pad for streams
    # that carry audio (like /main/av).  The static "rtspsrc ! decodebin" link
    # only connects the video RTP pad to decodebin's single sink; the audio RTP
    # pad has no peer.  When rtspsrc pushes audio buffers on the unlinked pad,
    # GStreamer returns GST_FLOW_NOT_LINKED which rtspsrc treats as a fatal error
    # and tears down the entire pipeline.
    #
    # Fix: install a permanent DROP probe on every audio RTP src pad emitted by
    # rtspsrc so those pushes return GST_FLOW_OK before GStreamer checks linkage.
    # This is identical in spirit to the NDI audio guard above.
    if input_type == "rtsp" and not use_rtsp_audio:
        # gst-parse-launch names the first rtspsrc element "rtspsrc0".
        rtsp_guard_el = pipeline.get_by_name("rtspsrc0")
        if not rtsp_guard_el:
            # Fallback: iterate all elements and find by factory name.
            it = pipeline.iterate_elements()
            while True:
                res, el = it.next()
                if res != Gst.IteratorResult.OK:
                    break
                if el.get_factory() and el.get_factory().get_name() == "rtspsrc":
                    rtsp_guard_el = el
                    break

        if rtsp_guard_el:
            def _on_rtsp_src_pad_guard(element, pad):
                pad_caps = pad.get_current_caps() or pad.query_caps(None)
                if not pad_caps or pad_caps.get_size() == 0:
                    return
                struct = pad_caps.get_structure(0)
                # RTP audio pads have caps: application/x-rtp, media=(string)audio
                if struct and struct.get_string("media") == "audio":
                    pad.add_probe(
                        Gst.PadProbeType.BUFFER,
                        lambda p, info: Gst.PadProbeReturn.DROP,
                    )
                    print("🔇 RTSP audio RTP pad: DROP probe installed (audio not used)", file=sys.stderr)

            rtsp_guard_el.connect("pad-added", _on_rtsp_src_pad_guard)
            print("🔇 RTSP audio guard: pad-added handler installed on rtspsrc", file=sys.stderr)
        else:
            print("⚠️  RTSP audio guard: rtspsrc element not found in pipeline", file=sys.stderr)

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

                    # ── Detect NDI HX3 (compressed) vs standard (raw) ──────────
                    # ndisrcdemux sets caps on the video pad at add-time.
                    # Standard NDI → video/x-raw   (UYVY, 4:2:2, various sizes)
                    # NDI HX / HX2  → video/x-h264
                    # NDI HX3       → video/x-h265
                    # For compressed formats we insert parse + hardware decoder
                    # before the raw-video processing chain.
                    pad_caps = pad.get_current_caps() or pad.query_caps(None)
                    media_type = ""
                    if pad_caps and pad_caps.get_size() > 0:
                        media_type = pad_caps.get_structure(0).get_name()
                    print(f"🎥 NDI video media type: {media_type}", file=sys.stderr)

                    is_h264 = media_type.startswith("video/x-h264")
                    is_h265 = media_type.startswith("video/x-h265")
                    is_compressed = is_h264 or is_h265

                    # ── Create elements ────────────────────────────────────────
                    parse_el  = None
                    decode_el = None
                    if is_h264:
                        parse_el  = Gst.ElementFactory.make("h264parse",  None)
                        # The Rockchip GStreamer plugin exposes a single generic
                        # hardware decoder named "mppvideodec" (handles H.264,
                        # H.265, JPEG, VP8, VP9).  Format-specific names like
                        # "mpph264dec" do NOT exist — always try mppvideodec first
                        # and fall back to the libav software decoder.
                        decode_el = (Gst.ElementFactory.make("mppvideodec", None)
                                     or Gst.ElementFactory.make("avdec_h264", None))
                        hw = decode_el.get_factory().get_name() if decode_el else "none"
                        print(f"🎥 NDI HX/HX2 (H.264) — decoder: {hw}", file=sys.stderr)
                    elif is_h265:
                        parse_el  = Gst.ElementFactory.make("h265parse",  None)
                        decode_el = (Gst.ElementFactory.make("mppvideodec", None)
                                     or Gst.ElementFactory.make("avdec_h265", None))
                        hw = decode_el.get_factory().get_name() if decode_el else "none"
                        print(f"🎥 NDI HX3 (H.265) — decoder: {hw}", file=sys.stderr)

                    vconv  = Gst.ElementFactory.make("videoconvert", None)
                    vscale = Gst.ElementFactory.make("videoscale",   None)
                    vcaps  = Gst.ElementFactory.make("capsfilter",   None)

                    base_elements = [vconv, vscale, vcaps]
                    decode_elements = ([parse_el, decode_el] if is_compressed else [])
                    all_elements = decode_elements + base_elements

                    if not all(all_elements):
                        missing = [n for n, e in zip(
                            (["h26Xparse", "decoder"] if is_compressed else []) + ["vconv", "vscale", "vcaps"],
                            all_elements) if not e]
                        print(f"❌ Could not create NDI video chain elements: {missing}", file=sys.stderr)
                        _ndi_video_linked[0] = True
                        return False

                    # Deliberately NO framerate constraint:
                    #   videorate drop-only cannot bridge fractional NDI framerates
                    #   (29.97, 59.94…) to integer targets and causes NOT_NEGOTIATED.
                    #   The muxer/encoder use buffer timestamps; framerate in caps is
                    #   not required.  The preview branch has its own videorate(1fps).
                    vcaps.set_property("caps",
                        Gst.Caps.from_string(f"video/x-raw,width={width},height={height}"))

                    for el in all_elements:
                        pl.add(el)

                    # Chain: [parse → decoder →] vconv → vscale → capsfilter(W×H) → ndi_in_q
                    #
                    # Use link_full(CHECK_NOTHING) throughout: freshly-created elements
                    # have no negotiated caps yet, and GStreamer's link-time template
                    # check can spuriously return NOFORMAT when upstream elements have
                    # already fixed some fields.  Real negotiation happens on first buffer.
                    def _link(src_pad, sink_pad, label):
                        ret = src_pad.link_full(sink_pad, Gst.PadLinkCheck.NOTHING)
                        if ret != Gst.PadLinkReturn.OK:
                            print(f"❌ NDI video link FAILED [{label}]: {ret}", file=sys.stderr)
                        else:
                            print(f"🔗 NDI video link OK  [{label}]", file=sys.stderr)
                        return ret

                    first_sink = (parse_el.get_static_pad("sink") if is_compressed
                                  else vconv.get_static_pad("sink"))
                    entry_label = "demux→parse" if is_compressed else "demux→vconv"
                    _link(pad, first_sink, entry_label)

                    if is_compressed:
                        _link(parse_el.get_static_pad("src"),  decode_el.get_static_pad("sink"), "parse→decoder")
                        _link(decode_el.get_static_pad("src"), vconv.get_static_pad("sink"),     "decoder→vconv")

                    _link(vconv.get_static_pad("src"),  vscale.get_static_pad("sink"),    "vconv→vscale")
                    _link(vscale.get_static_pad("src"), vcaps.get_static_pad("sink"),     "vscale→vcaps")
                    _link(vcaps.get_static_pad("src"),  ndi_in_q.get_static_pad("sink"),  "vcaps→ndi_in_q")

                    for el in all_elements:
                        el.sync_state_with_parent()

                    mode = "HX3 (H.265)" if is_h265 else "HX/HX2 (H.264)" if is_h264 else "standard (raw)"
                    print(f"🎥 NDI video chain built and linked dynamically [{mode}]", file=sys.stderr)

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
    #
    # We call both set_clock() AND use_clock() for belt-and-suspenders robustness:
    #   set_clock() — distributes the clock to all existing child elements.
    #   use_clock() — sets GstPipeline's internal priv->use_clock = TRUE flag,
    #                 which disables auto-selection when the pipeline enters PLAYING.
    #                 Without this flag, GStreamer may override our clock with the
    #                 "best" clock it finds from elements (e.g. v4l2src's
    #                 USB-oscillator / CLOCK_MONOTONIC clock), causing ~700+ ppm drift.
    pipeline.set_clock(_system_clock)
    try:
        pipeline.use_clock(_system_clock)
        print(f"🕒 Pipeline clock forced via set_clock+use_clock (clock-type={_system_clock.get_property('clock-type')})", file=sys.stderr)
    except AttributeError:
        # Older GStreamer Python bindings may not expose use_clock() — set_clock()
        # and provide-clock=false on v4l2src are sufficient in that case.
        print(f"🕒 Pipeline clock attached via set_clock() (clock-type={_system_clock.get_property('clock-type')}) [use_clock() unavailable]", file=sys.stderr)

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

    # Poll every 2 s — matches the Puppeteer screenshot interval so the pipeline
    # picks up each new PNG within ~2 s of it being written.  gdkpixbufoverlay
    # leaks the old GdkPixbuf on each reload, so we still gate the set_property
    # call on an actual mtime change to avoid pointless reloads on static overlays.
    if overlay_element:
        GLib.timeout_add(2000, check_png_update)

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

    # ── Verify the pipeline is using our CLOCK_REALTIME clock after PLAYING ──
    # GStreamer re-evaluates clock selection when transitioning to PLAYING.
    # If any element snuck in a different clock, catch it here and re-force ours.
    _actual_clock = pipeline.get_clock()
    if _actual_clock is None:
        print("⚠️  pipeline.get_clock() returned None — clock not yet distributed", file=sys.stderr)
    elif _actual_clock != _system_clock:
        _actual_type = _actual_clock.get_property("clock-type") if hasattr(_actual_clock, "get_property") else "unknown"
        print(f"⚠️  Clock overridden by pipeline! Got clock-type={_actual_type} — forcing back to CLOCK_REALTIME", file=sys.stderr)
        pipeline.set_clock(_system_clock)
        try:
            pipeline.use_clock(_system_clock)
        except AttributeError:
            pass
    else:
        print(f"✅ Clock verified post-PLAYING: pipeline is using our CLOCK_REALTIME system clock", file=sys.stderr)

    # ── Periodic drift monitor ────────────────────────────────────────────
    # Every 60 s, logs THREE independent drift measurements:
    #
    #  1. Running-time drift (PRIMARY) — clock.get_time() - pipeline.get_base_time()
    #     This reads the pipeline's TRUE running time directly from the clock,
    #     bypassing query_position() entirely.  It is immune to the alsasrc
    #     sample-counter artifact (see below).  Should be ≈0 when CLOCK_REALTIME.
    #
    #  2. query_position drift (SECONDARY / DIAGNOSTIC) — reports what GStreamer
    #     considers the pipeline's "current position".  For video-only pipelines
    #     this matches running-time.  For pipelines that contain alsasrc, GStreamer
    #     routes the position query through the audio branch: alsasrc tracks its
    #     position by counting captured samples from the USB audio oscillator.
    #     That oscillator runs ~715 ppm fast, so query_position returns an inflated
    #     value — but the actual audio PTS in the stream are still REALTIME-based
    #     (assigned by do-timestamp=true from the pipeline clock), so the stream
    #     is fine.  Non-zero here with zero running-time drift = monitoring artifact.
    #
    #  3. Clock vs wall — raw clock value vs time.time()*1e9.
    #     CLOCK_REALTIME: delta ≈ 0 ✅.  CLOCK_MONOTONIC: huge negative ⚠️.
    _start_wall = time.time()

    def _log_drift():
        wall_elapsed = time.time() - _start_wall
        if wall_elapsed <= 0:
            return True

        active_clock = pipeline.get_clock()
        clock_vs_wall = ""
        rt_str        = ""

        if active_clock:
            clock_ns = active_clock.get_time()
            wall_ns  = int(time.time() * 1e9)
            ck_delta_s = (clock_ns - wall_ns) / 1e9

            # ── Primary: running_time = clock_now - base_time ─────────────────
            # Reads directly from the pipeline clock — unaffected by element
            # position counters (e.g. alsasrc USB oscillator sample counting).
            base_time = pipeline.get_base_time()
            if base_time > 0 and clock_ns >= base_time:
                rt_ns    = clock_ns - base_time
                rt_s     = rt_ns / 1e9
                rt_drift = rt_s - wall_elapsed
                rt_ppm   = rt_drift / wall_elapsed * 1e6
                rt_str   = f"rt={rt_s:.3f}s Δ{rt_drift:+.3f}s ({rt_ppm:+.1f} ppm)"

            # ── Clock type sanity check ───────────────────────────────────────
            if abs(ck_delta_s) < 120:
                clock_vs_wall = f"[clock≈wall Δ{ck_delta_s:+.3f}s ✅]"
            else:
                clock_vs_wall = f"[clock≠wall Δ{ck_delta_s:+.0f}s ⚠️ MONOTONIC?]"

        # ── Secondary: query_position (may reflect alsasrc USB oscillator) ─────
        _ok, position = pipeline.query_position(Gst.Format.TIME)
        pos_str = ""
        if _ok and position >= 0:
            gst_s    = position / 1e9
            pos_drift = gst_s - wall_elapsed
            pos_ppm  = pos_drift / wall_elapsed * 1e6
            pos_str  = f"  pos={gst_s:.3f}s Δ{pos_drift:+.3f}s ({pos_ppm:+.1f} ppm)"

        print(
            f"🕒 Drift check — Wall: {wall_elapsed:.3f}s  "
            f"{rt_str}{pos_str}  {clock_vs_wall}",
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

