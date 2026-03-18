#!/bin/bash
# Helper script to run GStreamer compositor with multiple sources
# This is needed because the compositor requires a complex pipeline structure

CAMERA_DEVICE=$1
WIDTH=$2
HEIGHT=$3
FRAMERATE=$4
BITRATE=$5
SRT_PORT=$6
ALPHA=${7:-1.0}

echo "🎨 Starting compositor with graphics overlay..."
echo "Camera: $CAMERA_DEVICE"
echo "Resolution: ${WIDTH}x${HEIGHT}@${FRAMERATE}fps"
echo "SRT Port: $SRT_PORT"
echo "Graphics Alpha: $ALPHA"

# Run GStreamer compositor pipeline
# This composites camera video (bottom) with graphics from TCP (top)
# Key fixes:
# - Add do-timestamp=true to both sources for proper timing
# - Add videorate to ensure consistent framerates
# - Add mpegtsmux to properly packetize H.264 for SRT (fixes payload size errors)
# - Both sources upscaled to same framerate for proper blending
# - Added tee to split output for both SRT and preview
exec gst-launch-1.0 -v \
  compositor name=mix \
    sink_0::zorder=0 sink_0::alpha=1.0 sink_0::xpos=0 sink_0::ypos=0 sink_0::width=$WIDTH sink_0::height=$HEIGHT \
    sink_1::zorder=10 sink_1::alpha=$ALPHA sink_1::xpos=0 sink_1::ypos=0 sink_1::width=$WIDTH sink_1::height=$HEIGHT \
  ! 'video/x-raw,width='$WIDTH',height='$HEIGHT',framerate='$FRAMERATE'/1' \
  ! videoconvert \
  ! tee name=t \
  \
  t. ! queue ! nvvidconv \
  ! 'video/x-raw(memory:NVMM)' \
  ! nvv4l2h264enc bitrate=$BITRATE \
  ! h264parse \
  ! mpegtsmux \
  ! srtserversink uri=srt://:$SRT_PORT \
  \
  t. ! queue max-size-buffers=10 leaky=downstream \
  ! videoscale \
  ! 'video/x-raw,width=1280,height=720' \
  ! jpegenc quality=75 \
  ! multipartmux boundary=--jpgboundary \
  ! tcpserversink host=0.0.0.0 port=8555 sync=false recover-policy=keyframe \
  \
  v4l2src device=$CAMERA_DEVICE do-timestamp=true \
  ! image/jpeg,width=$WIDTH,height=$HEIGHT,framerate=$FRAMERATE/1 \
  ! jpegdec \
  ! videoconvert \
  ! 'video/x-raw,format=RGBA,width='$WIDTH',height='$HEIGHT \
  ! videorate \
  ! 'video/x-raw,framerate='$FRAMERATE'/1' \
  ! queue \
  ! mix.sink_0 \
  \
  tcpclientsrc host=127.0.0.1 port=8556 do-timestamp=true \
  ! 'video/x-raw,format=RGBA,width='$WIDTH',height='$HEIGHT',framerate=5/1' \
  ! videorate \
  ! 'video/x-raw,framerate='$FRAMERATE'/1' \
  ! queue \
  ! mix.sink_1

