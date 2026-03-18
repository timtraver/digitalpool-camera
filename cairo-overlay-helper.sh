#!/bin/bash
# GStreamer pipeline with cairooverlay for DYNAMIC graphics overlay
# This script creates a Python helper that draws graphics on every frame

CAMERA_DEVICE=$1
WIDTH=$2
HEIGHT=$3
FRAMERATE=$4
BITRATE=$5
SRT_PORT=$6
PNG_PATH=${7:-"/tmp/graphics-overlay.png"}
OVERLAY_TEXT=${8:-""}
SHOW_TIMESTAMP=${9:-"false"}

echo "🎨 Starting stream with Cairo graphics overlay (DYNAMIC)..."
echo "Camera: $CAMERA_DEVICE"
echo "Resolution: ${WIDTH}x${HEIGHT}@${FRAMERATE}fps"
echo "SRT Port: $SRT_PORT"
echo "Text Overlay: $OVERLAY_TEXT"
echo "Show Timestamp: $SHOW_TIMESTAMP"

# Note: cairooverlay requires a Python script with GStreamer bindings
# For now, we'll use the PNG overlay approach but with better text overlays
# TODO: Implement full Python-based cairooverlay when GStreamer Python bindings are available

# GStreamer pipeline with optimized settings and smaller fonts
exec gst-launch-1.0 -v \
  v4l2src device=$CAMERA_DEVICE do-timestamp=true \
  ! image/jpeg,width=$WIDTH,height=$HEIGHT,framerate=$FRAMERATE/1 \
  ! jpegdec \
  ! videoconvert \
  ! gdkpixbufoverlay location=$PNG_PATH overlay-width=$WIDTH overlay-height=$HEIGHT \
  ! videoconvert \
  $(if [ -n "$OVERLAY_TEXT" ]; then echo "! textoverlay text=\"$OVERLAY_TEXT\" valignment=bottom halignment=left font-desc=\"Sans Bold 24\" color=4294967295 xpad=20 ypad=20 shaded-background=true"; fi) \
  $(if [ "$SHOW_TIMESTAMP" = "true" ]; then echo "! clockoverlay valignment=bottom halignment=right font-desc=\"Sans Bold 24\" color=4294967295 time-format=\"%Y-%m-%d %H:%M:%S\" xpad=20 ypad=20 shaded-background=true"; fi) \
  ! tee name=t \
  \
  t. ! queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 leaky=downstream ! nvvidconv \
  ! 'video/x-raw(memory:NVMM)' \
  ! nvv4l2h264enc bitrate=$BITRATE preset-level=1 profile=0 iframeinterval=15 insert-sps-pps=true maxperf-enable=true \
  ! 'video/x-h264,stream-format=byte-stream' \
  ! h264parse config-interval=-1 \
  ! queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 leaky=downstream \
  ! mpegtsmux alignment=7 \
  ! srtserversink uri=srt://:$SRT_PORT latency=125 sync=false \
  \
  t. ! queue max-size-buffers=10 leaky=downstream \
  ! videoscale \
  ! video/x-raw,width=1280,height=720 \
  ! jpegenc quality=75 \
  ! multipartmux boundary=--jpgboundary \
  ! tcpserversink host=0.0.0.0 port=8555 sync=false recover-policy=keyframe

