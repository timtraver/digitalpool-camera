#!/bin/bash
# Node-Cairo Graphics Overlay Helper
# Runs Node.js graphics generator in PNG mode with gdkpixbufoverlay

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
PNG_PATH="/tmp/graphics-overlay-node.png"

echo "🎨 Starting Node-Cairo overlay pipeline (PNG mode)..."
echo "Camera: $CAMERA_DEVICE"
echo "Resolution: ${WIDTH}x${HEIGHT}@${FRAMERATE}fps"
echo "SRT Port: $SRT_PORT"
echo "Graphics Script: $NODE_SCRIPT"
echo "PNG Path: $PNG_PATH"

# Start Node.js graphics generator in background (PNG mode)
node "$NODE_SCRIPT" "$WIDTH" "$HEIGHT" "2" "png" "$PNG_PATH" &
NODE_PID=$!

echo "✅ Node.js graphics generator started (PID: $NODE_PID)"

# Wait for the first PNG to be generated
echo "⏳ Waiting for PNG file to be created..."
sleep 2

# Verify PNG exists
if [ ! -f "$PNG_PATH" ]; then
  echo "❌ ERROR: PNG file not created at $PNG_PATH"
  kill $NODE_PID 2>/dev/null
  exit 1
fi

echo "✅ PNG file ready: $PNG_PATH"

# Build GStreamer pipeline with compositor (overlay graphics on camera feed)
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
  multifilesrc location="$PNG_PATH" loop=true caps="image/png,framerate=2/1" ! \
  pngdec ! \
  videoconvert ! \
  video/x-raw,format=RGBA,width=$WIDTH,height=$HEIGHT ! \
  queue ! \
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

# Cleanup
echo "🛑 Stopping Node.js graphics generator..."
kill $NODE_PID 2>/dev/null
rm -f "$PNG_PATH"

