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
exec gst-launch-1.0 \
  compositor name=mix \
    sink_0::zorder=0 \
    sink_1::zorder=1 sink_1::alpha=$ALPHA \
  ! videoconvert \
  ! nvvidconv \
  ! 'video/x-raw(memory:NVMM)' \
  ! nvv4l2h264enc bitrate=$BITRATE \
  ! h264parse \
  ! mpegtsmux \
  ! srtserversink uri=srt://:$SRT_PORT \
  \
  v4l2src device=$CAMERA_DEVICE do-timestamp=true \
  ! image/jpeg,width=$WIDTH,height=$HEIGHT,framerate=$FRAMERATE/1 \
  ! jpegdec \
  ! videoconvert \
  ! 'video/x-raw,format=RGBA' \
  ! videorate \
  ! 'video/x-raw,framerate='$FRAMERATE'/1' \
  ! queue \
  ! mix.sink_0 \
  \
  tcpclientsrc host=127.0.0.1 port=8556 do-timestamp=true \
  ! 'video/x-raw,format=RGBA,width='$WIDTH',height='$HEIGHT',framerate=5/1' \
  ! videorate \
  ! 'video/x-raw,framerate=5/1' \
  ! queue \
  ! mix.sink_1

