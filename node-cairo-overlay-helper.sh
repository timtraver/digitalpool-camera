#!/bin/bash
# Node-Cairo Graphics Overlay Helper
# Runs Node.js graphics generator streaming raw RGBA via pipe to GStreamer compositor

CAMERA_DEVICE=$1
WIDTH=$2
HEIGHT=$3
FRAMERATE=$4
BITRATE=$5
SRT_PORT=$6
OVERLAY_TEXT=$7
SHOW_TIMESTAMP=$8

# Path to Node.js graphics script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SCRIPT="$SCRIPT_DIR/node-graphics-stream.js"
OVERLAY_FPS=2

echo "🎨 Starting Node-Cairo overlay pipeline (RGBA pipe mode)..."
echo "Camera: $CAMERA_DEVICE"
echo "Resolution: ${WIDTH}x${HEIGHT}@${FRAMERATE}fps"
echo "SRT Port: $SRT_PORT"
echo "Graphics Script: $NODE_SCRIPT"
echo "Overlay FPS: $OVERLAY_FPS"

# Calculate RGBA frame size for blocksize
FRAME_SIZE=$((WIDTH * HEIGHT * 4))
echo "✅ Starting pipeline with Node.js RGBA pipe..."
echo "📊 RGBA frame size: $FRAME_SIZE bytes"

# Build GStreamer pipeline with compositor
# Node.js writes raw RGBA frames to stdout, piped to fdsrc via process substitution
# blocksize must match exactly one frame so fdsrc delivers complete frames
# rawvideoparse ensures GStreamer correctly identifies frame boundaries
node "$NODE_SCRIPT" "$WIDTH" "$HEIGHT" "$OVERLAY_FPS" "pipe" "" | \
gst-launch-1.0 \
  v4l2src device="$CAMERA_DEVICE" do-timestamp=true ! \
  image/jpeg,width=$WIDTH,height=$HEIGHT,framerate=$FRAMERATE/1 ! \
  jpegdec ! \
  nvvidconv ! \
  video/x-raw\(memory:NVMM\),format=NV12 ! \
  tee name=t \
  \
  t. ! queue max-size-buffers=2 leaky=downstream ! \
  nvvidconv ! \
  video/x-raw,format=RGBA ! \
  compositor name=mix sink_0::zorder=0 sink_1::zorder=1 sink_1::alpha=1.0 ! \
  nvvidconv ! \
  video/x-raw\(memory:NVMM\) ! \
  nvv4l2h264enc bitrate=$BITRATE preset-level=1 profile=0 iframeinterval=15 insert-sps-pps=true maxperf-enable=true ! \
  video/x-h264,stream-format=byte-stream ! \
  h264parse config-interval=-1 ! \
  queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 leaky=downstream ! \
  mpegtsmux alignment=7 ! \
  srtserversink uri=srt://0.0.0.0:$SRT_PORT latency=125 sync=false \
  \
  fdsrc fd=0 blocksize=$FRAME_SIZE ! \
  rawvideoparse format=rgba width=$WIDTH height=$HEIGHT framerate=${OVERLAY_FPS}/1 ! \
  queue max-size-buffers=2 leaky=downstream ! \
  mix. \
  \
  t. ! queue max-size-buffers=10 leaky=downstream ! \
  nvvidconv ! \
  video/x-raw,format=I420 ! \
  videoscale ! \
  video/x-raw,width=1280,height=720 ! \
  videoconvert ! \
  jpegenc quality=75 ! \
  multipartmux boundary=--jpgboundary ! \
  tcpserversink host=0.0.0.0 port=8555 sync=false recover-policy=keyframe

echo "🛑 Pipeline exited"

