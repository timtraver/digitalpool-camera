# OBS Setup Guide for Camera Stream

## Overview
This guide explains how to receive the RTMP stream from your device on your Mac at `rtmp://192.168.1.66:8890`.

## Prerequisites
- OBS Studio installed on your Mac
- Device streaming to `rtmp://192.168.1.66:8890`
- Both devices on the same network

## Option 1: Using nginx-rtmp (Recommended)

### Step 1: Install nginx with RTMP module

```bash
# Install Homebrew if you don't have it
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install nginx with RTMP module
brew tap denji/nginx
brew install nginx-full --with-rtmp-module
```

### Step 2: Configure nginx

Create the configuration directory:
```bash
mkdir -p /usr/local/etc/nginx
```

Create `/usr/local/etc/nginx/nginx.conf` with this content:

```nginx
worker_processes  1;

events {
    worker_connections  1024;
}

rtmp {
    server {
        listen 8890;
        chunk_size 4096;

        application live {
            live on;
            record off;
            
            # Allow publishing from the device
            allow publish all;
            
            # Allow playing from localhost (OBS)
            allow play all;
        }
    }
}

http {
    server {
        listen 8080;
        
        location /stat {
            rtmp_stat all;
            rtmp_stat_stylesheet stat.xsl;
        }
        
        location /stat.xsl {
            root /usr/local/share/nginx/html;
        }
    }
}
```

### Step 3: Start nginx

```bash
# Start nginx
nginx -c /usr/local/etc/nginx/nginx.conf

# To stop nginx later:
# nginx -s stop

# To reload config:
# nginx -s reload
```

### Step 4: Configure OBS

1. Open OBS Studio
2. In the "Sources" panel, click the "+" button
3. Select "Media Source"
4. Name it "Camera"
5. Configure:
   - **Uncheck** "Local File"
   - **Input**: `rtmp://localhost:8890/live/stream`
   - **Check** "Restart playback when source becomes active"
   - **Network Buffering**: 400-1000 MB (lower = less latency)
   - **Reconnect Delay**: 2 seconds
6. Click OK

### Step 5: Start Streaming from the device

1. Open the web interface at `http://<device-ip>:3000`
2. Configure stream settings:
   - **Protocol**: RTMP
   - **Destination**: `rtmp://192.168.1.66:8890/live/stream`
3. Click "Start Stream"

## Option 2: Using MediaMTX (Alternative)

If nginx doesn't work, you can use MediaMTX:

```bash
# Download MediaMTX for macOS
wget https://github.com/bluenviron/mediamtx/releases/download/v1.5.1/mediamtx_v1.5.1_darwin_amd64.tar.gz
tar -xzf mediamtx_v1.5.1_darwin_amd64.tar.gz

# Run MediaMTX
./mediamtx
```

Edit `mediamtx.yml` to listen on port 8890:

```yaml
rtmpAddress: :8890
```

Then use the same OBS configuration as above.

## Troubleshooting

### Stream not appearing in OBS
1. Check nginx is running: `ps aux | grep nginx`
2. Check port 8890 is listening: `lsof -i :8890`
3. Check device can reach your Mac: `ping 192.168.1.66` (from the device)
4. Check firewall settings on Mac (System Preferences → Security & Privacy → Firewall)

### High latency
1. Reduce "Network Buffering" in OBS Media Source settings
2. Use lower bitrate on the device (e.g., 2-3 Mbps instead of 5 Mbps)
3. Consider using SRT protocol instead of RTMP for lower latency

### Stream keeps disconnecting
1. Increase "Network Buffering" in OBS
2. Check network stability
3. Reduce resolution or framerate on the device

## Viewing Stream Stats

Open `http://localhost:8080/stat` in your browser to see nginx RTMP statistics.

## Alternative: Direct Playback in VLC

You can also view the stream directly in VLC:
1. Open VLC
2. File → Open Network
3. Enter: `rtmp://localhost:8890/live/stream`
4. Click Open

