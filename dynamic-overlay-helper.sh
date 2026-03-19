#!/bin/bash
# GStreamer pipeline with dynamic PNG overlay using multifilesrc
# This reads numbered PNG files in sequence for dynamic updates

CAMERA_DEVICE=$1
WIDTH=$2
HEIGHT=$3
FRAMERATE=$4
BITRATE=$5
SRT_PORT=$6
PNG_DIR=${7:-"/tmp"}

echo "🎨 Starting stream with dynamic PNG graphics overlay..."
echo "Camera: $CAMERA_DEVICE"
echo "Resolution: ${WIDTH}x${HEIGHT}@${FRAMERATE}fps"
echo "SRT Port: $SRT_PORT"
echo "PNG Directory: $PNG_DIR"

# GStreamer pipeline with compositor for dynamic overlay
# Camera video on bottom (zorder=0), PNG overlay on top (zorder=1)
exec gst-launch-1.0 -v \
  compositor name=mix background=black \
    sink_0::zorder=0 sink_0::alpha=1.0 \
    sink_1::zorder=1 sink_1::alpha=1.0 \
  ! videoconvert \
  ! tee name=t \
  \
  v4l2src device=$CAMERA_DEVICE do-timestamp=true \
  ! image/jpeg,width=$WIDTH,height=$HEIGHT,framerate=$FRAMERATE/1 \
  ! jpegdec \
  ! videoconvert \
  ! videorate \
  ! video/x-raw,width=$WIDTH,height=$HEIGHT,framerate=$FRAMERATE/1 \
  ! mix.sink_0 \
  \
  multifilesrc location=$PNG_DIR/graphics-overlay-%06d.png loop=true start-index=0 stop-index=999999 caps="image/png,framerate=2/1" \
  ! pngdec \
  ! imagefreeze \
  ! videoconvert \
  ! videorate \
  ! video/x-raw,width=$WIDTH,height=$HEIGHT,framerate=2/1 \
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

