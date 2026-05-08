# Digital Pool Camera Control

A Node.js web service for the **Orange Pi 5 (RK3588)** that turns a USB PTZ camera into a professional live-streaming camera for pool/billiards match production. It streams H.264 video with hardware acceleration via the Rockchip MPP encoder, supports SRT, RTMP, and RTSP output, composites transparent PNG overlays (scoreboards, logos, timestamps) directly into the GStreamer pipeline, and hosts a WiFi access-point hotspot so the control interface is always reachable from a tablet or phone without any external network.

---

## Features

| Category | Details |
|---|---|
| 🎥 **Live preview** | WebRTC preview at 15 fps via MediaMTX WHEP protocol; hardware H.264 via Rockchip MPP |
| 📡 **Professional streaming** | SRT (server mode, port 8891), RTMP (push), RTSP (via MediaMTX) |
| ⚡ **Hardware encoding** | Rockchip MPP `mpph264enc` / `mpph265enc` — 1080p30 at <5 % CPU |
| 🎙️ **Audio** | ALSA mic capture muxed into stream via FFmpeg; long-term A/V sync via `CLOCK_REALTIME` |
| 🎨 **Graphics overlay** | Transparent PNG composited by `gdkpixbufoverlay`; rendered by Puppeteer (headless Chromium) from any remote URL |
| 📝 **Text / timestamp overlay** | `textoverlay` elements in GStreamer pipeline |
| 🕹️ **PTZ camera control** | Pan / Tilt / Zoom via `v4l2-ctl` over Socket.IO |
| ⚙️ **Camera settings** | Brightness, contrast, saturation, exposure, white balance, focus, gain |
| 📶 **WiFi AP hotspot** | Always-on access point (`DigitalPool-Camera`) via NetworkManager |
| 🌐 **Proxy / GraphQL** | Proxies `digitalpool.com` API so the overlay page can run on-device |
| 🔄 **Auto-start** | Systemd service (`digitalpool-camera.service`) starts on boot |
| 📲 **NDI input** | Receive NDI / NDI HX / HX2 / HX3 network video sources — auto-detects compressed vs raw, hardware-decodes on RK3588 |

---

## Hardware Requirements

- **SBC**: Orange Pi 5 (RK3588 SoC) — tested with 8 GB RAM
- **Camera**: USB PTZ camera with V4L2/UVC support (tested: OBSBOT Tiny 2 Lite)
- **USB WiFi adapter**: Any Linux-supported adapter capable of AP+STA concurrent mode (for hotspot)
- **Storage**: ≥32 GB microSD card or eMMC
- **Optional**: USB microphone or camera with built-in mic (ALSA device for audio)

---

## 1. Flash the OS — Joshua-Riek Ubuntu 24.04 Rockchip

Use the pre-built Ubuntu 24.04 (Noble) image from the [Joshua-Riek ubuntu-rockchip](https://github.com/Joshua-Riek/ubuntu-rockchip) project.

> **Note:** Although the project also publishes 22.04 images, the actively maintained and recommended release for Orange Pi 5 is **Ubuntu 24.04 Noble**. The Rockchip-specific packages (MPP encoder, GStreamer plugin, firmware) in the PPAs target Noble.

### 1a. Download the image

Go to the [Releases page](https://github.com/Joshua-Riek/ubuntu-rockchip/releases) and download the latest **Ubuntu 24.04** server or desktop image for **Orange Pi 5**. Example filename:

```
ubuntu-24.04.x-preinstalled-server-arm64-orangepi-5.img.xz
```

### 1b. Flash to microSD / eMMC

```bash
# On your workstation (Linux/macOS):
xzcat ubuntu-24.04.x-preinstalled-server-arm64-orangepi-5.img.xz | \
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

### 1e. Reduce microSD card wear — disable atime

Every file read on a standard Linux mount triggers an `atime` (access time) write back to the filesystem metadata. On a microSD card this is pure wasted write wear with no practical benefit. Switching the root and boot partitions to `noatime` eliminates these writes and significantly extends card lifespan.

**Edit `/etc/fstab`:**

```bash
sudo nano /etc/fstab
```

Your current entries will look something like:

```
LABEL=writable  /       ext4  defaults        0 1
LABEL=system-boot /boot/firmware vfat defaults 0 1
```

Add `noatime` to the options field of every partition that lives on the SD card:

```
LABEL=writable    /               ext4  defaults,noatime        0 1
LABEL=system-boot /boot/firmware  vfat  defaults,noatime        0 1
```

> **`noatime`** suppresses all access-time updates entirely — the safest choice for an embedded device that runs unattended and where you never need to know when a file was last read.
>
> If you have software that relies on atime (unlikely here), use **`relatime`** instead — it only writes atime when the file has been modified since the last read, giving most of the benefit with full POSIX compatibility.

**Verify the change without rebooting:**

```bash
sudo mount -o remount,noatime /
sudo mount -o remount,noatime /boot/firmware
```

Then confirm it took effect:

```bash
findmnt -o TARGET,OPTIONS / /boot/firmware
```

You should see `noatime` listed in the options column. The change will persist automatically after the next reboot because it is now in `/etc/fstab`.

### 1f. Prevent needrestart from auto-restarting the stream service

Ubuntu's `unattended-upgrades` package runs nightly package upgrades automatically. After an upgrade it invokes `needrestart`, which detects that the camera service is using updated shared libraries and sends it `SIGTERM` — silently interrupting your live stream at whatever hour the upgrade runs (typically ~06:45).

By default `needrestart` is set to **automatic** mode (`a`), meaning it restarts any affected service without prompting. Change it to **interactive** mode (`i`) so it only acts when a human is sitting at a terminal:

```bash
sudo nano /etc/needrestart/needrestart.conf
```

Find the line:
```
#$nrconf{restart} = 'i';
```

Uncomment it and change the value to `i` (it may already say `i` when uncommented — the key is that the line is **not commented out** and reads `i`, not `a`):
```
$nrconf{restart} = 'i';
```

Save and exit. The change takes effect on the next upgrade run — no restart required.

> **Why not disable `unattended-upgrades` entirely?** Security patches still matter even on an appliance. Interactive mode keeps automatic security updates active but prevents any service from being restarted without a human present.

**Verify the setting:**
```bash
grep 'nrconf{restart}' /etc/needrestart/needrestart.conf
# Should print: $nrconf{restart} = 'i';
```

**To diagnose a past unexpected restart**, look in the journal at the exact minute the service stopped:
```bash
# Replace the timestamp with the time shown in your app log
sudo journalctl --since "2026-05-08 06:43:00" --until "2026-05-08 06:46:30" --no-pager
```
If you see `apt-daily-upgrade.service` starting immediately before `digitalpool-camera.service: Deactivated successfully`, the cause is confirmed as `needrestart`.

---

### 1g. Prevent the root volume from filling up — log rotation

An unattended device running 24/7 will accumulate logs from systemd-journald, the kernel, the application, and various system services. Left unchecked these will eventually fill the microSD card and crash everything. Two things control this: **journald** (the main log sink for all systemd services) and **logrotate** (for traditional `/var/log` files).

#### Limit the systemd journal

By default journald keeps up to 10 % of the filesystem. On a 32 GB card that is ~3 GB of logs — far more than you will ever need. Create a drop-in config to cap it tightly:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d

sudo tee /etc/systemd/journald.conf.d/size-limit.conf > /dev/null << 'EOF'
[Journal]
# Keep the journal on disk but cap total size
Storage=persistent
# Hard cap on total disk use across all journal files
SystemMaxUse=100M
# Always keep at least this much disk free
SystemKeepFree=200M
# Rotate individual journal files at this size
SystemMaxFileSize=20M
# Discard entries older than one week
MaxRetentionSec=1week
# Also limit the in-memory (runtime) journal
RuntimeMaxUse=20M
EOF
```

Apply immediately without rebooting:

```bash
sudo systemctl restart systemd-journald
# Vacuum any existing files down to the new limits right now
sudo journalctl --vacuum-size=100M
sudo journalctl --vacuum-time=1week
```

Confirm the new limits are active:

```bash
journalctl --disk-usage
```

#### Verify logrotate is running

Ubuntu 24.04 runs logrotate via a systemd timer (not cron). Confirm it is enabled:

```bash
sudo systemctl status logrotate.timer
```

If it is not active, enable it:

```bash
sudo systemctl enable --now logrotate.timer
```

Logrotate handles `/var/log/syslog`, `/var/log/kern.log`, `/var/log/auth.log`, and other traditional log files automatically. You can force a rotation immediately to test:

```bash
sudo logrotate --force /etc/logrotate.conf
```

#### Monitor free space

Add a quick alias to your `~/.bashrc` so you can check disk use at a glance:

```bash
echo "alias diskcheck='df -h / && journalctl --disk-usage'" >> ~/.bashrc
source ~/.bashrc
```

Run `diskcheck` any time to see root volume free space and journal size together.

### 1h. Add swap space

The Orange Pi 5 has 4 GB of RAM and **no swap by default**. The camera service, GStreamer pipeline, and ffmpeg together can peak at 2–3 GB under load. Without swap, the OOM killer will silently terminate processes and make the device appear unresponsive. A 2 GB swap file gives the OS room to page out cold memory rather than killing services.

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make permanent across reboots
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Verify
free -h
```

### 1i. Disable sleep and suspend

An IoT device running headless must never suspend — a missed keep-alive or an idle timeout will take the camera completely offline with no way to recover it remotely.

```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

Verify none of them are active:

```bash
sudo systemctl status sleep.target suspend.target
```

Both should show `masked`.

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

The MPP (Media Process Platform) plugins provide `mpph264enc` / `mpph265enc` (hardware encoders) and `mppjpegdec` (JPEG hardware decoder). These packages come from Joshua-Riek's Launchpad PPAs, **not** the standard Ubuntu repositories, so the PPAs must be added first.

> **Note:** The GStreamer Rockchip plugin package is named **`gstreamer1.0-rockchip1`** (with a trailing `1`) — not `gstreamer1.0-rockchip`. Also note that `librockchip-mpp1` is typically pre-installed by the Joshua-Riek image but is listed here for completeness.

```bash
# software-properties-common provides add-apt-repository
sudo apt install -y software-properties-common

# Base Rockchip packages (librockchip-mpp, librockchip-vpu, etc.)
sudo add-apt-repository -y ppa:jjriek/rockchip

# GStreamer Rockchip plugin (gstreamer1.0-rockchip1)
sudo add-apt-repository -y ppa:jjriek/rockchip-multimedia

sudo apt update
```

Now install the packages:

```bash
sudo apt install -y \
  gstreamer1.0-rockchip1 \
  librockchip-mpp1 \
  librockchip-mpp-dev \
  librockchip-vpu0
```

> **Verify the encoders and decoders are available:**
> ```bash
> gst-inspect-1.0 mpph264enc    # H.264 hardware encoder
> gst-inspect-1.0 mpph265enc    # H.265 hardware encoder
> gst-inspect-1.0 mpph264dec    # H.264 hardware decoder (NDI HX / HX2)
> gst-inspect-1.0 mpph265dec    # H.265 hardware decoder (NDI HX3)
> gst-inspect-1.0 mppjpegdec    # JPEG hardware decoder
> ```
>
> All five elements must be present for the full feature set. If any are missing, reinstall `gstreamer1.0-rockchip1` and clear the plugin registry:
> ```bash
> sudo apt install --reinstall gstreamer1.0-rockchip1
> rm -f ~/.cache/gstreamer-1.0/registry.aarch64.bin
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

### 2g. Timezone data

Required for the **Timezone** setting in Admin Settings. Without this package, `timedatectl set-timezone` will fail because the zone files in `/usr/share/zoneinfo/` won't exist.

```bash
sudo apt install -y tzdata
```

### 2h. ImageMagick + wkhtmltoimage (local HTML scoreboard overlay)

```bash
sudo apt install -y imagemagick wkhtmltopdf
```

### 2i. Chromium browser (Puppeteer headless — remote URL overlay)

```bash
sudo apt install -y chromium-browser
```

> The app searches for the Chromium binary at `/usr/bin/chromium-browser`, `/usr/bin/chromium`, and `/snap/bin/chromium`. The standard Ubuntu package installs to `/usr/bin/chromium-browser`.

### 2j. Python GLib / GStreamer bindings (for `gst-overlay-pipeline.py`)

```bash
sudo apt install -y \
  python3-gi \
  python3-gi-cairo \
  gir1.2-gstreamer-1.0 \
  gir1.2-glib-2.0 \
  gir1.2-gdkpixbuf-2.0
```

### 2k. MediaMTX — RTSP / HLS server

MediaMTX provides the RTSP endpoint (`rtsp://<ip>:8554/live`) and HLS endpoint (`http://<ip>:8888/live`). The app pushes to it internally when the **RTSP** protocol is selected.

```bash
# Download the latest arm64 release (check https://github.com/bluenviron/mediamtx/releases for newer versions)
MEDIAMTX_VER="v1.18.0"
wget https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VER}/mediamtx_${MEDIAMTX_VER}_linux_arm64.tar.gz
tar -xzf mediamtx_${MEDIAMTX_VER}_linux_arm64.tar.gz
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

**Enable the MediaMTX Control API** (required for the live stream bitrate display and connected-clients panel in the web UI):

```bash
# The API is off by default — enable it so Node.js can read stream stats
sudo sed -i 's/^api: false/api: yes/' /etc/mediamtx.yml

# Verify the change
grep '^api:' /etc/mediamtx.yml   # should print: api: yes

# Restart to apply
sudo systemctl restart mediamtx
```

The API listens on `127.0.0.1:9997` (localhost only — not exposed externally). The camera app polls `GET /v3/paths/get/live` once per second to read the encoded stream bitrate.

**Enable the MediaMTX authentication hook** (required for the IP ban feature to block clients before they connect):

Edit `/etc/mediamtx.yml` and set these three lines (they already exist in the file — find and update them):

```yaml
authMethod: http
authHTTPAddress: http://127.0.0.1:3000/api/mediamtx/auth
authHTTPExclude:
  - action: publish
```

> **Important notes on editing `mediamtx.yml`:**
> - `authMethod` replaces the default `authMethod: internal` line — change only the value, not the key.
> - `authHTTPAddress` is a separate line that must appear after `authMethod`.
> - `authHTTPExclude` **must** include `- action: publish` to allow the local GStreamer/ffmpeg publisher to push video to MediaMTX without going through the auth hook. Without this, the stream will fail to start.
> - The `authHTTPExclude` entry only accepts `action` and `path` sub-fields — **do not add an `ips` field**, it is not supported and will crash MediaMTX.

Verify and restart:

```bash
grep -n 'authMethod\|authHTTPAddress\|authHTTPExclude' /etc/mediamtx.yml
# Expected (line numbers will differ):
#   58: authMethod: http
#   59: authHTTPAddress: http://127.0.0.1:3000/api/mediamtx/auth
#   60: authHTTPExclude:
#   61:   - action: publish

sudo systemctl restart mediamtx
sudo systemctl status mediamtx   # must show "active (running)", not "failed"
```

For every incoming viewer connection (RTSP, SRT, RTMP, WebRTC) MediaMTX calls `POST /api/mediamtx/auth` on the camera app before the session is established. The camera app returns HTTP 200 to allow or HTTP 403 to reject. Banned IPs are refused at this point — they never complete the connection. Publish actions (the local ffmpeg/GStreamer source) bypass the hook entirely via `authHTTPExclude`.

> **Note:** Without the auth hook the ban feature still works, but banned clients can connect briefly before the auto-kick on the next 2-second poll removes them. The auth hook eliminates that window entirely.

### 2k.2. MediaMTX — WebRTC ICE host update script

The admin preview uses WebRTC (WHEP protocol). For WebRTC to work from every network interface — LAN, Tailscale (`100.x.x.x`), and the WiFi hotspot — MediaMTX must include each interface's IP address in its SDP ICE candidates. The `mediamtx-update-hosts.sh` script (included in the repo) detects all current non-loopback IPv4 addresses at startup and injects them into `webrtcAdditionalHosts` in `/etc/mediamtx.yml`.

```bash
# Install the script
sudo cp ~/digitalpool-camera/mediamtx-update-hosts.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/mediamtx-update-hosts.sh

# Hook it into the mediamtx systemd service as a pre-start step
sudo mkdir -p /etc/systemd/system/mediamtx.service.d
sudo tee /etc/systemd/system/mediamtx.service.d/update-hosts.conf << 'EOF'
[Service]
ExecStartPre=/usr/local/bin/mediamtx-update-hosts.sh
EOF

sudo systemctl daemon-reload
sudo systemctl restart mediamtx

# Verify — should list all local IPs including Tailscale and hotspot
grep webrtcAdditionalHosts /etc/mediamtx.yml
```

The script runs automatically every time mediamtx starts, so it picks up new Tailscale IPs or hotspot interface changes without manual intervention.

### 2l. NDI (Network Device Interface) Support

NDI lets the Orange Pi 5 receive a network video feed from any NDI sender on the same LAN — OBS, NewTek TriCaster, Mac Scan Converter, vMix, etc. — and re-stream it through the normal hardware-encode pipeline. Both standard NDI (uncompressed `video/x-raw`) and the compressed variants **NDI HX / HX2** (H.264) and **NDI HX3** (H.265) are supported; the pipeline auto-detects the format at runtime.

Two components are required: the **NDI SDK runtime library** (`libndi.so.6`) and the **GStreamer NDI plugin** (Teltek `gst-plugin-ndi`, providing `ndisrc` and `ndisrcdemux`).

#### Step 1 — Install the NDI SDK runtime library

Download the NDI SDK for Linux from the official NDI developer site:

> **Download:** https://ndi.video/for-developers/ndi-sdk/download/
> Choose **Linux** → download the `.tar.gz` or self-extracting `.sh` installer.

Extract / run the installer, then copy the shared library to `/usr/local/lib`:

```bash
# Example — exact filename varies by SDK version:
# tar -xzf NDI_SDK_Linux.tar.gz
# The library will be inside the extracted directory, e.g.:
sudo cp ./NDI\ SDK\ for\ Linux/lib/aarch64-linux-gnu/libndi.so.6 /usr/local/lib/
sudo chmod 755 /usr/local/lib/libndi.so.6

# Refresh the dynamic linker cache so other programs can find it:
sudo ldconfig

# Verify:
ldconfig -p | grep libndi
# Should print:  libndi.so.6 (libc6,AArch64) => /usr/local/lib/libndi.so.6
```

> **Version note:** The app and `ndi-discover.py` hard-code the path `/usr/local/lib/libndi.so.6`. If you install a different major version (e.g. `.so.5` or `.so.7`), either create a symlink or update that path.

```bash
# Symlink example for a different major version:
sudo ln -sf /usr/local/lib/libndi.so.X /usr/local/lib/libndi.so.6
sudo ldconfig
```

#### Step 2 — Install the GStreamer NDI plugin (Teltek gst-plugin-ndi)

The GStreamer NDI plugin is written in Rust and provides the `ndisrc` and `ndisrcdemux` elements used by this app. Build it from source on the Orange Pi:

```bash
# Install Rust toolchain (if not already present):
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# Install GStreamer development headers (needed for linking):
sudo apt install -y \
  libgstreamer1.0-dev \
  libgstreamer-plugins-base1.0-dev \
  libgstreamer-plugins-bad1.0-dev

# Clone and build the Teltek plugin:
git clone https://github.com/teltek/gst-plugin-ndi.git
cd gst-plugin-ndi

# Point the build system at the NDI SDK headers (adjust path to match your SDK):
export NDI_SDK_DIR="$HOME/NDI SDK for Linux"
# Or if you only copied the .so (no headers), set the library path:
export LIBRARY_PATH=/usr/local/lib:$LIBRARY_PATH

cargo build --release

# Install the compiled plugin into the system GStreamer plugin directory:
sudo cp target/release/libgstndi.so \
     /usr/lib/aarch64-linux-gnu/gstreamer-1.0/

# Refresh the GStreamer plugin registry:
gst-inspect-1.0 ndisrc   # must succeed — prints element details
gst-inspect-1.0 ndisrcdemux
```

> **Tip:** If you do not have the NDI SDK headers, the plugin repository also publishes pre-built binaries in its Releases section for some architectures. Check https://github.com/teltek/gst-plugin-ndi/releases.

#### Step 3 — Verify the complete NDI stack

```bash
# 1. NDI library loads:
python3 /home/ubuntu/digitalpool-camera/ndi-discover.py 3000
# Should print a JSON array — empty [] if no NDI sources are on the network,
# or a list like: [{"name": "MY-MAC (Scan Converter)", "url": "192.168.1.5:5960"}]

# 2. GStreamer elements present:
gst-inspect-1.0 ndisrc
gst-inspect-1.0 ndisrcdemux

# 3. For NDI HX/HX3 — hardware decoders must be present:
gst-inspect-1.0 mpph264dec   # H.264 hardware decoder (NDI HX / HX2)
gst-inspect-1.0 mpph265dec   # H.265 hardware decoder (NDI HX3)
# If missing: sudo apt install --reinstall gstreamer1.0-rockchip1
```

#### NDI firewall rules

NDI uses mDNS for source discovery and TCP/UDP for the actual video stream. Add these rules so NDI traffic can pass:

```bash
sudo ufw allow 5353/udp    # mDNS — NDI source discovery (multicast)
sudo ufw allow 5960/tcp    # NDI connection initiation
sudo ufw allow 5961/udp    # NDI video/audio stream data
# NDI may also negotiate additional dynamic ports above 49152.
# If discovery or streaming fails through a router, open the full range:
# sudo ufw allow 49152:65535/udp
sudo ufw reload
```

> **Same-subnet rule:** NDI discovery relies on mDNS multicast (`224.0.0.251`). The Orange Pi and the NDI sender **must be on the same Layer-2 network segment** — NDI does not cross routers unless a dedicated NDI routing/bridging solution is in use.

#### Using NDI as the video source

1. In the camera control UI go to **Input Source → NDI**.
2. Click **Scan for NDI Sources** — the app runs `ndi-discover.py` and lists all visible senders.
3. Select a source and click **Apply**. The idle preview will switch within ~12 seconds.
4. Start the stream normally — the pipeline auto-detects standard vs HX/HX2/HX3 and inserts a hardware decoder if needed.

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

**Create a stable symlink for systemd**

nvm installs node at a path that includes the exact version number (e.g. `~/.nvm/versions/node/v24.3.0/bin/node`). Systemd does not source your shell profile, so it cannot use nvm directly and will fail if the service file hard-codes a version that doesn't match. Create a stable symlink at a fixed system path that the service file can always rely on:

```bash
sudo ln -sf "$(which node)" /usr/local/bin/node
sudo ln -sf "$(which npm)"  /usr/local/bin/npm

# Verify
/usr/local/bin/node -v
```

Whenever you upgrade Node via nvm (`nvm install 26` etc.) re-run the `ln -sf` commands above to keep the symlink current.

---

## 4. Clone the Repository and Install Node Dependencies

```bash
cd /home/ubuntu
git clone https://github.com/timtraver/digitalpool-camera.git
cd digitalpool-camera

# Install npm dependencies
npm install

# Required for remote URL overlay support (must match Chromium 114 — do NOT use latest)
npm install puppeteer-core@20.9.0
```

### 4a. Create the environment file

The three core environment variables (`NODE_ENV`, `PORT`, `CAMERA_DEVICE`) are already hard-coded as `Environment=` lines inside `digitalpool-camera.service`, so the `.env` file is optional for a default setup. Create it if you want to **override** any of those values without editing the service file, or to add additional variables used by the app at startup:

```bash
cat > /home/ubuntu/digitalpool-camera/.env << 'EOF'
NODE_ENV=production
PORT=3000
CAMERA_DEVICE=/dev/video0
EOF
```

Adjust `CAMERA_DEVICE` if your camera appears on a different node (check with `v4l2-ctl --list-devices`).

> **Note:** Values set in `.env` take effect when `server.js` reads them at startup via `dotenv`. The `Environment=` lines in the service file are the authoritative defaults; `.env` overrides them for the Node.js process only (child processes like GStreamer are not affected by `.env`).

---

## 5. Open Required Firewall Ports

```bash
sudo ufw allow 3000/tcp    # Web UI / Socket.IO
sudo ufw allow 8554/tcp    # RTSP  (MediaMTX)
sudo ufw allow 8888/tcp    # HLS   (MediaMTX)
sudo ufw allow 8889/udp    # WebRTC media (MediaMTX — admin preview + WHEP)
sudo ufw allow 8890/tcp    # RTMP  (MediaMTX ingest)
sudo ufw allow 8891/udp    # SRT   (server mode)
sudo ufw allow 8891/tcp    # SRT   (some clients use TCP)
# NDI source input (see section 2l for details)
sudo ufw allow 5353/udp    # mDNS  (NDI source discovery)
sudo ufw allow 5960/tcp    # NDI   (connection initiation)
sudo ufw allow 5961/udp    # NDI   (stream data)
sudo ufw reload
```

To check which ports are currently open on an existing install:

```bash
sudo ufw status numbered
```

If port 8889/udp is missing from the list, add it and reload:

```bash
sudo ufw allow 8889/udp
sudo ufw reload
```

If port 8555/tcp is still listed (old GStreamer MJPEG preview sink — no longer used), you can remove it:

```bash
# Find the rule number first
sudo ufw status numbered | grep 8555
# Then delete it (replace N with the number shown)
sudo ufw delete N
sudo ufw reload
```

---

## 6. Install and Enable the Systemd Service

The repository ships a ready-made service file at `digitalpool-camera.service`. It uses `/usr/local/bin/node` — the stable symlink you created in Step 3 — so it is not tied to any specific nvm version number.

**Make sure the symlink exists before continuing:**

```bash
/usr/local/bin/node -v   # must print a version number, not "not found"
```

If it prints "not found", go back and run the `ln -sf` commands at the end of Step 3.

**Install and start the service:**

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

## 6b. System Reliability — Memory Limits & Watchdogs

An unattended camera running 24/7 can become unreachable if a gradual memory leak fills RAM, or if a USB WiFi driver stalls and stops passing traffic. Three layers of protection prevent either scenario from requiring a physical power-cycle.

### Layer 1 — Cgroup memory ceiling (already in the service file)

The shipped `digitalpool-camera.service` already includes:

```ini
MemoryMax=2500M
MemorySwapMax=0
OOMScoreAdjust=-900
```

`MemoryMax` puts a hard cgroup ceiling on the Node.js process and **all its children** (GStreamer, ffmpeg, Python). If a leak occurs, systemd kills and restarts *only this service* cleanly before RAM pressure reaches the kernel level. `MemorySwapMax=0` prevents child processes from swapping out (keeps latency predictable for live video). `OOMScoreAdjust=-900` tells the OOM killer to strongly prefer killing anything else first if pressure does reach the kernel.

No extra steps are needed — the service file is already set.

### Layer 2 — Network watchdog (reboots if all interfaces are unreachable)

The repository includes `network-watchdog.sh`, `network-watchdog.service`, and `network-watchdog.timer`. The timer runs every 10 minutes; if both Ethernet and WiFi have been unreachable for 20 consecutive minutes the script reboots the device cleanly.

```bash
# Copy the watchdog script
sudo cp /home/ubuntu/digitalpool-camera/network-watchdog.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/network-watchdog.sh

# Install the systemd units
sudo cp /home/ubuntu/digitalpool-camera/network-watchdog.service \
        /home/ubuntu/digitalpool-camera/network-watchdog.timer \
        /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable --now network-watchdog.timer

# Confirm the timer is scheduled
systemctl list-timers network-watchdog.timer
```

### Layer 3 — Hardware watchdog (last resort if the kernel itself freezes)

The RK3588 SoC has a hardware watchdog at `/dev/watchdog0`. If systemd stops petting it (because the kernel has completely locked up), the hardware forces a board reset after 60 seconds — even a kernel panic can't prevent this.

> **Note:** The service file deliberately omits `WatchdogSec`. With `Type=simple`, systemd uses `WatchdogSec / 2` as the effective kill threshold, and keepalives sent from Node.js child processes are rejected when `NotifyAccess=main` is set. This combination caused the service to be killed and restarted every ~60 seconds even when it was running perfectly. The hardware watchdog above provides equivalent last-resort protection without this complication.

```bash
sudo mkdir -p /etc/systemd/system.conf.d

sudo tee /etc/systemd/system.conf.d/watchdog.conf > /dev/null << 'EOF'
[Manager]
RuntimeWatchdogSec=60
RebootWatchdogSec=10min
EOF

sudo systemctl daemon-reload

# Verify it was picked up
sudo systemctl show | grep -i watchdog
# Should show: RuntimeWatchdogSec=1min
```

### Layer 4 — Memory flight recorder (diagnose crashes)

The repository includes `monitor-camera.sh` which runs every 5 minutes and appends a per-process memory snapshot to `/var/log/digitalpool-monitor.log`. After any overnight crash, open this file to immediately see which process was growing and when it hit its limit.

```bash
# Install the flight recorder
sudo cp /home/ubuntu/digitalpool-camera/monitor-camera.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/monitor-camera.sh
sudo cp /home/ubuntu/digitalpool-camera/monitor-camera.service \
        /home/ubuntu/digitalpool-camera/monitor-camera.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now monitor-camera.timer

# Verify it is running
systemctl list-timers monitor-camera.timer

# Watch the log live
tail -f /var/log/digitalpool-monitor.log
```

Sample output every 5 minutes:
```
=== 2025-05-01 02:15:00 ===
  SYS   total=7765 M  used=1823 M  free=5942 M  avail=5701 M
  CGROUP  Memory: 823.4M (max: 1.4G ...)
  PID=1234   RSS=180   MB  VSZ=512   MB  node
  PID=5678   RSS=620   MB  VSZ=1100  MB  gst-overlay
  PID=9012   RSS=85    MB  VSZ=320   MB  gst-launch
  PID=3456   RSS=310   MB  VSZ=890   MB  chromium
  NET   end1          gw=192.168.1.1
  NET   wlan0         gw=192.168.50.1
```

### Summary

| Layer | Catches | Action |
|---|---|---|
| `MemoryMax=2500M` | Memory leak before it gets dangerous | Restarts the service cleanly |
| `network-watchdog.timer` (every 10 min) | All interfaces unreachable for 20+ min | Clean system reboot |
| Hardware watchdog (`RuntimeWatchdogSec=60`) | Complete kernel freeze | Hardware-forced board reset |
| `monitor-camera.timer` (every 5 min) | Per-process memory trend | Logs to `/var/log/digitalpool-monitor.log` |

---

## 7. WiFi Access Point (Hotspot)

The app creates and manages a WiFi AP named **DigitalPool-Camera** using NetworkManager (`nmcli`). Because the service runs as the `ubuntu` user (not root), a **polkit rule** is required to grant it permission to add and activate NetworkManager connections. Without this the AP will silently fail with "Insufficient privileges".

### 7a. Grant NetworkManager permissions via polkit

```bash
sudo tee /etc/polkit-1/rules.d/50-digitalpool-networkmanager.rules > /dev/null << 'EOF'
polkit.addRule(function(action, subject) {
    if (action.id.indexOf("org.freedesktop.NetworkManager.") === 0 &&
        subject.user === "ubuntu") {
        return polkit.Result.YES;
    }
});
EOF

# Apply immediately — no reboot needed
sudo systemctl restart polkit
sudo systemctl restart digitalpool-camera
```

Confirm the AP came up by watching the log:

```bash
sudo journalctl -u digitalpool-camera -f
```

You should see:
```
📡 WiFi Manager: using interface wlx...
✅ AP profile created
✅ AP up — SSID: DigitalPool-Camera  IP: 192.168.50.1
```

### 7b. Hotspot settings

| Setting | Default value |
|---|---|
| SSID | `DigitalPool-Camera` |
| Password | `Digitalpool` |
| AP IP | `192.168.50.1` |
| Admin URL | `http://192.168.50.1:3000` |

After connecting your phone or tablet to the hotspot, open `http://192.168.50.1:3000` to access the full control interface.

> The AP runs concurrently alongside any regular WiFi client connection (AP+STA mode), so the Orange Pi 5 can be connected to your venue network and still serve the hotspot at the same time.

### 7b.1. Improve hotspot security and discoverability (one-time)

By default NetworkManager creates the hotspot with WPA1/TKIP which causes modern phones to show a **"Weak Security"** warning and can slow down network discovery. Run this once after the app first creates the `DigitalPool-Hotspot` connection to upgrade it to WPA2/CCMP (AES):

```bash
# Confirm the connection exists first
nmcli con show | grep Hotspot

# Upgrade to WPA2 / AES — eliminates "Weak Security" warning
sudo nmcli con modify "DigitalPool-Hotspot" \
  802-11-wireless-security.proto rsn \
  802-11-wireless-security.pairwise ccmp \
  802-11-wireless-security.group ccmp \
  802-11-wireless-security.pmf 1

# Restart the hotspot to apply
sudo nmcli con down "DigitalPool-Hotspot" && sudo nmcli con up "DigitalPool-Hotspot"
```

| Parameter | Value | Effect |
|---|---|---|
| `proto rsn` | WPA2 only | Drops WPA1 — eliminates "Weak Security" |
| `pairwise ccmp` | AES unicast | Drops TKIP |
| `group ccmp` | AES broadcast | Drops TKIP |
| `pmf 1` | Protected Management Frames optional | Expected by iOS 15+ and Android 12+ |

> **iOS Privacy Warning:** After rejoining, iOS may briefly show a "Privacy Warning" below the network name. This means the phone is using its real MAC address instead of a randomized one for this network. Fix it on the phone: **Settings → Wi-Fi → DigitalPool-A5D5 → enable Private Wi-Fi Address**. This is a phone-side setting and is not related to the AP configuration.

### 7c. Captive Portal (auto-open admin UI on connect)

When a device connects to the hotspot it has no internet, so iOS, Android, and Windows each fire HTTP and HTTPS "captive portal" probes to well-known URLs. The app uses a **two-phase approach** that both auto-opens the admin UI *and* keeps the phone stably connected:

| Phase | Trigger | Response | Effect |
|---|---|---|---|
| **1 — First probe** | New device, not yet authenticated | `302 → http://192.168.50.1:3000` | OS opens captive-portal mini-browser on admin UI |
| **2 — After auth** | Device has loaded the admin UI | `200 OK` with `<HTML>Success</HTML>` | OS marks network as "has internet"; phone stays connected |

The transition happens automatically: when the mini-browser follows the redirect and loads the admin UI, the server marks that device's IP as authenticated. All subsequent probes from that IP return `200 Success`, so iOS stops trying to switch to cellular or a saved WiFi network.

**HTTPS probes** (iOS 14+, port 443) always return `200 Success` regardless of auth state — these are internet-connectivity checks, not captive-portal triggers, and a redirect on HTTPS causes iOS to mark the network as broken.

Four pieces work together:

| Piece | What it does |
|---|---|
| **dnsmasq wildcard** | Resolves every hostname to `192.168.50.1` so probe requests reach us |
| **iptables port 80 → 3000** | Forwards HTTP traffic to Express |
| **iptables port 443 → 3443** | Forwards HTTPS traffic to the Express HTTPS server |
| **Self-signed TLS cert** | Allows the HTTPS server to respond to iOS 14+ internet-check probes |

The app sets up the iptables rules automatically at startup — both need `sudo` access. Grant it with a single sudoers file:

```bash
sudo tee /etc/sudoers.d/digitalpool-captive > /dev/null << 'EOF'
# Allow the digitalpool-camera service to set up captive portal rules
ubuntu ALL=(ALL) NOPASSWD: /usr/bin/mkdir -p /etc/NetworkManager/dnsmasq-shared.d
ubuntu ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/NetworkManager/dnsmasq-shared.d/captive-portal.conf
ubuntu ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload NetworkManager
ubuntu ALL=(ALL) NOPASSWD: /usr/sbin/iptables -t nat *
EOF

# Validate syntax before applying
sudo visudo -c -f /etc/sudoers.d/digitalpool-captive
```

Generate the self-signed TLS cert (one-time — persists across reboots):

```bash
sudo mkdir -p /etc/ssl/digitalpool
sudo openssl req -x509 -newkey rsa:2048 \
  -keyout /etc/ssl/digitalpool/key.pem \
  -out    /etc/ssl/digitalpool/cert.pem \
  -days 3650 -nodes -subj '/CN=captive.apple.com'
```

Then deploy and restart:

```bash
cd ~/digitalpool-camera && git pull
sudo systemctl restart digitalpool-camera
sudo journalctl -u digitalpool-camera -f
```

You should see these lines in the log:
```
🔒 HTTPS captive portal listening on port 3443 (iOS 14+ port-443 probes)
✅ Captive portal: port 80 → 3000 redirect active on wlx...
✅ Captive portal: port 443 → 3443 redirect active on wlx...
```

**Test it** — connect a phone to `DigitalPool-Camera` and wait 5–10 seconds. iOS shows "Sign in to DigitalPool-Camera" and tapping it opens the admin UI. The phone stays on the hotspot automatically after that.

> **iptables rules are not persistent across reboots.** The app re-applies them every time it starts, so the rules are always in place as long as the service is running. To inspect active rules: `sudo iptables -t nat -L PREROUTING -n -v`

---

## 7d. Ethernet IP Configuration

The **Network & WiFi Setup** panel in the admin UI includes an **"Configure Ethernet IP"** section that lets you switch the wired port between DHCP and a static IP without touching the command line.

### How it works

Ubuntu 24.04 manages wired ethernet via **netplan → systemd-networkd**, not NetworkManager. The ethernet interface (`end1`) appears as `unmanaged` in `nmcli`. The app therefore:

1. Writes a dedicated netplan override file at `/etc/netplan/99-digitalpool-ethernet.yaml`
2. Runs `sudo netplan apply` to activate the change immediately (no reboot needed)

### Required sudoers entries

Three `sudo` commands are needed. Add them to the existing sudoers file created in § 7c:

```bash
sudo tee -a /etc/sudoers.d/digitalpool-captive > /dev/null << 'EOF'
ubuntu ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/netplan/99-digitalpool-ethernet.yaml
ubuntu ALL=(ALL) NOPASSWD: /usr/sbin/netplan apply
ubuntu ALL=(ALL) NOPASSWD: /usr/bin/timedatectl set-timezone *
ubuntu ALL=(ALL) NOPASSWD: /usr/sbin/reboot
EOF

# Validate before applying
sudo visudo -c -f /etc/sudoers.d/digitalpool-captive
```

| Entry | Enables |
|---|---|
| `netplan` / `tee` | Ethernet IP configuration in Admin Settings |
| `timedatectl set-timezone` | Timezone selector in Admin Settings (🕐 Timezone) |
| `reboot` | **⚡ Power → Reboot Device** button in Admin Settings |

### Setting a static IP

1. Open the admin UI at `http://192.168.50.1:3000` (WiFi hotspot) or `http://<device-ip>:3000` (Ethernet).
2. Go to **Network & WiFi Setup → Configure Ethernet IP**.
3. Select **Static IP**, fill in the IP address, prefix length (e.g. `24` = 255.255.255.0), gateway, and optionally a DNS server.
4. Click **Save Ethernet Config**.

> ⚠️ If you are accessing the admin UI over Ethernet, switching to a different static IP will immediately disconnect your browser tab. Reconnect using the new IP or via the WiFi hotspot (`http://192.168.50.1:3000`).

### Reverting to DHCP

Select **DHCP (automatic)** and click **Save Ethernet Config**. The interface will re-request an address from your router within a few seconds.

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
| Framerate | `30` fps | Target encode framerate |
| Bitrate | `5 Mbps` | H.264/H.265 target bitrate |
| Audio device | `hw:3,0` | ALSA device for microphone |
| Audio enabled | `true` | Mux audio into stream |

**Input source settings** (persisted to `camera-source.json`):

| Setting | Values | Description |
|---|---|---|
| Source type | `usb` / `rtsp` / `ndi` | Active input source |
| USB device | `/dev/video0` | V4L2 device node (USB camera) |
| RTSP URL | `rtsp://…` | Network camera URL |
| NDI source name | e.g. `MY-MAC (Scan Converter)` | Exact NDI sender name as discovered |

**NDI audio note:** When NDI is selected as the input source and Audio is enabled, the pipeline uses the NDI sender's embedded audio directly — no ALSA device is opened. The audio device selector in the UI is ignored for NDI sources.

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
├── authManager.js             # Login / session / IP-ban management
├── puppeteerOverlay.js        # Headless Chromium → transparent PNG overlay
├── gst-overlay-pipeline.py    # Python GStreamer pipeline (overlay, NDI, RTSP)
├── ndi-discover.py            # NDI source discovery via libndi.so.6 (ctypes)
├── png-overlay-helper.sh      # Shell wrapper invoking the Python pipeline script
├── digitalpool-camera.service # Systemd unit file
├── network-watchdog.sh        # Network-health watchdog (reboots if offline 20 min)
├── network-watchdog.service   # Systemd unit for watchdog
├── network-watchdog.timer     # Systemd timer — runs every 10 minutes
├── monitor-camera.sh          # Memory flight recorder (logs RSS every 5 min)
├── monitor-camera.service     # Systemd unit for flight recorder
├── monitor-camera.timer       # Systemd timer — runs every 5 minutes
├── package.json
├── .env                       # Environment variables (create — see Step 4a)
├── stream-config.json         # Auto-generated stream settings (persisted by UI)
└── public/
    ├── index.html             # Web control interface
    ├── login.html             # Login page
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
| `GET` | `/api/ethernet/config` | Get ethernet IP mode (DHCP/static), IP, gateway, DNS |
| `POST` | `/api/ethernet/config` | Set ethernet to DHCP or static IP |

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

# Add the ubuntu user to the audio group (required for camera mic / ALSA access):
sudo usermod -aG audio ubuntu
sudo systemctl restart digitalpool-camera   # picks up the new group immediately
```

### Hardware encoder / decoder not found

```bash
gst-inspect-1.0 mpph264enc
gst-inspect-1.0 mpph265enc
gst-inspect-1.0 mpph264dec   # required for NDI HX / HX2
gst-inspect-1.0 mpph265dec   # required for NDI HX3
# If any are missing:
sudo apt install --reinstall gstreamer1.0-rockchip1
rm -f ~/.cache/gstreamer-1.0/registry.aarch64.bin
gst-inspect-1.0 mpph264enc   # verify after reinstall
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

**Version compatibility:** The system Chromium is version 114. You **must** use `puppeteer-core@20.9.0` — newer versions use a DevTools Protocol revision that Chromium 114 does not support, causing Chromium to crash silently during page navigation with a misleading "Timed out after waiting 30000ms" error.

```bash
# Correct install:
npm install puppeteer-core@20.9.0

# Verify:
npm list puppeteer-core
# Should print: puppeteer-core@20.9.0
```

### Audio / video drift after long streams

Ensure the Python script (`gst-overlay-pipeline.py`) is being used rather than the raw shell pipeline — it forces GStreamer's system clock to `CLOCK_REALTIME`, matching FFmpeg's `av_gettime` source and eliminating long-term drift between the video and audio PTS streams.

### OBS connects to RTSP but "no stream is available on path 'live'"

MediaMTX is running but nothing is pushing video to it. The most common cause is the `ubuntu` user lacking permission to open the camera mic (`hw:3,0`), which causes the ffmpeg audio process to crash before it ever reaches MediaMTX.

```bash
# Confirm the audio card is present (should list the camera mic)
cat /proc/asound/cards

# If arecord -l shows nothing for the ubuntu user, the group is missing:
sudo usermod -aG audio ubuntu
sudo systemctl restart digitalpool-camera

# Confirm the RTMP push is now active (should show a connection to port 1935)
sudo ss -tnp | grep 1935
```

### Permission denied on camera device

```bash
sudo usermod -aG video ubuntu
sudo usermod -aG audio ubuntu
# Verify:
groups ubuntu
```

### NDI — no sources found / library not loading

```bash
# Check the library is at the expected path:
ls -lh /usr/local/lib/libndi.so.6

# Check ldconfig knows about it:
ldconfig -p | grep libndi

# If missing, re-copy and refresh:
sudo cp /path/to/libndi.so.6 /usr/local/lib/
sudo ldconfig

# Run the discovery script directly (3 s timeout for quick test):
python3 /home/ubuntu/digitalpool-camera/ndi-discover.py 3000
# [] means no sources visible — confirm sender is on the same subnet
# {"error": "Cannot load NDI library"} means libndi.so.6 is missing/wrong path
```

### NDI — GStreamer elements not found (`ndisrc`, `ndisrcdemux`)

```bash
# Check if the plugin .so is in the GStreamer plugin path:
ls /usr/lib/aarch64-linux-gnu/gstreamer-1.0/libgstndi.so

# If missing, rebuild and reinstall the plugin (see section 2l, Step 2).
# After installing, force-refresh the GStreamer plugin registry:
rm -f ~/.cache/gstreamer-1.0/registry.aarch64.bin
gst-inspect-1.0 ndisrc   # must print element details, not "no such element"
```

### NDI — stream reaches PLAYING but no video in OBS / preview blank

These are the most common pipeline-level failures and what each means:

| Log message | Cause | Fix |
|---|---|---|
| `NOT_LINKED (-1)` | Audio pad pushed before a handler was installed | Already fixed in current code — check you have the latest `git pull` |
| `NOT_NEGOTIATED (-4)` | Caps mismatch on first buffer | Already fixed — framerate constraint removed from dynamic chain |
| `🎥 NDI video media type: video/x-h264` | NDI HX/HX2 source — hardware decode inserted | Normal — no action needed |
| `🎥 NDI video media type: video/x-h265` | NDI HX3 source — hardware decode inserted | Normal — no action needed |
| `❌ NDI video link FAILED` | Element creation failed (plugin missing?) | Verify `mpph264dec` / `mpph265dec` — see hardware encoder check above |

```bash
# Watch the NDI pipeline startup sequence live:
sudo journalctl -u digitalpool-camera -f | grep -E "NDI|video pad|audio pad|paused|playing"
```

Expected healthy startup sequence:
```
🔊 NDI audio: silent baseline + pad-added handler installed
🎥 NDI video: DROP probe race-guard installed
Pipeline state: paused → playing
🎥 NDI video pad detected — installing DROP probe
🎥 NDI video media type: video/x-raw        ← or x-h264 / x-h265
🎥 NDI video chain built and linked dynamically [standard (raw)]
🔊 NDI audio pad detected — dropping frames until chain linked
🔊 NDI audio mixed into audiomixer
```

### NDI HX3 — hardware decoder not found

```bash
gst-inspect-1.0 mpph264dec
gst-inspect-1.0 mpph265dec
# If either is missing:
sudo apt install --reinstall gstreamer1.0-rockchip1
# Then clear the plugin registry and retry:
rm -f ~/.cache/gstreamer-1.0/registry.aarch64.bin
gst-inspect-1.0 mpph264dec
```

The pipeline automatically falls back to software decoding (`avdec_h264` / `avdec_h265`) if hardware decoders are unavailable, but CPU usage will be higher.

### Follow live logs

```bash
sudo journalctl -u digitalpool-camera -f
sudo journalctl -u mediamtx -f
```

---

## 16. Upgrading an Existing Appliance

Use this section when deploying the latest code to an existing unit, or when setting up a brand-new appliance from a completed base install (Sections 1–6 already done).

### 16a. Quick code update (every deployment)

```bash
cd ~/digitalpool-camera
git pull
npm install          # picks up any new npm dependencies
sudo systemctl restart digitalpool-camera
```

Check that the service came back up:
```bash
sudo journalctl -u digitalpool-camera -f
```

### 16b. One-time setup steps for new features

Run each block below **once** on any appliance that hasn't had it set up yet.  They are safe to re-run on an existing unit — they are idempotent.

#### WebRTC preview — MediaMTX ICE host update script

Required for the live WebRTC admin preview to work over LAN, Tailscale, and the hotspot simultaneously.

```bash
sudo cp ~/digitalpool-camera/mediamtx-update-hosts.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/mediamtx-update-hosts.sh

sudo mkdir -p /etc/systemd/system/mediamtx.service.d
sudo tee /etc/systemd/system/mediamtx.service.d/update-hosts.conf << 'EOF'
[Service]
ExecStartPre=/usr/local/bin/mediamtx-update-hosts.sh
EOF

sudo systemctl daemon-reload
sudo systemctl restart mediamtx

# Verify — should list all local IPs
grep webrtcAdditionalHosts /etc/mediamtx.yml
```

#### Hotspot WiFi — WPA2/CCMP security upgrade

Eliminates the "Weak Security" warning on iOS and Android.  Run **after** the app has started and created the `DigitalPool-Hotspot` connection (confirm with `nmcli con show | grep Hotspot`).

```bash
sudo nmcli con modify "DigitalPool-Hotspot" \
  802-11-wireless-security.proto rsn \
  802-11-wireless-security.pairwise ccmp \
  802-11-wireless-security.group ccmp \
  802-11-wireless-security.pmf 1

sudo nmcli con down "DigitalPool-Hotspot" && sudo nmcli con up "DigitalPool-Hotspot"
```

#### Captive portal sudoers + TLS cert (auto-open admin UI on hotspot connect)

Required for the captive portal iptables rules and Ethernet/timezone/reboot controls to work. See Section 7c for the full explanation.

```bash
# Check if sudoers file already present — if it prints content, skip that step
sudo cat /etc/sudoers.d/digitalpool-captive 2>/dev/null

# If missing, create it (paste the full block from Section 7c)

# Check if TLS cert already present — if it prints content, skip that step
sudo ls /etc/ssl/digitalpool/cert.pem 2>/dev/null

# If missing, generate it (one-time — persists across reboots)
sudo mkdir -p /etc/ssl/digitalpool
sudo openssl req -x509 -newkey rsa:2048 \
  -keyout /etc/ssl/digitalpool/key.pem \
  -out    /etc/ssl/digitalpool/cert.pem \
  -days 3650 -nodes -subj '/CN=captive.apple.com'
```

#### Verify everything is healthy after update

```bash
# All three services must be active
sudo systemctl status mediamtx digitalpool-camera network-watchdog.timer

# Both captive portal iptables rules must be present
sudo iptables -t nat -L PREROUTING -n -v | grep -E "3000|3443"

# TLS cert for HTTPS captive portal must exist
sudo ls /etc/ssl/digitalpool/cert.pem

# MediaMTX ICE hosts injected
grep webrtcAdditionalHosts /etc/mediamtx.yml

# Hotspot is up
nmcli con show --active | grep -i hotspot
```

---

## License

ISC

## Author

Tim Traver — [github.com/timtraver](https://github.com/timtraver)
