#!/bin/bash
# GStreamer pipeline with dynamic PNG overlay
# Uses a Python script that can dynamically reload the gdkpixbufoverlay
# when the PNG file changes on disk (polls file mtime every 500ms)

CAMERA_DEVICE=$1
WIDTH=$2
HEIGHT=$3
FRAMERATE=$4
BITRATE=$5
SRT_PORT=$6
PNG_PATH=${7:-"/tmp/graphics-overlay.png"}
OVERLAY_TEXT=${8:-""}
SHOW_TIMESTAMP=${9:-"false"}
FONT_SIZE=${10:-48}
OVERLAY_COLOR=${11:-4294967295}
OVERLAY_BACKGROUND=${12:-"transparent"}
TIMESTAMP_FORMAT=${13:-"%Y-%m-%d %H:%M:%S"}
TITLE_POSITION=${14:-"top-left"}
TIMESTAMP_POSITION=${15:-"bottom-right"}
AUDIO_DEVICE=${16:-""}
# Per-element timestamp formatting (args 17-19, optional for backward compat)
TS_FONT_SIZE=${17:-$FONT_SIZE}
TS_COLOR=${18:-$OVERLAY_COLOR}
TS_BACKGROUND=${19:-$OVERLAY_BACKGROUND}

echo "🎨 Starting stream with dynamic PNG graphics overlay (Python GStreamer)..."
echo "Camera: $CAMERA_DEVICE"
echo "Resolution: ${WIDTH}x${HEIGHT}@${FRAMERATE}fps"
echo "SRT Port: $SRT_PORT"
echo "PNG Overlay: $PNG_PATH (auto-reload on change)"
echo "Text Overlay: $OVERLAY_TEXT"
echo "Show Timestamp: $SHOW_TIMESTAMP"
echo "Title Font Size: $FONT_SIZE, Timestamp Font Size: $TS_FONT_SIZE"
echo "Audio Device: $AUDIO_DEVICE"

# Get the directory of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Use Python GStreamer script for dynamic overlay reloading
exec python3 "$SCRIPT_DIR/gst-overlay-pipeline.py" \
  "$CAMERA_DEVICE" "$WIDTH" "$HEIGHT" "$FRAMERATE" "$BITRATE" "$SRT_PORT" \
  "$PNG_PATH" "$OVERLAY_TEXT" "$SHOW_TIMESTAMP" "$FONT_SIZE" \
  "$OVERLAY_COLOR" "$OVERLAY_BACKGROUND" "$TIMESTAMP_FORMAT" \
  "$TITLE_POSITION" "$TIMESTAMP_POSITION" "$AUDIO_DEVICE" \
  "$TS_FONT_SIZE" "$TS_COLOR" "$TS_BACKGROUND"

