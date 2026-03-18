#!/bin/bash
# Simple compositor test - blend two test sources

echo "Testing GStreamer compositor with two test sources..."
echo "This should show a red circle moving over a blue background"
echo "Press Ctrl+C to stop"

gst-launch-1.0 -v \
  compositor name=mix \
    sink_0::zorder=0 \
    sink_1::zorder=1 \
  ! videoconvert \
  ! autovideosink \
  \
  videotestsrc pattern=blue \
  ! video/x-raw,width=1920,height=1080,framerate=30/1 \
  ! mix.sink_0 \
  \
  videotestsrc pattern=circular \
  ! video/x-raw,width=1920,height=1080,framerate=30/1 \
  ! mix.sink_1

