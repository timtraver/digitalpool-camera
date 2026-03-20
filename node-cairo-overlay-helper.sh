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
FONT_SIZE=${9:-48}
OVERLAY_COLOR=${10:-0xFFFFFFFF}
OVERLAY_BG=${11:-transparent}

# Path to Node.js graphics script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SCRIPT="$SCRIPT_DIR/node-graphics-stream.js"
OVERLAY_FPS=2

# Overlay canvas size - just the scoreboard box, not full 1920x1080
# Position on screen (compositor xpos/ypos)
OVL_WIDTH=600
OVL_HEIGHT=200
OVL_X=50
OVL_Y=50

echo "🎨 Starting Node-Cairo overlay pipeline (RGBA pipe mode)..."
echo "Camera: $CAMERA_DEVICE"
echo "Resolution: ${WIDTH}x${HEIGHT}@${FRAMERATE}fps"
echo "SRT Port: $SRT_PORT"
echo "Graphics Script: $NODE_SCRIPT"
echo "Overlay FPS: $OVERLAY_FPS"

# Calculate RGBA frame size for blocksize (overlay size, not full screen)
FRAME_SIZE=$((OVL_WIDTH * OVL_HEIGHT * 4))
echo "✅ Starting pipeline with Node.js RGBA pipe..."
echo "📊 Overlay size: ${OVL_WIDTH}x${OVL_HEIGHT} at (${OVL_X},${OVL_Y})"
echo "📊 RGBA frame size: $FRAME_SIZE bytes"

# Build GStreamer pipeline with compositor
# Node.js writes small RGBA overlay frames to stdout, piped to fdsrc
# compositor positions the small overlay on top of the full camera frame
# TEE is placed AFTER compositor so both SRT and preview get the overlay
node "$NODE_SCRIPT" "$OVL_WIDTH" "$OVL_HEIGHT" "$OVERLAY_FPS" "pipe" "" | \
gst-launch-1.0 \
  v4l2src device="$CAMERA_DEVICE" do-timestamp=true ! \
  image/jpeg,width=$WIDTH,height=$HEIGHT,framerate=$FRAMERATE/1 ! \
  jpegdec ! \
  videoconvert ! \
  video/x-raw,format=RGBA ! \
  queue max-size-buffers=3 leaky=no ! \
  compositor name=mix sink_0::zorder=0 sink_1::zorder=1 sink_1::alpha=1.0 sink_1::xpos=$OVL_X sink_1::ypos=$OVL_Y ! \
  video/x-raw,width=$WIDTH,height=$HEIGHT ! \
  videoconvert ! \
  $(if [ -n "$OVERLAY_TEXT" ]; then BG_OPT=""; if [ "$OVERLAY_BG" != "transparent" ]; then BG_OPT="shaded-background=true"; fi; echo "textoverlay text=\"$OVERLAY_TEXT\" valignment=bottom halignment=left font-desc=\"Sans Bold $FONT_SIZE\" color=$OVERLAY_COLOR xpad=20 ypad=20 $BG_OPT !"; fi) \
  $(if [ "$SHOW_TIMESTAMP" = "true" ]; then BG_OPT=""; if [ "$OVERLAY_BG" != "transparent" ]; then BG_OPT="shaded-background=true"; fi; echo "clockoverlay valignment=bottom halignment=right font-desc=\"Sans Bold $FONT_SIZE\" color=$OVERLAY_COLOR time-format=\"%Y-%m-%d %H:%M:%S\" xpad=20 ypad=20 $BG_OPT !"; fi) \
  tee name=t \
  \
  t. ! queue max-size-buffers=2 leaky=downstream ! \
  videoconvert ! \
  video/x-raw,format=I420 ! \
  x264enc speed-preset=ultrafast tune=zerolatency bitrate=$((BITRATE/1000)) key-int-max=30 ! \
  video/x-h264,stream-format=byte-stream ! \
  h264parse config-interval=-1 ! \
  queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 leaky=downstream ! \
  mpegtsmux alignment=7 ! \
  srtsink uri="srt://:$SRT_PORT" wait-for-connection=false latency=125 \
  \
  fdsrc fd=0 blocksize=$FRAME_SIZE do-timestamp=true ! \
  rawvideoparse format=rgba width=$OVL_WIDTH height=$OVL_HEIGHT framerate=${OVERLAY_FPS}/1 ! \
  queue max-size-buffers=2 leaky=downstream ! \
  mix. \
  \
  t. ! queue max-size-buffers=10 leaky=downstream ! \
  videoscale ! \
  video/x-raw,width=1280,height=720 ! \
  videoconvert ! \
  jpegenc quality=75 ! \
  multipartmux boundary=--jpgboundary ! \
  tcpserversink host=0.0.0.0 port=8555 sync=false recover-policy=keyframe

echo "🛑 Pipeline exited"

