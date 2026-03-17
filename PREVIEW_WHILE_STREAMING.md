# Preview While Streaming - Implementation

## Problem
When the GStreamer pipeline is streaming, it locks the camera device (`/dev/video0`), preventing FFmpeg from accessing it for the web preview. This caused "Device or resource busy" errors.

## Solution
Use GStreamer's `tee` element to split the encoded H.264 stream into two branches:
1. **Main branch**: Sends to RTMP/SRT destination
2. **Preview branch**: Generates HLS (HTTP Live Streaming) segments for web preview

## How It Works

### Backend (GStreamer Pipeline)

The GStreamer pipeline now includes an HLS output:

```
v4l2src → jpegdec → overlays → nvv4l2h264enc → h264parse → tee
                                                              ├─→ RTMP (main stream)
                                                              └─→ HLS (web preview)
```

**HLS Branch:**
- Writes `.ts` segments to `/tmp/stream/`
- Creates `playlist.m3u8` manifest
- Keeps only last 5 segments (rolling buffer)
- 2-second segments for low latency

**Files:**
- `streamController.js`: Added HLS sink to GStreamer pipeline
- `server.js`: Added endpoints to serve HLS playlist and segments

### Frontend (Web Interface)

The web interface automatically switches between two preview modes:

**When NOT streaming:**
- Uses `<img>` element with MJPEG stream from FFmpeg
- Direct camera access via `/video/stream`

**When streaming:**
- Switches to `<video>` element with HLS playback
- Uses hls.js library for browser compatibility
- Loads from `/video/hls/playlist.m3u8`

**Files:**
- `public/app.js`: Added `switchToHLSPreview()` and `switchToMJPEGPreview()` functions
- `public/index.html`: Added hls.js library

## API Endpoints

### `/video/hls/playlist.m3u8`
Returns the HLS playlist manifest (only when streaming is active)

### `/video/hls/:segment`
Returns individual HLS segments (e.g., `segment00001.ts`)

### `/video/stream`
Returns MJPEG stream (only when NOT streaming)

## Benefits

✅ **No camera conflicts**: Only one process (GStreamer) accesses the camera
✅ **Independent preview**: Web preview works while streaming to RTMP/SRT
✅ **Shows actual output**: Preview includes all overlays and encoding settings
✅ **Low latency**: 2-second HLS segments provide near real-time preview
✅ **Browser compatible**: hls.js works in all modern browsers

## Testing

1. **Start the server** (if not already running)
2. **Open web interface**: `http://<jetson-ip>:3000`
3. **Verify MJPEG preview** is working (before streaming)
4. **Start streaming** to your RTMP server
5. **Preview should automatically switch to HLS** after ~1.5 seconds
6. **Stop streaming** - preview switches back to MJPEG

## Troubleshooting

### Preview shows "Stream active - use HLS preview"
This means the frontend tried to access `/video/stream` while streaming is active. The page should auto-switch to HLS. Try refreshing the page.

### HLS preview shows "Playlist not ready yet"
Wait a few seconds for GStreamer to generate the first HLS segments. The HLS sink needs time to create initial segments.

### Preview is black or frozen
Check the browser console for errors. Make sure hls.js loaded correctly. Try refreshing the page.

### "Device or resource busy" errors
This should no longer happen. If it does, check that:
- Only one GStreamer process is running
- No FFmpeg processes are accessing the camera
- Run: `fuser /dev/video0` to see what's using the camera

## Technical Details

### HLS Configuration
- **Segment duration**: 2 seconds
- **Playlist length**: 3 segments (6 seconds total)
- **Max files**: 5 segments on disk
- **Location**: `/tmp/stream/` (cleared on stream start)

### Browser Compatibility
- **Safari/iOS**: Native HLS support
- **Chrome/Firefox/Edge**: hls.js library
- **Fallback**: Shows error if HLS not supported

## Future Improvements

- [ ] Add WebRTC preview for even lower latency
- [ ] Support multiple simultaneous preview clients
- [ ] Add preview quality settings (resolution, bitrate)
- [ ] Implement preview-only mode (no RTMP output)

