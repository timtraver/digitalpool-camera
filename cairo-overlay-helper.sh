#!/bin/bash
# GStreamer pipeline with cairooverlay for graphics
# This uses a Python script to draw graphics via Cairo

CAMERA_DEVICE=$1
WIDTH=$2
HEIGHT=$3
FRAMERATE=$4
BITRATE=$5
SRT_PORT=$6
GRAPHICS_SCRIPT=${7:-"./cairo-graphics.py"}

echo "🎨 Starting stream with Cairo graphics overlay..."
echo "Camera: $CAMERA_DEVICE"
echo "Resolution: ${WIDTH}x${HEIGHT}@${FRAMERATE}fps"
echo "SRT Port: $SRT_PORT"
echo "Graphics Script: $GRAPHICS_SCRIPT"

# GStreamer pipeline with cairooverlay
# The cairooverlay element calls a Python script to draw graphics
exec gst-launch-1.0 -v \
  v4l2src device=$CAMERA_DEVICE do-timestamp=true \
  ! image/jpeg,width=$WIDTH,height=$HEIGHT,framerate=$FRAMERATE/1 \
  ! jpegdec \
  ! videoconvert \
  ! video/x-raw,format=BGRA \
  ! cairooverlay name=overlay \
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

