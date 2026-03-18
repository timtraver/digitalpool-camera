#!/bin/bash
# Node-Cairo Graphics Overlay Helper
# Runs Node.js graphics generator and pipes to GStreamer compositor

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

echo "🎨 Starting Node-Cairo overlay pipeline..."
echo "Camera: $CAMERA_DEVICE"
echo "Resolution: ${WIDTH}x${HEIGHT}@${FRAMERATE}fps"
echo "SRT Port: $SRT_PORT"
echo "Graphics Script: $NODE_SCRIPT"

# Start Node.js graphics generator in background, piping to a named pipe
GRAPHICS_PIPE="/tmp/node-graphics-pipe"
rm -f "$GRAPHICS_PIPE"
mkfifo "$GRAPHICS_PIPE"

# Start Node.js graphics generator
node "$NODE_SCRIPT" "$WIDTH" "$HEIGHT" "$FRAMERATE" > "$GRAPHICS_PIPE" &
NODE_PID=$!

echo "✅ Node.js graphics generator started (PID: $NODE_PID)"

# Build GStreamer pipeline with compositor
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
  fdsrc fd=3 do-timestamp=true ! \
  video/x-raw,format=RGBA,width=$WIDTH,height=$HEIGHT,framerate=$FRAMERATE/1 ! \
  videoconvert ! \
  queue ! \
  mix. \
  \
  t. ! queue max-size-buffers=10 leaky=downstream ! \
  nvvidconv ! \
  video/x-raw,format=I420 ! \
  videoscale ! \
  video/x-raw,width=1280,height=720 ! \
  jpegenc quality=75 ! \
  multipartmux boundary=--jpgboundary ! \
  tcpserversink host=0.0.0.0 port=8555 sync=false recover-policy=keyframe \
  3< "$GRAPHICS_PIPE"

# Cleanup
echo "🛑 Stopping Node.js graphics generator..."
kill $NODE_PID 2>/dev/null
rm -f "$GRAPHICS_PIPE"

