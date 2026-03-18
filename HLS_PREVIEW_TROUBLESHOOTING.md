# HLS Preview Troubleshooting Guide

## Problem: Blank Preview When Streaming

If you see "Live Stream Preview" but no video when streaming starts, follow these steps:

## Latest Fix (2024-03-17)

**Changed from `hlssink` to `splitmuxsink` + dynamic playlist generation**

The Jetson's older GStreamer version has issues with `hlssink` not creating the playlist.m3u8 file.
Now using `splitmuxsink` to create segments, and the server generates the playlist dynamically.

## Step 1: Check Browser Console

Open your browser's developer console (F12) and look for errors:

### Good Signs ✅
```
🔄 Switching to HLS preview...
✅ Using hls.js
✅ HLS manifest parsed
✅ HLS fragment loaded: 0
✅ HLS fragment loaded: 1
```

### Bad Signs ❌
```
❌ HLS error: NETWORK_ERROR MANIFEST_LOAD_ERROR
❌ HLS error: NETWORK_ERROR FRAG_LOAD_ERROR
404 Not Found: /video/hls/playlist.m3u8
```

## Step 2: Check Server Logs

On your Jetson, look at the Node.js server output:

### Good Signs ✅
```
📺 HLS playlist requested
✅ Serving HLS playlist
📺 HLS segment requested: segment00001.ts
✅ Serving HLS segment: segment00001.ts
```

### Bad Signs ❌
```
📺 HLS playlist requested
⚠️  Playlist not ready yet: /tmp/stream/playlist.m3u8
📁 Files in /tmp/stream: []
```

## Step 3: Check HLS Files on Jetson

SSH into your Jetson and run:

```bash
# Check if HLS directory exists
ls -la /tmp/stream/

# Watch for new segments being created
watch -n 1 'ls -lh /tmp/stream/'
```

### What You Should See ✅
```
-rw-r--r-- 1 jetson jetson  512 Mar 17 16:30 playlist.m3u8
-rw-r--r-- 1 jetson jetson 256K Mar 17 16:30 segment00001.ts
-rw-r--r-- 1 jetson jetson 248K Mar 17 16:30 segment00002.ts
-rw-r--r-- 1 jetson jetson 252K Mar 17 16:30 segment00003.ts
```

New segments should appear every 2 seconds.

### What's Wrong ❌
```
ls: cannot access '/tmp/stream/': No such file or directory
```
OR
```
total 0
(empty directory)
```

## Step 4: Check GStreamer Pipeline

On the Jetson, check if GStreamer is running:

```bash
# Check GStreamer process
ps aux | grep gst-launch

# Check GStreamer errors in server output
# Look for lines starting with "GStreamer stderr:"
```

### Common GStreamer Errors

**"No element 'hlssink'"**
```bash
# Install GStreamer HLS plugin
sudo apt-get install gstreamer1.0-plugins-bad
```

**"Could not open resource for writing"**
- Check `/tmp/stream/` directory permissions
- Make sure directory exists and is writable

## Step 5: Manual HLS Test

Test if HLS files are being created manually:

```bash
# On Jetson, create a test HLS stream
gst-launch-1.0 -v \
  videotestsrc num-buffers=100 ! \
  x264enc ! h264parse ! mpegtsmux ! \
  hlssink \
    playlist-location=/tmp/test/playlist.m3u8 \
    location=/tmp/test/segment%05d.ts \
    target-duration=2 \
    max-files=5

# Check if files were created
ls -la /tmp/test/
```

If this works, the issue is with the main pipeline configuration.

## Common Fixes

### Fix 1: Restart Server
The server now cleans up on startup:
```bash
# Stop server (Ctrl+C)
node server.js
```

### Fix 2: Manually Create HLS Directory
```bash
sudo mkdir -p /tmp/stream
sudo chmod 777 /tmp/stream
```

### Fix 3: Check GStreamer Plugins
```bash
# List installed plugins
gst-inspect-1.0 hlssink

# If not found, install
sudo apt-get update
sudo apt-get install gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly
```

### Fix 4: Increase Wait Time
The frontend waits 1.5 seconds before switching to HLS. If your Jetson is slow, increase this:

In `public/app.js`, change:
```javascript
setTimeout(() => {
  switchToHLSPreview();
}, 1500); // Change to 3000 or 4000
```

### Fix 5: Check Permissions
```bash
# Make sure /tmp/stream is writable
ls -ld /tmp/stream
# Should show: drwxrwxrwx

# If not:
sudo chmod 777 /tmp/stream
```

## Testing Checklist

- [ ] Browser console shows "✅ Using hls.js"
- [ ] Browser console shows "✅ HLS manifest parsed"
- [ ] Server logs show "✅ Serving HLS playlist"
- [ ] `/tmp/stream/` directory exists
- [ ] `playlist.m3u8` file exists in `/tmp/stream/`
- [ ] `.ts` segment files exist in `/tmp/stream/`
- [ ] New segments appear every 2 seconds
- [ ] GStreamer process is running
- [ ] No GStreamer errors in server output

## Debug Commands

```bash
# On Jetson - check everything at once
echo "=== GStreamer Process ==="
ps aux | grep gst-launch

echo "=== HLS Files ==="
ls -lh /tmp/stream/

echo "=== Playlist Content ==="
cat /tmp/stream/playlist.m3u8

echo "=== Camera Status ==="
fuser /dev/video0

echo "=== Server Process ==="
ps aux | grep "node server.js"
```

## Next Steps

After applying the latest changes:

1. **Transfer code to Jetson**
2. **Restart the server**
3. **Start streaming**
4. **Open browser console (F12)**
5. **Check for HLS errors**
6. **SSH to Jetson and check `/tmp/stream/`**

If you still see issues, share:
- Browser console output
- Server log output
- Output of `ls -la /tmp/stream/`
- Output of `ps aux | grep gst-launch`

