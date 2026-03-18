# SRT Streaming Setup Guide

## Overview

SRT (Secure Reliable Transport) provides **2-3x lower latency** than RTMP and better performance over unreliable networks. This guide shows you how to use SRT streaming with your Jetson camera.

## How SRT Works in This Setup

**Important:** The Jetson acts as an **SRT server**, and OBS connects to it as a **client**. This is different from RTMP where the Jetson pushes to a server.

- **Jetson**: SRT Server (listens on port 8891)
- **OBS**: SRT Client (connects to Jetson)

## Prerequisites

### 1. Check GStreamer SRT Plugin

On the Jetson, verify that the SRT plugin is installed:

```bash
gst-inspect-1.0 srtserversink
```

If not found, install it:

```bash
sudo apt-get update
sudo apt-get install gstreamer1.0-plugins-bad
```

### 2. Open Firewall Port (if needed)

If you have a firewall enabled on the Jetson:

```bash
sudo ufw allow 8891/udp
sudo ufw allow 8891/tcp
```

## Configuration

### Step 1: Configure the Web Interface

1. Open the web interface at `http://<jetson-ip>:3000`
2. In the **Stream Output** section:
   - **Protocol**: Select "SRT"
   - **Destination**: **Leave empty** (the placeholder will say "Leave empty (server mode on port 8891)")
   - **Bitrate**: Set your desired bitrate (default: 5 Mbps)

**Note:** The destination field is intentionally left empty because the Jetson acts as an SRT **server**. OBS will connect to the Jetson, not the other way around.

### Step 2: Start Streaming

1. Click "Start Stream"
2. The console will show:
   ```
   📡 SRT server mode - OBS should connect to: srt://<jetson-ip>:8891
   ```
3. Note the IP address shown - you'll need it for OBS

### Step 3: Configure OBS

1. Open OBS Studio
2. In the "Sources" panel, click the "+" button
3. Select "Media Source"
4. Name it "Jetson SRT Camera"
5. Configure:
   - **Uncheck** "Local File"
   - **Input**: `srt://<jetson-ip>:8891`
     - Example: `srt://192.168.1.100:8891`
   - **Check** "Restart playback when source becomes active"
   - **Network Buffering**: 200-500 MB (lower = less latency)
   - **Reconnect Delay**: 2 seconds
6. Click OK

## Latency Settings

The SRT stream is configured with:
- **Latency**: 125ms (very low)
- **Buffer**: Minimal (2 buffers max)
- **Queue**: Leaky downstream (drops old frames if queue is full)

You can adjust the latency in `streamController.js` line 619:
```javascript
"latency=125", // Latency in milliseconds
```

## Troubleshooting

### OBS Can't Connect

1. **Check Jetson IP**: Make sure you're using the correct IP address
   ```bash
   # On Jetson
   hostname -I
   ```

2. **Check if stream is running**:
   ```bash
   # On Jetson
   ps aux | grep gst-launch
   ```

3. **Check if port is listening**:
   ```bash
   # On Jetson
   sudo netstat -tulpn | grep 8891
   ```

4. **Check firewall**:
   ```bash
   # On Jetson
   sudo ufw status
   ```

### High Latency

1. Reduce OBS network buffering (try 200 MB)
2. Reduce SRT latency in `streamController.js` (try 100ms)
3. Make sure you're on the same local network

### Stream Drops/Stutters

1. Increase SRT latency (try 200ms or 300ms)
2. Increase OBS network buffering (try 500-1000 MB)
3. Check network quality between Jetson and OBS machine

## SRT vs RTMP vs UDP

| Feature | SRT | RTMP | UDP |
|---------|-----|------|-----|
| **Latency** | 125-300ms | 2-3 seconds | 50-200ms |
| **Reliability** | High (error correction) | High | Low (no error correction) |
| **Network Tolerance** | Excellent | Good | Poor |
| **Setup Complexity** | Medium | Easy | Easy |
| **Best For** | Low latency + reliability | Maximum compatibility | Absolute minimum latency |

## Advanced: Client Mode (Push to SRT Server)

If you want the Jetson to **push** to an external SRT server (like Wowza or another streaming service), you would need to modify `streamController.js` to use `srtsink` instead of `srtserversink`:

```javascript
// Replace srtserversink with srtsink
"srtsink",
`uri=${destination}`, // e.g., srt://server:port
"latency=125",
```

This would allow you to stream to services that accept SRT input.

## Next Steps

- Try different latency values to find the best balance for your network
- Compare SRT latency with RTMP to see the difference
- Use SRT for production streaming when you need low latency with reliability

