#!/bin/bash
# GStreamer pipeline with DYNAMIC PNG overlay using multifilesrc
# This continuously reads the PNG file to get updates

CAMERA_DEVICE=$1
WIDTH=$2
HEIGHT=$3
FRAMERATE=$4
BITRATE=$5
SRT_PORT=$6
PNG_PATH=${7:-"/tmp/graphics-overlay.png"}
OVERLAY_TEXT=${8:-""}
SHOW_TIMESTAMP=${9:-"false"}

echo "🎨 Starting stream with DYNAMIC PNG graphics overlay..."
echo "Camera: $CAMERA_DEVICE"
echo "Resolution: ${WIDTH}x${HEIGHT}@${FRAMERATE}fps"
echo "SRT Port: $SRT_PORT"
echo "PNG Overlay: $PNG_PATH (dynamic)"
echo "Text Overlay: $OVERLAY_TEXT"
echo "Show Timestamp: $SHOW_TIMESTAMP"

# GStreamer pipeline with compositor for dynamic PNG overlay
# Camera on sink_0 (bottom layer), PNG overlay on sink_1 (top layer)
exec gst-launch-1.0 -v \
  compositor name=mix background=black \
    sink_0::zorder=0 sink_0::alpha=1.0 \
    sink_1::zorder=1 sink_1::alpha=1.0 \
  ! videoconvert \
  $(if [ -n "$OVERLAY_TEXT" ]; then echo "! textoverlay text=\"$OVERLAY_TEXT\" valignment=bottom halignment=left font-desc=\"Sans Bold 32\" color=4294967295 xpad=20 ypad=20 shaded-background=true"; fi) \
  $(if [ "$SHOW_TIMESTAMP" = "true" ]; then echo "! clockoverlay valignment=bottom halignment=right font-desc=\"Sans Bold 32\" color=4294967295 time-format=\"%Y-%m-%d %H:%M:%S\" xpad=20 ypad=20 shaded-background=true"; fi) \
  ! tee name=t \
  \
  v4l2src device=$CAMERA_DEVICE do-timestamp=true \
  ! image/jpeg,width=$WIDTH,height=$HEIGHT,framerate=$FRAMERATE/1 \
  ! jpegdec \
  ! videoconvert \
  ! video/x-raw,width=$WIDTH,height=$HEIGHT,format=RGBA \
  ! mix.sink_0 \
  \
  multifilesrc location=$PNG_PATH loop=true caps="image/png,framerate=2/1" \
  ! pngdec \
  ! videoconvert \
  ! video/x-raw,width=$WIDTH,height=$HEIGHT,format=RGBA \
  ! mix.sink_1 \
  \
  t. ! queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 leaky=downstream ! videoconvert \
  ! 'video/x-raw,format=I420' \
  ! x264enc speed-preset=ultrafast tune=zerolatency bitrate=$((BITRATE/1000)) key-int-max=30 \
  ! 'video/x-h264,stream-format=byte-stream' \
  ! h264parse config-interval=-1 \
  ! queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 leaky=downstream \
  ! mpegtsmux alignment=7 \
  ! srtsink uri="srt://:$SRT_PORT" wait-for-connection=false latency=125 \
  \
  t. ! queue max-size-buffers=10 leaky=downstream \
  ! videoscale \
  ! video/x-raw,width=1280,height=720 \
  ! jpegenc quality=75 \
  ! multipartmux boundary=--jpgboundary \
  ! tcpserversink host=0.0.0.0 port=8555 sync=false recover-policy=keyframe

