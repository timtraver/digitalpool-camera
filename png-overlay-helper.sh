#!/bin/bash
# GStreamer pipeline with dynamic PNG overlay
# Uses a Python script that can dynamically reload the gdkpixbufoverlay
# when the PNG file changes on disk (polls file mtime every 500ms)

CAMERA_DEVICE=$1
WIDTH=$2
HEIGHT=$3
FRAMERATE=$4
BITRATE=$5
PROTOCOL=${6:-"srt"}
DESTINATION=${7:-""}
PNG_PATH="$8"
OVERLAY_TEXT=${9:-""}
SHOW_TIMESTAMP=${10:-"false"}
FONT_SIZE=${11:-48}
OVERLAY_COLOR=${12:-4294967295}
OVERLAY_BACKGROUND=${13:-"transparent"}
TIMESTAMP_FORMAT=${14:-"%Y-%m-%d %H:%M:%S"}
TITLE_POSITION=${15:-"top-left"}
TIMESTAMP_POSITION=${16:-"bottom-right"}
AUDIO_DEVICE=${17:-""}
# Per-element timestamp formatting (args 18-20, optional for backward compat)
TS_FONT_SIZE=${18:-$FONT_SIZE}
TS_COLOR=${19:-$OVERLAY_COLOR}
TS_BACKGROUND=${20:-$OVERLAY_BACKGROUND}
# Codec selection: 'h264' or 'h265' (arg 21, optional — defaults to h264)
CODEC=${21:-"h264"}

echo "🎨 Starting stream with dynamic PNG graphics overlay (Python GStreamer)..."
echo "Camera: $CAMERA_DEVICE"
echo "Resolution: ${WIDTH}x${HEIGHT}@${FRAMERATE}fps"
echo "Protocol: $PROTOCOL"
echo "Destination: $DESTINATION"
echo "PNG Overlay: $PNG_PATH (auto-reload on change)"
echo "Text Overlay: $OVERLAY_TEXT"
echo "Show Timestamp: $SHOW_TIMESTAMP"
echo "Title Font Size: $FONT_SIZE, Timestamp Font Size: $TS_FONT_SIZE"
echo "Audio Device: $AUDIO_DEVICE"
echo "Codec: $CODEC"

# Get the directory of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Use Python GStreamer script for dynamic overlay reloading
exec python3 "$SCRIPT_DIR/gst-overlay-pipeline.py" \
  "$CAMERA_DEVICE" "$WIDTH" "$HEIGHT" "$FRAMERATE" "$BITRATE" \
  "$PROTOCOL" "$DESTINATION" \
  "$PNG_PATH" "$OVERLAY_TEXT" "$SHOW_TIMESTAMP" "$FONT_SIZE" \
  "$OVERLAY_COLOR" "$OVERLAY_BACKGROUND" "$TIMESTAMP_FORMAT" \
  "$TITLE_POSITION" "$TIMESTAMP_POSITION" "$AUDIO_DEVICE" \
  "$TS_FONT_SIZE" "$TS_COLOR" "$TS_BACKGROUND" "$CODEC"

