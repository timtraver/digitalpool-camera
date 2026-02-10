#!/bin/bash

echo "=== Camera Diagnostics ==="
echo ""

echo "1. Checking camera device..."
ls -l /dev/video0
echo ""

echo "2. Checking camera formats..."
v4l2-ctl -d /dev/video0 --list-formats-ext
echo ""

echo "3. Checking current camera settings..."
v4l2-ctl -d /dev/video0 --all
echo ""

echo "4. Testing ffmpeg with MJPEG format..."
timeout 3 ffmpeg -f v4l2 -input_format mjpeg -video_size 1280x720 -framerate 30 -i /dev/video0 -f null - 2>&1 | tail -20
echo ""

echo "5. Testing ffmpeg with YUYV format..."
timeout 3 ffmpeg -f v4l2 -input_format yuyv422 -video_size 1280x720 -framerate 30 -i /dev/video0 -f null - 2>&1 | tail -20
echo ""

echo "6. Testing ffmpeg with default format..."
timeout 3 ffmpeg -f v4l2 -i /dev/video0 -f null - 2>&1 | tail -20
echo ""

echo "=== Diagnostics Complete ==="

