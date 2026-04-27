# Digital Pool Camera Control

A Node.js web service for the **Orange Pi 5 (RK3588)** that turns a USB PTZ camera into a professional live-streaming camera for pool/billiards match production. It streams H.264 video with hardware acceleration via the Rockchip MPP encoder, supports SRT, RTMP, and RTSP output, composites transparent PNG overlays (scoreboards, logos, timestamps) directly into the GStreamer pipeline, and hosts a WiFi access-point hotspot so the control interface is always reachable from a tablet or phone without any external network.

---

## Features

| Category | Details |
|---|---|
| 🎥 **Live preview** | MJPEG preview stream at 5 fps served by GStreamer over TCP |
| 📡 **Professional streaming** | SRT (server mode, port 8891), RTMP (push), RTSP (via MediaMTX) |
| ⚡ **Hardware encoding** | Rockchip MPP `mpph264enc` — 1080p30 at <5 % CPU |
| 🎙️ **Audio** | ALSA mic capture muxed into stream via FFmpeg; long-term A/V sync via `CLOCK_REALTIME` |
| 🎨 **Graphics overlay** | Transparent PNG composited by `gdkpixbufoverlay`; rendered by Puppeteer (headless Chromium) from any remote URL |
| 📝 **Text / timestamp overlay** | `textoverlay` elements in GStreamer pipeline |
| 🕹️ **PTZ camera control** | Pan / Tilt / Zoom via `v4l2-ctl` over Socket.IO |
| ⚙️ **Camera settings** | Brightness, contrast, saturation, exposure, white balance, focus, gain |
| 📶 **WiFi AP hotspot** | Always-on access point (`DigitalPool-Camera`) via NetworkManager |
| 🌐 **Proxy / GraphQL** | Proxies `digitalpool.com` API so the overlay page can run on-device |
| 🔄 **Auto-start** | Systemd service (`digitalpool-camera.service`) starts on boot |

---

## Hardware Requirements

- **SBC**: Orange Pi 5 (RK3588 SoC) — tested with 8 GB RAM
- **Camera**: USB PTZ camera with V4L2/UVC support (tested: OBSBOT Tiny 2 Lite)
- **USB WiFi adapter**: Any Linux-supported adapter capable of AP+STA concurrent mode (for hotspot)
- **Storage**: ≥32 GB microSD card or eMMC
- **Optional**: USB microphone or camera with built-in mic (ALSA device for audio)

---

## 1. Flash the OS — Joshua-Riek Ubuntu 22.04 Rockchip

Use the pre-built Ubuntu 22.04 image from the [Joshua-Riek ubuntu-rockchip](https://github.com/Joshua-Riek/ubuntu-rockchip) project.

### 1a. Download the image

Go to the [Releases page](https://github.com/Joshua-Riek/ubuntu-rockchip/releases) and download the latest **Ubuntu 22.04** server or desktop image for **Orange Pi 5**. Example filename:

```
ubuntu-22.04.x-preinstalled-server-arm64-orangepi-5.img.xz
```

### 1b. Flash to microSD / eMMC

```bash
# On your workstation (Linux/macOS):
xzcat ubuntu-22.04.x-preinstalled-server-arm64-orangepi-5.img.xz | \
  sudo dd of=/dev/sdX bs=4M status=progress conv=fsync
```

Replace `/dev/sdX` with your actual target device (`/dev/sda`, `/dev/mmcblk0`, etc.).
Alternatively use [Balena Etcher](https://etcher.balena.io/) (GUI, cross-platform).

### 1c. First boot

Insert the card, power on, and log in with the default credentials:

```
username: ubuntu
password: ubuntu
```

You will be prompted to change the password on first login.

### 1d. Update the system

```bash
sudo apt update && sudo apt full-upgrade -y
sudo reboot
```

---

## 2. Install System Dependencies

All commands run as the `ubuntu` user (use `sudo` where required).

### 2a. Core build tools and utilities

```bash
sudo apt install -y \
  build-essential git curl wget \
  v4l-utils \
  alsa-utils \
  network-manager \
  python3 python3-pip \
  python3-gi python3-gi-cairo \
  gir1.2-gstreamer-1.0 gir1.2-glib-2.0
```

### 2b. GStreamer 1.0 — full plugin stack

```bash
sudo apt install -y \
  gstreamer1.0-tools \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly \
  gstreamer1.0-libav \
  libgstreamer1.0-dev \
  libgstreamer-plugins-base1.0-dev
```

### 2c. Rockchip MPP hardware encoder / decoder

The MPP (Media Process Platform) plugins provide `mpph264enc` (H.264 hardware encoder) and `mppjpegdec` (JPEG hardware decoder) — the performance-critical elements used by the streaming pipeline.

```bash
sudo apt install -y \
  gstreamer1.0-rockchip \
  librockchip-mpp1 \
  librockchip-mpp-dev \
  librockchip-vpu0
```

> **Verify the encoder is available:**
> ```bash
> gst-inspect-1.0 mpph264enc
> gst-inspect-1.0 mppjpegdec
> ```

### 2d. GDK Pixbuf overlay (PNG compositing into the stream)

```bash
sudo apt install -y \
  gstreamer1.0-gtk3 \
  libgdk-pixbuf2.0-dev
```

> **Verify:**
> ```bash
> gst-inspect-1.0 gdkpixbufoverlay
> ```

### 2e. SRT streaming support

SRT (`srtsink` / `srtserversink`) lives in `gstreamer1.0-plugins-bad` (already installed above). Verify it is present:

```bash
gst-inspect-1.0 srtsink
gst-inspect-1.0 srtserversink
```

If missing, install the libsrt development headers and rebuild:

```bash
sudo apt install -y libsrt-openssl-dev
```

### 2f. FFmpeg (audio muxing in the hybrid A/V pipeline)

```bash
sudo apt install -y ffmpeg
```

### 2g. ImageMagick + wkhtmltoimage (local HTML scoreboard overlay)

```bash
sudo apt install -y imagemagick wkhtmltopdf
```

### 2h. Chromium browser (Puppeteer headless — remote URL overlay)

```bash
sudo apt install -y chromium-browser
```

> The app searches for the Chromium binary at `/usr/bin/chromium-browser`, `/usr/bin/chromium`, and `/snap/bin/chromium`. The standard Ubuntu package installs to `/usr/bin/chromium-browser`.

### 2i. Python GLib / GStreamer bindings (for `gst-overlay-pipeline.py`)

```bash
sudo apt install -y \
  python3-gi \
  python3-gi-cairo \
  gir1.2-gstreamer-1.0 \
  gir1.2-glib-2.0 \
  gir1.2-gdkpixbuf-2.0
```

### 2j. MediaMTX — RTSP / HLS server

MediaMTX provides the RTSP endpoint (`rtsp://<ip>:8554/live`) and HLS endpoint (`http://<ip>:8888/live`). The app pushes to it internally when the **RTSP** protocol is selected.

```bash
# Download the latest arm64 release (adjust version as needed)
MEDIAMTX_VER="v1.12.3"
wget https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VER}/mediamtx_${MEDIAMTX_VER}_linux_arm64v8.tar.gz
tar -xzf mediamtx_${MEDIAMTX_VER}_linux_arm64v8.tar.gz
sudo mv mediamtx /usr/local/bin/
sudo mv mediamtx.yml /etc/mediamtx.yml
```

**Install as a systemd service so it starts before this app:**

```bash
sudo tee /etc/systemd/system/mediamtx.service > /dev/null << 'EOF'
[Unit]
Description=MediaMTX RTSP/HLS Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/mediamtx /etc/mediamtx.yml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable mediamtx
sudo systemctl start mediamtx
```

> **Verify:**
> ```bash
> sudo systemctl status mediamtx
> ```

---

## 3. Install Node.js via nvm

The systemd service file runs Node.js installed through **nvm** (Node Version Manager) as the `ubuntu` user.

```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

# Reload shell environment
source ~/.bashrc

# Install and use Node.js 24
nvm install 24
nvm use 24
nvm alias default 24

# Confirm
node -v    # → v24.x.x
npm -v
```

---

## 4. Clone the Repository and Install Node Dependencies

```bash
cd /home/ubuntu
git clone https://github.com/timtraver/digitalpool-camera.git
cd digitalpool-camera

# Install npm dependencies
npm install

# Optional: install puppeteer-core for remote URL overlay support
npm install puppeteer-core
```

### 4a. Create the environment file

```bash
cat > /home/ubuntu/digitalpool-camera/.env << 'EOF'
NODE_ENV=production
PORT=3000
CAMERA_DEVICE=/dev/video0
EOF
```

Adjust `CAMERA_DEVICE` if your camera appears on a different node (check with `v4l2-ctl --list-devices`).

---

## 5. Open Required Firewall Ports

```bash
sudo ufw allow 3000/tcp    # Web UI / Socket.IO
sudo ufw allow 8554/tcp    # RTSP  (MediaMTX)
sudo ufw allow 8888/tcp    # HLS   (MediaMTX)
sudo ufw allow 8890/tcp    # RTMP  (MediaMTX ingest)
sudo ufw allow 8891/udp    # SRT   (server mode)
sudo ufw allow 8891/tcp    # SRT   (some clients use TCP)
sudo ufw allow 8555/tcp    # GStreamer preview TCP sink
sudo ufw reload
```

---

## 6. Install and Enable the Systemd Service

The repository ships a ready-made service file at `digitalpool-camera.service`.

```bash
sudo cp /home/ubuntu/digitalpool-camera/digitalpool-camera.service \
        /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable digitalpool-camera
sudo systemctl start digitalpool-camera
```

**Check status and follow logs:**

```bash
sudo systemctl status digitalpool-camera
sudo journalctl -u digitalpool-camera -f
```

> The service is declared `Requires=mediamtx.service` — MediaMTX must be running first (Step 2j).

---

## 7. WiFi Access Point (Hotspot)

The app automatically creates and manages a WiFi AP named **DigitalPool-Camera** using NetworkManager (`nmcli`). No extra configuration is required beyond having a WiFi adapter plugged in.

| Setting | Default value |
|---|---|
| SSID | `DigitalPool-Camera` |
| Password | `digitalpool` |
| AP IP | `192.168.50.1` |
| Admin URL | `http://192.168.50.1:3000` |

After connecting your phone or tablet to the hotspot, open `http://192.168.50.1:3000` to access the full control interface.

> The AP runs concurrently alongside any regular WiFi client connection (AP+STA mode), so the Orange Pi 5 can be connected to your venue network and still serve the hotspot at the same time.

---

## 8. Accessing the Web Interface

| URL | Description |
|---|---|
| `http://<device-ip>:3000` | Main camera control UI (LAN) |
| `http://192.168.50.1:3000` | Control UI via WiFi hotspot |
| `rtsp://<device-ip>:8554/live` | RTSP stream (OBS, VLC, FFmpeg) |
| `http://<device-ip>:8888/live` | HLS stream (browser) |
| `srt://<device-ip>:8891` | SRT stream (OBS Media Source) |

---

## 9. Configuration

Stream settings are persisted automatically to `stream-config.json` via the web UI. You can also override key values with environment variables in `.env`:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP / Socket.IO server port |
| `CAMERA_DEVICE` | `/dev/video0` | V4L2 camera device node |

Key stream settings (configured via the UI, saved to `stream-config.json`):

| Setting | Default | Description |
|---|---|---|
| Protocol | `rtsp` | `rtsp`, `srt`, or `rtmp` |
| Resolution | `1920×1080` | Width × Height |
| Framerate | `30` fps | Capture and encode rate |
| Bitrate | `5 Mbps` | H.264 target bitrate |
| Audio device | `hw:3,0` | ALSA device for microphone |
| Audio enabled | `true` | Mux audio into stream |

---

## 10. Camera Controls

### Pan / Tilt / Zoom

- **Directional pad** (or arrow keys): Pan / Tilt in 1° steps (hold Shift for 5°)
- **Home button**: Reset to saved startup position
- **Zoom slider**: Optical zoom 0–100

### Image Quality

Brightness · Contrast · Saturation · Sharpness (0–100)

### Exposure

Auto exposure · Manual exposure time (1–2500) · Gain (1–64) · Backlight compensation (0–18)

### White Balance

Auto white balance toggle · Manual temperature (2000–10000 K)

### Focus

Auto focus toggle · Manual focus (0–100)

---

## 11. Graphics / Scoreboard Overlay

The GStreamer pipeline composites a transparent PNG (`/tmp/graphics-overlay.png`) onto every encoded frame using `gdkpixbufoverlay`.

### Remote URL mode (recommended)

1. In the UI enable **Remote Overlay** and paste the URL of your scoreboard page (a DigitalPool.com match page, a local React app, etc.).
2. The app launches headless Chromium via Puppeteer, screenshots the page at 1920×1080 with native transparency (`omitBackground: true`), and saves it to `/tmp/graphics-overlay.png`.
3. `gdkpixbufoverlay` composites the PNG onto every encoded frame; the file is re-read periodically so the overlay updates live.

### Local scoreboard mode

Enable the **Overlay** toggle (without a remote URL). The app uses `wkhtmltoimage` + ImageMagick chroma-key to render `public/overlay.html` with the current player names and scores.

---

## 12. Streaming to OBS

### RTSP (recommended for simplicity)

In OBS → Sources → Add → **Media Source**:

```
Input: rtsp://<device-ip>:8554/live
```

### SRT (lowest latency — ~125 ms)

```
Input: srt://<device-ip>:8891
Network Buffering: 200–500 MB
```

The device acts as an **SRT server**; OBS connects as a client.

### RTMP (push to an external ingest)

Set the destination in the UI to your RTMP ingest URL, e.g.:

```
rtmp://your-server/live/stream-key
```

---

## 13. Project Structure

```
digitalpool-camera/
├── server.js                  # Express + Socket.IO server; main orchestrator
├── streamController.js        # GStreamer pipeline builder & stream lifecycle
├── cameraController.js        # v4l2-ctl wrappers (PTZ, image controls)
├── wifiManager.js             # NetworkManager AP hotspot management
├── puppeteerOverlay.js        # Headless Chromium → transparent PNG overlay
├── gst-overlay-pipeline.py    # Python GStreamer pipeline (dynamic PNG reload)
├── png-overlay-helper.sh      # Shell wrapper invoking the Python script
├── digitalpool-camera.service # Systemd unit file
├── package.json
├── .env                       # Environment variables (create — see Step 4a)
├── stream-config.json         # Auto-generated stream settings (persisted by UI)
└── public/
    ├── index.html             # Web control interface
    ├── app.js                 # Client-side Socket.IO + UI logic
    ├── overlay.html           # Local scoreboard HTML template
    └── style.css
```

---

## 14. API Reference

### REST endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Web control interface |
| `GET` | `/api/controls` | All camera control values |
| `GET` | `/api/control/:name` | Single control value |
| `POST` | `/api/control/:name` | Set control `{ "value": N }` |
| `GET` | `/api/stream/status` | Stream status JSON |
| `GET` | `/api/stream/config` | Stream configuration JSON |
| `POST` | `/api/stream/start` | Start streaming |
| `POST` | `/api/stream/stop` | Stop streaming |
| `GET` | `/api/wifi/status` | WiFi AP + client network status |
| `GET` | `/api/wifi/networks` | Scan nearby networks |
| `POST` | `/api/wifi/connect` | Connect to a WiFi network |

### Socket.IO events (client → server)

| Event | Payload | Action |
|---|---|---|
| `setControl` | `{ control, value }` | Set a v4l2 camera control |
| `pan` | `{ degrees }` | Pan camera (positive = left) |
| `tilt` | `{ degrees }` | Tilt camera |
| `zoom` | `{ level }` | Set zoom 0–100 |
| `resetPosition` | — | Return to saved startup position |
| `setStartupPosition` | — | Save current PTZ as startup |
| `startStream` | `{ ...config }` | Start stream with optional config overrides |
| `stopStream` | — | Stop stream |

### Socket.IO events (server → client)

| Event | Payload |
|---|---|
| `streamStatus` | `{ status, protocol, destination, … }` |
| `cameraConfig` | Full control map with current values |
| `controlResult` | `{ success, … }` |
| `scoreUpdated` | Current game state (player names, scores, match title) |

---

## 15. Troubleshooting

### Camera not detected

```bash
v4l2-ctl --list-devices
ls -l /dev/video*

# Add the ubuntu user to the video group if needed:
sudo usermod -aG video ubuntu
newgrp video   # or log out and back in
```

### Hardware encoder not found

```bash
gst-inspect-1.0 mpph264enc
# If missing:
sudo apt install --reinstall gstreamer1.0-rockchip
```

### SRT port not reachable from OBS

```bash
sudo netstat -tulpn | grep 8891
sudo ufw status
```

### MediaMTX not running

```bash
sudo systemctl status mediamtx
sudo journalctl -u mediamtx -n 50
```

### Puppeteer / Chromium overlay fails to launch

```bash
chromium-browser --version
which chromium-browser

# If sandboxing is blocked by the kernel:
sudo sysctl -w kernel.unprivileged_userns_clone=1
# Make it persistent:
echo 'kernel.unprivileged_userns_clone=1' | sudo tee /etc/sysctl.d/99-chrome-sandbox.conf
```

### Audio / video drift after long streams

Ensure the Python script (`gst-overlay-pipeline.py`) is being used rather than the raw shell pipeline — it forces GStreamer's system clock to `CLOCK_REALTIME`, matching FFmpeg's `av_gettime` source and eliminating long-term drift between the video and audio PTS streams.

### Permission denied on camera device

```bash
sudo usermod -aG video ubuntu
# Verify:
groups ubuntu
```

### Follow live logs

```bash
sudo journalctl -u digitalpool-camera -f
sudo journalctl -u mediamtx -f
```

---

## License

ISC

## Author

Tim Traver — [github.com/timtraver](https://github.com/timtraver)
