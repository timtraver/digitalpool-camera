#!/usr/bin/env python3
"""
GStreamer pipeline with cairooverlay for dynamic graphics
This script reads game state from a JSON file and draws it on every frame
"""

import gi
gi.require_version('Gst', '1.0')
gi.require_version('GstVideo', '1.0')
from gi.repository import Gst, GLib, GstVideo
import cairo
import json
import sys
import os

# Initialize GStreamer
Gst.init(None)

# Game state file
STATE_FILE = '/tmp/graphics-overlay-state.json'

def get_game_state():
    """Read current game state from JSON file"""
    try:
        with open(STATE_FILE, 'r') as f:
            return json.load(f)
    except:
        return {
            'player1Name': 'Player 1',
            'player2Name': 'Player 2',
            'player1Score': 0,
            'player2Score': 0,
            'matchTitle': 'Match 53'
        }

def on_draw(overlay, cr, timestamp, duration, user_data):
    """Cairo drawing callback - called for every video frame

    Args:
        overlay: The cairooverlay element
        cr: Cairo context (already a proper cairo.Context object)
        timestamp: Current buffer timestamp
        duration: Current buffer duration
        user_data: User data (not used)
    """
    try:
        # Get current game state
        state = get_game_state()

        # The 'cr' parameter is already a cairo.Context object from GStreamer
        # No conversion needed!

        # Draw scoreboard in top-left corner
        x, y = 50, 50
        width, height = 500, 200

        # Semi-transparent background
        cr.set_source_rgba(0, 0, 0, 0.7)
        cr.rectangle(x, y, width, height)
        cr.fill()

        # Border
        cr.set_source_rgb(1, 1, 1)
        cr.set_line_width(3)
        cr.rectangle(x, y, width, height)
        cr.stroke()

        # Title
        cr.set_source_rgb(1, 1, 1)
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        cr.set_font_size(32)
        cr.move_to(x + 20, y + 45)
        cr.show_text(state['matchTitle'])

        # Scores
        cr.set_font_size(60)
        cr.move_to(x + 180, y + 130)
        cr.show_text(f"{state['player1Score']} - {state['player2Score']}")

        # Player names
        cr.set_font_size(24)
        cr.set_source_rgba(1, 1, 1, 0.8)
        cr.move_to(x + 20, y + 180)
        cr.show_text(state['player1Name'])
        cr.move_to(x + width - 120, y + 180)
        cr.show_text(state['player2Name'])

    except Exception as e:
        # Log first error only to avoid flooding
        if not hasattr(on_draw, 'error_logged'):
            print(f"Cairo draw error: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc()
            on_draw.error_logged = True

def main():
    """Create and run GStreamer pipeline with cairooverlay"""
    if len(sys.argv) < 7:
        print("Usage: cairo-graphics-stream.py DEVICE WIDTH HEIGHT FRAMERATE BITRATE SRT_PORT [OVERLAY_TEXT] [SHOW_TIMESTAMP]")
        sys.exit(1)
    
    device = sys.argv[1]
    width = int(sys.argv[2])
    height = int(sys.argv[3])
    framerate = int(sys.argv[4])
    bitrate = int(sys.argv[5])
    srt_port = int(sys.argv[6])
    overlay_text = sys.argv[7] if len(sys.argv) > 7 else ""
    show_timestamp = sys.argv[8] if len(sys.argv) > 8 else "false"
    
    print(f"🎨 Starting Cairo overlay stream...")
    print(f"Camera: {device}")
    print(f"Resolution: {width}x{height}@{framerate}fps")
    print(f"SRT Port: {srt_port}")
    
    # Build pipeline string
    pipeline_str = f"""
        v4l2src device={device} do-timestamp=true
        ! image/jpeg,width={width},height={height},framerate={framerate}/1
        ! jpegdec
        ! videoconvert
        ! cairooverlay name=overlay
        ! videoconvert
    """
    
    # Add text overlay if specified
    if overlay_text:
        pipeline_str += f"""
        ! textoverlay text="{overlay_text}" valignment=bottom halignment=left 
          font-desc="Sans Bold 24" color=4294967295 xpad=20 ypad=20 shaded-background=true
        """
    
    # Add clock overlay if specified
    if show_timestamp == "true":
        pipeline_str += """
        ! clockoverlay valignment=bottom halignment=right font-desc="Sans Bold 24" 
          color=4294967295 time-format="%Y-%m-%d %H:%M:%S" xpad=20 ypad=20 shaded-background=true
        """
    
    # Add tee and outputs
    pipeline_str += f"""
        ! tee name=t
        
        t. ! queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 leaky=downstream ! nvvidconv
        ! video/x-raw(memory:NVMM)
        ! nvv4l2h264enc bitrate={bitrate} preset-level=1 profile=0 iframeinterval=15 insert-sps-pps=true maxperf-enable=true
        ! video/x-h264,stream-format=byte-stream
        ! h264parse config-interval=-1
        ! queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 leaky=downstream
        ! mpegtsmux alignment=7
        ! srtserversink uri=srt://:{srt_port} latency=125 sync=false
        
        t. ! queue max-size-buffers=10 leaky=downstream
        ! videoscale
        ! video/x-raw,width=1280,height=720
        ! jpegenc quality=75
        ! multipartmux boundary=--jpgboundary
        ! tcpserversink host=0.0.0.0 port=8555 sync=false recover-policy=keyframe
    """
    
    # Create pipeline
    pipeline = Gst.parse_launch(pipeline_str)
    
    # Get cairooverlay element and connect draw callback
    overlay = pipeline.get_by_name('overlay')
    overlay.connect('draw', on_draw, None)
    
    # Start pipeline
    pipeline.set_state(Gst.State.PLAYING)
    
    # Run main loop
    loop = GLib.MainLoop()
    try:
        loop.run()
    except KeyboardInterrupt:
        pass
    
    # Cleanup
    pipeline.set_state(Gst.State.NULL)

if __name__ == '__main__':
    main()

