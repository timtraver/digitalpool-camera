#!/bin/bash
# Cleanup script to release camera resources
# Run this if the camera is stuck or "Device or resource busy" errors occur

echo "🧹 Cleaning up camera resources..."

CAMERA_DEVICE="${1:-/dev/video0}"

# Kill GStreamer processes
echo "Checking for GStreamer processes..."
GSTREAMER_PIDS=$(pgrep -f gst-launch)
if [ -n "$GSTREAMER_PIDS" ]; then
    echo "Found GStreamer processes: $GSTREAMER_PIDS"
    echo "$GSTREAMER_PIDS" | xargs kill -9 2>/dev/null
    echo "✅ GStreamer processes killed"
else
    echo "✅ No GStreamer processes found"
fi

# Kill FFmpeg processes using the camera
echo "Checking for FFmpeg processes..."
FFMPEG_PIDS=$(ps aux | grep ffmpeg | grep "$CAMERA_DEVICE" | grep -v grep | awk '{print $2}')
if [ -n "$FFMPEG_PIDS" ]; then
    echo "Found FFmpeg processes: $FFMPEG_PIDS"
    echo "$FFMPEG_PIDS" | xargs kill -9 2>/dev/null
    echo "✅ FFmpeg processes killed"
else
    echo "✅ No FFmpeg processes found"
fi

# Kill any remaining processes using the camera
echo "Checking for processes using $CAMERA_DEVICE..."
FUSER_OUTPUT=$(fuser "$CAMERA_DEVICE" 2>&1)
if echo "$FUSER_OUTPUT" | grep -q ":"; then
    PIDS=$(echo "$FUSER_OUTPUT" | cut -d: -f2 | tr -d 'm' | xargs)
    if [ -n "$PIDS" ]; then
        echo "Found processes using camera: $PIDS"
        echo "$PIDS" | xargs kill -9 2>/dev/null
        echo "✅ Processes killed"
    fi
else
    echo "✅ No processes using camera"
fi

# Wait for device to be released
sleep 1

# Verify camera is free
echo ""
echo "🔍 Verifying camera is free..."
FINAL_CHECK=$(fuser "$CAMERA_DEVICE" 2>&1)
if echo "$FINAL_CHECK" | grep -q ":"; then
    echo "⚠️  Warning: Camera may still be in use"
    echo "$FINAL_CHECK"
else
    echo "✅ Camera is free and ready to use!"
fi

echo ""
echo "Done! You can now restart the server or start streaming."

