#!/bin/bash
# GStreamer pipeline with gdkpixbufoverlay for PNG graphics
# This overlays a dynamically updated PNG file onto the video stream

CAMERA_DEVICE=$1
WIDTH=$2
HEIGHT=$3
FRAMERATE=$4
BITRATE=$5
SRT_PORT=$6
PNG_PATH=${7:-"/tmp/graphics-overlay.png"}

echo "🎨 Starting stream with PNG graphics overlay..."
echo "Camera: $CAMERA_DEVICE"
echo "Resolution: ${WIDTH}x${HEIGHT}@${FRAMERATE}fps"
echo "SRT Port: $SRT_PORT"
echo "PNG Overlay: $PNG_PATH"

# GStreamer pipeline with gdkpixbufoverlay
# The gdkpixbufoverlay element overlays a PNG file
# It automatically reloads the file when it changes
exec gst-launch-1.0 -v \
  v4l2src device=$CAMERA_DEVICE do-timestamp=true \
  ! image/jpeg,width=$WIDTH,height=$HEIGHT,framerate=$FRAMERATE/1 \
  ! jpegdec \
  ! videoconvert \
  ! gdkpixbufoverlay location=$PNG_PATH overlay-width=$WIDTH overlay-height=$HEIGHT \
  ! videoconvert \
  ! tee name=t \
  \
  t. ! queue ! nvvidconv \
  ! video/x-raw(memory:NVMM) \
  ! nvv4l2h264enc bitrate=$BITRATE \
  ! h264parse \
  ! mpegtsmux \
  ! srtserversink uri=srt://:$SRT_PORT \
  \
  t. ! queue max-size-buffers=10 leaky=downstream \
  ! videoscale \
  ! video/x-raw,width=1280,height=720 \
  ! jpegenc quality=75 \
  ! multipartmux boundary=--jpgboundary \
  ! tcpserversink host=0.0.0.0 port=8555 sync=false recover-policy=keyframe

