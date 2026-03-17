# Camera "Device or Resource Busy" Fix

## Problem
When restarting the server, you get this error:
```
/dev/video0: Device or resource busy
```

This happens because:
1. Previous GStreamer or FFmpeg processes are still holding the camera
2. The server doesn't clean up these processes on restart
3. The camera can only be accessed by one process at a time

## Solution Applied

### 1. Automatic Cleanup on Server Startup
Modified `server.js` to automatically clean up camera resources when the server starts:

- ✅ Kills all GStreamer processes (`gst-launch`)
- ✅ Kills all FFmpeg processes using the camera
- ✅ Kills any remaining processes using `/dev/video0`
- ✅ Waits 1 second for device to be released

**Location:** `server.js` lines 705-792

### 2. Manual Cleanup Script
Created `cleanup-camera.sh` for manual cleanup when needed:

```bash
./cleanup-camera.sh
```

This script:
- Kills all GStreamer processes
- Kills all FFmpeg processes using the camera
- Kills any processes using `/dev/video0`
- Verifies the camera is free

## How to Use

### Automatic (Recommended)
Just restart the server - it will automatically clean up:

```bash
# Stop the server (Ctrl+C)
# Start it again
node server.js
```

You should see:
```
🧹 Cleaning up camera resources...
Checking for GStreamer processes...
✅ No GStreamer processes found
Checking for FFmpeg processes...
✅ No FFmpeg processes found
✅ Camera resources cleaned up
```

### Manual Cleanup
If the camera is still busy, run the cleanup script:

```bash
./cleanup-camera.sh
```

Or manually check what's using the camera:

```bash
# See what's using the camera
fuser /dev/video0

# Kill all processes using the camera
sudo fuser -k /dev/video0

# Or kill specific processes
ps aux | grep gst-launch
ps aux | grep ffmpeg
kill -9 <PID>
```

## Prevention

The server now:
1. ✅ Cleans up on startup
2. ✅ Properly kills temporary FFmpeg stream after camera initialization
3. ✅ Releases camera when streaming stops (with improved error handling)
4. ✅ Cleans up camera when GStreamer fails

## Testing

1. **Start the server**
   ```bash
   node server.js
   ```

2. **Check the output** - you should see:
   ```
   🧹 Cleaning up camera resources...
   ✅ Camera resources cleaned up
   🚀 Initializing camera with saved configuration...
   ```

3. **Open the web interface** - preview should work

4. **Start streaming** - should work without "device busy" errors

5. **Stop streaming** - camera should be released

6. **Restart server** - should clean up automatically

## Troubleshooting

### Camera still busy after server restart
Run the cleanup script:
```bash
./cleanup-camera.sh
```

### Want to see what's using the camera
```bash
fuser /dev/video0
lsof /dev/video0
ps aux | grep video0
```

### Nuclear option (kill everything)
```bash
sudo pkill -9 gst-launch
sudo pkill -9 ffmpeg
sudo fuser -k /dev/video0
```

## Related Files

- `server.js` - Automatic cleanup on startup
- `cleanup-camera.sh` - Manual cleanup script
- `streamController.js` - Improved error handling and cleanup
- `PREVIEW_WHILE_STREAMING.md` - How HLS preview works

## Next Steps

After applying this fix:
1. Restart your server
2. The camera should be automatically cleaned up
3. Preview should work immediately
4. Streaming should work without conflicts

