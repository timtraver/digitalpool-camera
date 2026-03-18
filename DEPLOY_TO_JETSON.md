# Deploying to Jetson Nano

## Quick Deploy

### From your Mac, sync code to Jetson:

```bash
# Replace with your Jetson's IP and path
rsync -avz --exclude 'node_modules' \
  /Users/timtraver/Projects/digitalpool-camera/ \
  jetson@192.168.1.XX:/home/jetson/Desktop/digitalpool-camera/
```

### On the Jetson:

```bash
# SSH into Jetson
ssh jetson@192.168.1.XX

# Go to project directory
cd ~/Desktop/digitalpool-camera

# Install dependencies (first time only)
npm install

# Make cleanup script executable
chmod +x cleanup-camera.sh

# Run the server
node server.js
```

## If Camera is Busy

### Option 1: Restart the server
The server now automatically cleans up camera resources on startup.

```bash
# Stop the server (Ctrl+C)
# Start it again
node server.js
```

### Option 2: Run cleanup script
```bash
./cleanup-camera.sh
```

### Option 3: Manual cleanup
```bash
# See what's using the camera
fuser /dev/video0

# Kill all processes using camera
sudo fuser -k /dev/video0

# Or kill specific processes
ps aux | grep gst-launch
ps aux | grep ffmpeg
kill -9 <PID>
```

## Testing the Preview While Streaming

1. **Open web interface**: `http://<jetson-ip>:3000`
2. **Verify MJPEG preview works** (before streaming)
3. **Start streaming** to your RTMP server
4. **Preview should switch to HLS** automatically after ~2 seconds
5. **Stop streaming** - preview switches back to MJPEG

## Common Issues

### "Device or resource busy"
- **Solution**: Restart the server or run `./cleanup-camera.sh`
- **Cause**: Previous GStreamer/FFmpeg process still holding camera

### Preview not switching to HLS when streaming
- **Check browser console** for errors
- **Verify HLS files exist**: `ls -la /tmp/stream/`
- **Wait 2-3 seconds** for GStreamer to generate segments

### HLS preview shows "Playlist not ready yet"
- **Wait a few seconds** for GStreamer to create initial segments
- **Check GStreamer is running**: `ps aux | grep gst-launch`
- **Check HLS directory**: `ls -la /tmp/stream/`

### RTMP stream not connecting
- **Verify RTMP server is running** on your Mac
- **Check destination URL** matches your RTMP server
- **Test with VLC**: `vlc rtmp://localhost:1935/live/stream`

## File Transfer Tips

### Quick sync (recommended)
```bash
# Create an alias in ~/.bash_profile or ~/.zshrc
alias sync-jetson='rsync -avz --exclude node_modules /Users/timtraver/Projects/digitalpool-camera/ jetson@192.168.1.XX:/home/jetson/Desktop/digitalpool-camera/'

# Then just run:
sync-jetson
```

### Using scp (alternative)
```bash
scp -r /Users/timtraver/Projects/digitalpool-camera jetson@192.168.1.XX:/home/jetson/Desktop/
```

### Using git (best for version control)
```bash
# On Mac: commit and push
git add .
git commit -m "Update"
git push

# On Jetson: pull changes
git pull
```

## Running as a Service

To run the server automatically on boot:

```bash
# On Jetson
sudo cp digitalpool-camera.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable digitalpool-camera
sudo systemctl start digitalpool-camera

# Check status
sudo systemctl status digitalpool-camera

# View logs
sudo journalctl -u digitalpool-camera -f
```

## Development Workflow

1. **Edit code on Mac** (in VS Code or your editor)
2. **Sync to Jetson**: `rsync -avz ...` or `sync-jetson`
3. **SSH to Jetson**: `ssh jetson@192.168.1.XX`
4. **Restart server**: Ctrl+C then `node server.js`
5. **Test in browser**: `http://<jetson-ip>:3000`

## Monitoring

### Check if server is running
```bash
ps aux | grep "node server.js"
```

### Check camera status
```bash
fuser /dev/video0
v4l2-ctl --device=/dev/video0 --all
```

### Check GStreamer pipeline
```bash
ps aux | grep gst-launch
```

### Check HLS segments
```bash
ls -la /tmp/stream/
watch -n 1 'ls -lh /tmp/stream/'
```

## Performance Tips

- Use hardware encoding (nvv4l2h264enc) for best performance
- Lower bitrate if network is slow (3-4 Mbps instead of 5 Mbps)
- Use SRT instead of RTMP for lower latency
- Keep HLS segment duration at 2 seconds for low latency preview

## Related Documentation

- `CAMERA_CLEANUP_FIX.md` - Camera busy error fixes
- `PREVIEW_WHILE_STREAMING.md` - How HLS preview works
- `OBS_SETUP_GUIDE.md` - Setting up OBS to receive stream
- `STREAMING_ARCHITECTURE.md` - Overall system architecture

