# Digital Pool Camera Control

A Node.js web service for **Intel Lake N97 mini-PCs** (GMKtec G5, and similar N97/N100 boxes) and **Rockchip RK3588-family SBCs** (Orange Pi 5, Radxa Rock 5C) that turns a USB PTZ camera into a professional live-streaming camera for pool/billiards match production. It streams H.264 video with hardware acceleration, supports SRT, RTMP, and RTSP output, composites transparent PNG overlays (scoreboards, logos, timestamps) directly into the GStreamer pipeline, and hosts a WiFi access-point hotspot so the control interface is always reachable from a tablet or phone without any external network.

> **Primary target hardware:** Intel Lake N97 mini-PC running standard **Ubuntu Server 24.04**, with a UGREEN CM762 (AIC8800D80) USB WiFi 6 dongle for client WiFi connectivity alongside the onboard hotspot.

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
| 📲 **NDI input** | Receive NDI / NDI HX / HX2 / HX3 network video sources — auto-detects compressed vs raw, hardware-decodes via Rockchip MPP |

---

## Hardware Requirements

### Intel Lake N97 (primary target)
- **SoC**: Intel Alder Lake-N N97 — quad-core (4P+0E), 3.6 GHz boost, 6W TDP, Intel UHD Graphics (24 EU), integrated WiFi 5 (Intel AX101)
- **Mini-PC**: GMKtec G5 or any Intel N97/N100 mini-PC running Ubuntu Server 24.04
- **Camera**: USB PTZ camera with V4L2/UVC support (tested: OBSBOT Tiny 2 Lite)
- **USB WiFi 6 dongle**: UGREEN CM762 (AIC8800D80 chipset) — used for client WiFi; onboard Intel WiFi runs the hotspot
- **Storage**: internal NVMe or eMMC (no microSD)
- **Optional**: USB microphone or camera with built-in mic (ALSA device for audio)

### Rockchip RK3588 (also supported)
- **SBC**: Orange Pi 5 (RK3588) or Radxa Rock 5C (RK3588S2) running Joshua-Riek Ubuntu 24.04
- **USB WiFi adapter**: Any Linux-supported adapter capable of AP+STA concurrent mode (for hotspot)
- **Storage**: ≥32 GB microSD card or eMMC

---

## 1. Install the OS

### 1a-N97. Intel Lake N97 — Ubuntu Server 24.04 (standard amd64)

Download the official **Ubuntu Server 24.04 LTS** ISO for **x86_64 (amd64)** — the N97 is an Intel x86_64 chip, not ARM:

```
ubuntu-24.04.x-live-server-amd64.iso
```

Download from [ubuntu.com/download/server](https://ubuntu.com/download/server) or directly:

```bash
wget https://releases.ubuntu.com/24.04/ubuntu-24.04.2-live-server-amd64.iso
```

> Check [releases.ubuntu.com/24.04](https://releases.ubuntu.com/24.04/) for the latest point release (e.g. `24.04.2`).

Flash the ISO to a USB drive using [Balena Etcher](https://etcher.balena.io/) or:

```bash
sudo dd if=ubuntu-24.04.2-live-server-amd64.iso of=/dev/sdX bs=4M status=progress conv=fsync
```

Replace `/dev/sdX` with your USB drive device. Boot the N97 box from the USB drive (press F7 or Del at POST to choose boot device).

During the installer:
- Choose **Ubuntu Server (minimized)** — no desktop needed
- Set hostname to something like `digitalpoolg5`
- **Create user `dp`** with password `digitalpool42` (the service runs as this user)
- Enable **OpenSSH server** so you can manage the box remotely
- Let the installer format the internal NVMe/eMMC drive

After install, boot in and confirm you can SSH in:

```bash
ssh dp@<device-ip>
```

> **Why `dp`?** All service files, sudoers rules, and polkit policies in this repo use the `dp` user. Using a different username requires updating those files manually.

### 1a-RK. Rockchip RK3588 — Joshua-Riek Ubuntu 24.04

Go to the [Releases page](https://github.com/Joshua-Riek/ubuntu-rockchip/releases) and download the latest **Ubuntu 24.04** server image for your board:

```
ubuntu-24.04.x-preinstalled-server-arm64-orangepi-5.img.xz    # Orange Pi 5
ubuntu-24.04.x-preinstalled-server-arm64-rock-5c.img.xz        # Radxa Rock 5C
```

Flash with Balena Etcher or:

```bash
xzcat ubuntu-24.04.x-preinstalled-server-arm64-orangepi-5.img.xz | \
  sudo dd of=/dev/sdX bs=4M status=progress conv=fsync
```

### 1b. First boot (Rockchip only — skip for N97 where installer already ran)

Log in with the default credentials:

```
username: ubuntu
password: ubuntu
```

You will be prompted to change the password on first login. After changing it, create the `dp` user that the service runs as:

```bash
# Create the dp user with the correct password
sudo adduser --gecos "" dp
# When prompted for password, enter: digitalpool42

# Give dp sudo rights
sudo usermod -aG sudo dp

# Switch to dp for all remaining setup steps
sudo su - dp
```

### 1c. First boot (both platforms)

Set up SSH key authentication so you can log in without a password. On your **local machine** (Mac/Linux), copy your public key:

```bash
# On your LOCAL machine — get your public key
cat ~/.ssh/id_rsa.pub
# or if using ed25519:
cat ~/.ssh/id_ed25519.pub
```

Then on the **device**, create the authorized_keys file as the `dp` user:

```bash
# On the device, as dp
mkdir -p ~/.ssh
chmod 700 ~/.ssh
vi ~/.ssh/authorized_keys
# Paste your public key on a single line, save and quit (:wq)
chmod 600 ~/.ssh/authorized_keys
```

Verify SSH key login works before continuing — open a **new terminal** on your local machine and test:

```bash
ssh dp@<device-ip>
```

> If SSH key login works, you can optionally disable password authentication later via `/etc/ssh/sshd_config` (`PasswordAuthentication no`). For now, leave it enabled during setup.

### 1d. Update the system and install base network tools

```bash
sudo apt update && sudo apt full-upgrade -y

# Network diagnostic tools (ifconfig, ping, netstat, etc.), WiFi tools, and vi editor
sudo apt install -y net-tools iputils-ping iproute2 netcat-openbsd vim iw wireless-tools

sudo reboot
```

### 1d.1. Make sudo last the entire session

By default `sudo` times out after 15 minutes, requiring you to re-enter your password repeatedly during a long setup. Set the timeout to `-1` (never expires until logout) for the `dp` user:

```bash
echo 'Defaults:dp timestamp_timeout=-1' | sudo tee /etc/sudoers.d/dp-notimeout
sudo visudo -c -f /etc/sudoers.d/dp-notimeout   # validate syntax
```

> This only suppresses the re-prompt — you still enter your password once per login session. It does **not** grant passwordless sudo. To revert, `sudo rm /etc/sudoers.d/dp-notimeout`.

### 1e. Reduce microSD card wear — disable atime

Every file read on a standard Linux mount triggers an `atime` (access time) write back to the filesystem metadata. On a microSD card this is pure wasted write wear with no practical benefit. Switching the root and boot partitions to `noatime` eliminates these writes and significantly extends card lifespan.

**Edit `/etc/fstab`:**

```bash
sudo vi /etc/fstab
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
sudo vi /etc/needrestart/needrestart.conf
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
sudo journalctl --disk-usage
```

> **"not seeing messages from other users and the system"** — this means your user isn't in the `adm` or `systemd-journal` group yet. Fix it once:
> ```bash
> sudo usermod -aG adm dp
> # Log out and back in, then journalctl works without sudo
> ```

#### Verify logrotate is running

Ubuntu 24.04 Server (minimized install) does not include logrotate by default. Install it:

```bash
sudo apt install -y logrotate
ls /etc/cron.daily/logrotate    # should now show the file
sudo systemctl status cron      # cron must be active (running)
```

Ubuntu 24.04 Server runs logrotate via **cron** (`/etc/cron.daily/logrotate`), not a systemd timer. If cron is active and the file exists, logrotate is working — nothing further needed.

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

Ubuntu Server installs with **no swap by default**. The camera service, GStreamer pipeline, and ffmpeg together can peak at 2–3 GB under load. Without swap, the OOM killer will silently terminate processes and make the device appear unresponsive.

**GMKtec G5 N97 (16 GB RAM, NVMe storage) — use 4 GB swap:**

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make permanent across reboots
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Verify
free -h
```

**Rockchip SBCs (microSD, limited RAM) — use 2 GB swap:**

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
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

### 1j. Eliminate boot delays — ethernet-optional setup

By default Ubuntu waits up to **2 minutes** for ethernet to come online before starting most services. On an appliance that may run without a cable plugged in (field deployment, WiFi-only), this turns every boot into a 4-minute wait before the hotspot is even visible. Two one-time commands eliminate this entirely.

**Mask the network-online blocker:**

```bash
sudo systemctl mask systemd-networkd-wait-online.service
```

This service waits for `systemd-networkd` to report that a "required" interface (normally ethernet) is fully configured. Masking it causes `network-online.target` to complete immediately — ethernet still comes up normally via NetworkManager, it just no longer holds up the entire boot sequence.

> **Note:** `NetworkManager-wait-online.service` (a different service) should also be disabled. Check and disable it if it is enabled:
> ```bash
> systemctl is-enabled NetworkManager-wait-online.service
> # If it prints "enabled", disable it:
> sudo systemctl disable NetworkManager-wait-online.service
> ```

**Disable cloud-init:**

```bash
sudo touch /etc/cloud/cloud-init.disabled
```

Cloud-init is a provisioning tool designed to run on fresh cloud VM instances. On a pre-configured appliance it runs every boot for no benefit, and it depends on `network-online.target` — meaning it previously compounded the 2-minute ethernet wait. Touching this file tells cloud-init to exit immediately without doing anything, removing it from the boot critical chain entirely.

**Verify the improvement:**

After a reboot, check the boot time and critical chain:

```bash
systemd-analyze
# Expected: total boot ≈ 19–20 s (was 2+ minutes)

systemd-analyze critical-chain digitalpool-hotspot.service
# NetworkManager should start at ~3–4 s, hotspot should complete at ~15 s
```

> **What is NOT affected:** Ethernet connectivity, NetBird, NetworkManager, the WiFi hotspot — all continue to work exactly as before. These commands only remove unnecessary *waiting*, not any actual functionality.

---

## 2. Install System Dependencies

All commands run as the `dp` user (use `sudo` where required). Make sure you are logged in as `dp` before running any of these steps.

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

### 2a.2. Add `dp` to the `video`, `audio`, and `render` groups

The service runs as the `dp` user and needs direct access to the camera device (`/dev/video*`), the ALSA audio devices (`/dev/snd/*`), and the Intel GPU render node (`/dev/dri/renderD128`) for VA-API hardware encoding.

```bash
sudo usermod -aG video,audio,render dp

# Verify all groups appear:
groups dp
```

> **This takes effect for new login sessions.** Log out and back in (or `newgrp video`) to activate in the current shell.

### 2a.3. UGREEN CM762 (AIC8800D80) USB WiFi 6 driver — Intel N97 only

The UGREEN CM762 USB WiFi 6 dongle uses the **AIC8800D80** chipset, which requires an out-of-tree driver. Install it now so the module loads automatically on every boot.

```bash
# Build prerequisites
sudo apt install -y build-essential git linux-headers-$(uname -r)

# Clone the driver source (tested on Ubuntu with kernel 6.x / 7.x)
git clone https://github.com/BLUEMOON233/AIC8800-Linux-Driver.git
cd AIC8800-Linux-Driver/drivers/aic8800

# Patch for kernel 6.4+ (in_irq() was removed — replaced by in_hardirq())
sed -i 's/in_irq()/in_hardirq()/g' aic8800_fdrv/rwnx_rx.c

# Build and install
sudo make
sudo make install

# Load the modules immediately (plug in the dongle first if not already)
sudo modprobe aic_load_fw
sudo modprobe aic8800_fdrv

# Make the modules load automatically on every boot
echo "aic_load_fw" | sudo tee -a /etc/modules
echo "aic8800_fdrv" | sudo tee -a /etc/modules

# Verify — should show wlx... interface in managed mode alongside the AP interface
iw dev
```

Expected output after loading:
```
phy#1
    Interface wlx6c1ff78a8a52
        type managed          ← USB dongle (client WiFi)
phy#0
    Interface wlp1s0
        type AP               ← onboard chip (hotspot)
```

> If `lsusb` shows the dongle as `a69c:5723 aicsemi Aic MSC` (mass storage mode), install `usb-modeswitch` first:
> ```bash
> sudo apt install -y usb-modeswitch usb-modeswitch-data
> ```
> Unplug and replug the dongle — it should switch to `a69c:8d80 aicsemi AIC Wlan` mode, then the driver can attach.

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

### 2c. Hardware encoder / decoder

This step differs depending on your hardware. Install **only the section that matches your machine.**

---

#### 2c-i. Rockchip RK3588 (Orange Pi 5, Radxa Rock 5C, and similar)

The MPP (Media Process Platform) plugin (`gstreamer1.0-rockchip1`) provides:
- **Encoders:** `mpph264enc`, `mpph265enc`, `mppjpegenc`, `mppvp8enc`
- **Decoders:** `mppvideodec` (one generic element handles H.264, H.265, JPEG, VP8, VP9), `mppjpegdec`

> **Note:** There are no separate `mpph264dec` or `mpph265dec` elements. The single `mppvideodec` element handles all supported codec formats. `librockchip-mpp1` is typically pre-installed by the Joshua-Riek image but is listed here for completeness.

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

> **Verify the encoders and decoder are available:**
> ```bash
> gst-inspect-1.0 mpph264enc    # H.264 hardware encoder
> gst-inspect-1.0 mpph265enc    # H.265 hardware encoder
> gst-inspect-1.0 mppvideodec   # generic hardware decoder (H.264/H.265/VP8/JPEG)
> gst-inspect-1.0 mppjpegdec    # JPEG hardware decoder
> ```
>
> All four elements must be present. If any are missing, reinstall and clear the plugin registry:
> ```bash
> sudo apt install --reinstall gstreamer1.0-rockchip1
> rm -f ~/.cache/gstreamer-1.0/registry.aarch64.bin
> ```

---

#### 2c-ii. Intel x86 (GMKtec G5 N97, and other Intel iGPU machines)

Ubuntu 24.04 ships GStreamer 1.24, which replaced the old `vaapi` plugin with a new `va` plugin. Element names changed:

| Old (GStreamer ≤1.22) | New (GStreamer 1.24 / Ubuntu 24.04) |
|---|---|
| `vaapih264enc` | `vah264enc` |
| `vaapih265enc` | `vah265enc` |
| `vaapidecodebin` | `vah264dec`, `vah265dec` |

Install the driver and plugin:

```bash
sudo apt install -y \
  gstreamer1.0-vaapi \
  intel-media-va-driver-non-free \
  vainfo
```

> **Note:** `intel-media-va-driver-non-free` is the iHD driver required for Alder Lake-N (N97) and all Gen 9+ Intel GPUs. If it is not found in your apt sources, try `intel-media-va-driver` (the open-source variant) instead.

Verify the VA-API driver and GStreamer plugin are working:

```bash
# Confirm VA-API sees the GPU (use --display drm on headless/no-X11 servers)
sudo vainfo --display drm --device /dev/dri/renderD128

# Confirm GStreamer can use the hardware encoders (Ubuntu 24.04 element names)
gst-inspect-1.0 vah264enc    # H.264 hardware encoder
gst-inspect-1.0 vah265enc    # H.265 hardware encoder

# List all VA elements GStreamer found (useful for troubleshooting)
gst-inspect-1.0 | grep -i va
```

> **If `vainfo` shows no supported profiles** the driver is not loaded. Check that your user is in the `video` and `render` groups:
> ```bash
> sudo usermod -aG video,render dp
> # Log out and back in, then retry vainfo
> ```
>
> **If `vah264enc` is missing** after installing the package, clear the GStreamer plugin cache and try again:
> ```bash
> rm -f ~/.cache/gstreamer-1.0/registry.x86_64.bin
> gst-inspect-1.0 vah264enc
> ```

The service auto-detects which encoder is available at startup — no manual configuration is needed after installation.

---

### 2d. GDK Pixbuf overlay (PNG compositing into the stream)

> **Note:** The dev package was renamed in Ubuntu 22.04. Use whichever command matches your Ubuntu version.

**Ubuntu 20.04 (Focal):**
```bash
sudo apt install -y \
  gstreamer1.0-gtk3 \
  libgdk-pixbuf2.0-dev
```

**Ubuntu 22.04+ (Jammy and newer — including Intel x86 installs):**
```bash
sudo apt install -y \
  gstreamer1.0-gtk3 \
  libgdk-pixbuf-xlib-2.0-dev
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

**Ubuntu 20.04 (Focal):**
```bash
sudo apt install -y imagemagick wkhtmltopdf
```

**Ubuntu 22.04+ (Jammy and newer — including Intel x86 installs):**

`wkhtmltopdf` was removed from Ubuntu 22.04's official repositories. Install ImageMagick via apt and download the `wkhtmltopdf` `.deb` directly from the project's GitHub releases:

```bash
sudo apt install -y imagemagick

# Download the pre-built .deb for Ubuntu 22.04 x86_64
wget https://github.com/wkhtmltopdf/packaging/releases/download/0.12.6.1-3/wkhtmltox_0.12.6.1-3.jammy_amd64.deb

# Install it (pulls in any missing dependencies automatically)
sudo apt install -y ./wkhtmltox_0.12.6.1-3.jammy_amd64.deb

# Clean up the downloaded file
rm wkhtmltox_0.12.6.1-3.jammy_amd64.deb
```

> **Verify:**
> ```bash
> wkhtmltoimage --version
> ```
> You should see `wkhtmltoimage 0.12.6.1 (with patched qt)`. The "with patched qt" part is important — the unpatched build from some mirrors does not support headless rendering correctly.

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
# Download the latest release — choose the correct architecture:
MEDIAMTX_VER="v1.18.0"

# Intel x86_64 (N97, N100, and other x86 mini-PCs):
wget https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VER}/mediamtx_${MEDIAMTX_VER}_linux_amd64.tar.gz
tar -xzf mediamtx_${MEDIAMTX_VER}_linux_amd64.tar.gz

# Rockchip ARM64 (Orange Pi 5, Radxa Rock 5C):
# wget https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VER}/mediamtx_${MEDIAMTX_VER}_linux_arm64.tar.gz
# tar -xzf mediamtx_${MEDIAMTX_VER}_linux_arm64.tar.gz

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

### 2l. NDI (Network Device Interface) Support

NDI lets the device receive a network video feed from any NDI sender on the same LAN — OBS, NewTek TriCaster, Mac Scan Converter, vMix, etc. — and re-stream it through the normal hardware-encode pipeline. Both standard NDI (uncompressed `video/x-raw`) and the compressed variants **NDI HX / HX2** (H.264) and **NDI HX3** (H.265) are supported; the pipeline auto-detects the format at runtime.

Two components are required: the **NDI SDK runtime library** (`libndi.so.6`) and the **GStreamer NDI plugin** (Teltek `gst-plugin-ndi`, providing `ndisrc` and `ndisrcdemux`).

#### Step 1 — Install the NDI SDK runtime library

Download the NDI SDK for Linux from the official NDI developer site:

> **Download:** https://ndi.video/for-developers/ndi-sdk/download/
> Choose **Linux** → download the `.tar.gz` or self-extracting `.sh` installer.

Extract the archive, then copy the shared library for **your architecture** to the correct system library directory. The SDK ships libraries for several architectures inside the `lib/` folder — use only the one that matches your machine.

**ARM64 — Rockchip RK3588 (Orange Pi 5, Radxa Rock 5C, and similar):**
```bash
sudo cp "./NDI SDK for Linux/lib/aarch64-linux-gnu/libndi.so.6" /usr/local/lib/
sudo chmod 755 /usr/local/lib/libndi.so.6

# Create the unversioned symlink the linker needs at build time (-lndi):
sudo ln -sf /usr/local/lib/libndi.so.6 /usr/local/lib/libndi.so
sudo ldconfig
```

**Intel x86_64 — GMKtec G5 N97, and other x86_64 machines:**

> **Important:** Install to `/usr/lib/x86_64-linux-gnu/` — **not** `/usr/local/lib/`. The Rust
> toolchain on x86_64 uses `rust-lld` (LLVM's linker), which does not reliably search
> `/usr/local/lib` even when `LIBRARY_PATH` is set. Installing to the arch-specific system path
> ensures the linker finds the library without any special flags.

```bash
sudo cp "./NDI SDK for Linux/lib/x86_64-linux-gnu/libndi.so.6" /usr/lib/x86_64-linux-gnu/
sudo chmod 755 /usr/lib/x86_64-linux-gnu/libndi.so.6

# Create the unversioned symlink the linker needs at build time (-lndi):
sudo ln -sf /usr/lib/x86_64-linux-gnu/libndi.so.6 /usr/lib/x86_64-linux-gnu/libndi.so
sudo ldconfig
```

Verify — you should see two lines, one for `.so.6` and one for `.so`:

```bash
ldconfig -p | grep libndi
# ARM64 example output:
#   libndi.so.6 (libc6,AArch64) => /usr/local/lib/libndi.so.6
#   libndi.so   (libc6,AArch64) => /usr/local/lib/libndi.so
# Intel x86_64 example output:
#   libndi.so.6 (libc6,x86-64)  => /usr/lib/x86_64-linux-gnu/libndi.so.6
#   libndi.so   (libc6,x86-64)  => /usr/lib/x86_64-linux-gnu/libndi.so
```

> **Why two files?** `libndi.so.6` is the runtime library (loaded at runtime by `ldconfig`). `libndi.so` is the unversioned symlink the linker needs at *build* time (`-lndi`). Without it the `cargo build` step will fail with `cannot find -lndi`.

> **Version note:** The app and `ndi-discover.py` hard-code the runtime path `/usr/local/lib/libndi.so.6` (ARM64) or `/usr/lib/x86_64-linux-gnu/libndi.so.6` (Intel). If you install a different major version (e.g. `.so.5` or `.so.7`), create a symlink to normalise it:
> ```bash
> # ARM64:
> sudo ln -sf /usr/local/lib/libndi.so.X /usr/local/lib/libndi.so.6
> # Intel x86_64:
> sudo ln -sf /usr/lib/x86_64-linux-gnu/libndi.so.X /usr/lib/x86_64-linux-gnu/libndi.so.6
> sudo ldconfig
> ```

#### Step 2 — Install the GStreamer NDI plugin (Teltek gst-plugin-ndi)

The GStreamer NDI plugin is written in Rust and provides the `ndisrc` and `ndisrcdemux` elements used by this app. Build it from source on the device:

```bash
# Install Rust toolchain (if not already present):
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

Install the GStreamer development headers. **The dependencies differ by architecture:**

**ARM64 — Rockchip RK3588:**
```bash
# librga-dev is available from the jjriek/rockchip-multimedia PPA added in step 2c.
# Without it, the Rockchip-patched gstreamer-video-1.0.pc pulls in librga as a
# dependency and cargo will fail with "Package 'librga' not found".
sudo apt install -y \
  libgstreamer1.0-dev \
  libgstreamer-plugins-base1.0-dev \
  libgstreamer-plugins-bad1.0-dev \
  librga2 \
  librga-dev
```

**Intel x86_64:**
```bash
# librga is Rockchip-only — do not install it on Intel.
sudo apt install -y \
  libgstreamer1.0-dev \
  libgstreamer-plugins-base1.0-dev \
  libgstreamer-plugins-bad1.0-dev
```

Now clone and build the plugin (same steps for both architectures):

```bash
git clone https://github.com/teltek/gst-plugin-ndi.git
cd gst-plugin-ndi
cargo build --release
```

> **If you get `unable to find library -lndi`**, confirm the unversioned symlink was created correctly in Step 1:
> ```bash
> # ARM64:
> ls -la /usr/local/lib/libndi*
> # Intel x86_64:
> ls -la /usr/lib/x86_64-linux-gnu/libndi*
> # Both should show libndi.so.6 (real file) AND libndi.so (symlink).
> # Re-run the ldconfig line from Step 1 if either is missing.
> ```

Install the compiled plugin into the system GStreamer plugin directory — **the path differs by architecture:**

**ARM64 — Rockchip RK3588:**
```bash
sudo cp target/release/libgstndi.so \
     /usr/lib/aarch64-linux-gnu/gstreamer-1.0/
```

**Intel x86_64:**
```bash
sudo cp target/release/libgstndi.so \
     /usr/lib/x86_64-linux-gnu/gstreamer-1.0/
```

Then verify the plugin loaded:

```bash
# Refresh the GStreamer plugin registry:
gst-inspect-1.0 ndisrc       # must succeed — prints element details
gst-inspect-1.0 ndisrcdemux
```

> **Tip:** If you do not want to build from source, the plugin repository also publishes pre-built binaries in its Releases section for some architectures. Check https://github.com/teltek/gst-plugin-ndi/releases.

#### Step 3 — Verify GStreamer NDI elements

```bash
# GStreamer elements present:
gst-inspect-1.0 ndisrc
gst-inspect-1.0 ndisrcdemux

# For NDI HX/HX3 on Rockchip — the generic MPP hardware decoder must be present:
gst-inspect-1.0 mppvideodec  # handles H.264, H.265, VP8, JPEG (Rockchip only)
# If missing: sudo apt install --reinstall gstreamer1.0-rockchip1

# For NDI HX/HX3 on Intel — avdec_h264 / avdec_h265 (software) are used automatically;
# vaapidecodebin can also be used if gstreamer1.0-vaapi is installed (step 2c-ii).
```

> **Note:** The NDI library discovery test (`ndi-discover.py`) requires the `digitalpool-camera` repo to be cloned first. That check is in **Section 4c** below.

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

> **Same-subnet rule:** NDI discovery relies on mDNS multicast (`224.0.0.251`). The device and the NDI sender **must be on the same Layer-2 network segment** — NDI does not cross routers unless a dedicated NDI routing/bridging solution is in use.

#### Using NDI as the video source

1. In the camera control UI go to **Input Source → NDI**.
2. Click **Scan for NDI Sources** — the app runs `ndi-discover.py` and lists all visible senders.
3. Select a source and click **Apply**. The idle preview will switch within ~12 seconds.
4. Start the stream normally — the pipeline auto-detects standard vs HX/HX2/HX3 and inserts a hardware decoder if needed.

---

### 2m. NetBird (Remote Access)

NetBird is required for the **Remote Access** toggle in Admin Settings. The app calls `sudo netbird up` / `sudo netbird down` on behalf of the `dp` user, so both the binary and the sudo permissions must be in place before enabling it.

NetBird creates a WireGuard-based mesh VPN that connects the camera device to your management network regardless of its location — no port forwarding or public IP required.

#### Install NetBird

```bash
curl -fsSL https://pkgs.netbird.io/install.sh | sh
```

This installs the `netbird` binary and enables the `netbird` daemon as a systemd service. Verify:

```bash
netbird version
sudo systemctl status netbird   # must show "active (running)"
```

> **Do not run `netbird up` manually.** The Admin Settings UI handles authentication and registration. Running it manually first can leave stale state that confuses the force re-register flow.

#### Grant sudo permissions

The app runs several netbird commands with `sudo` as the `dp` user. Add them to the existing sudoers file (created in Section 7c — if you haven't done Section 7 yet, come back and append these lines then):

```bash
sudo tee -a /etc/sudoers.d/digitalpool-captive > /dev/null << 'EOF'
# NetBird — remote access control via the Admin Settings UI
dp ALL=(ALL) NOPASSWD: /usr/bin/netbird up *
dp ALL=(ALL) NOPASSWD: /usr/bin/netbird down
dp ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop netbird
dp ALL=(ALL) NOPASSWD: /usr/bin/systemctl start netbird
dp ALL=(ALL) NOPASSWD: /usr/bin/rm -rf /var/lib/netbird/
EOF

sudo visudo -c -f /etc/sudoers.d/digitalpool-captive
```

> **If the sudoers file does not exist yet** (Section 7c not done), create it now with just the netbird entries and append the rest later:
> ```bash
> sudo tee /etc/sudoers.d/digitalpool-captive > /dev/null << 'EOF'
> dp ALL=(ALL) NOPASSWD: /usr/bin/netbird up *
> dp ALL=(ALL) NOPASSWD: /usr/bin/netbird down
> dp ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop netbird
> dp ALL=(ALL) NOPASSWD: /usr/bin/systemctl start netbird
> dp ALL=(ALL) NOPASSWD: /usr/bin/rm -rf /var/lib/netbird/
> EOF
> sudo visudo -c -f /etc/sudoers.d/digitalpool-captive
> ```

#### Configure NetBird credentials in `.env`

Add the NetBird variables to `/home/dp/digitalpool-camera/.env`:

```bash
# NetBird management server URL (omit for NetBird cloud; set for self-hosted)
NETBIRD_MANAGEMENT_URL=https://api.netbird.io

# Setup key — generate in the NetBird Dashboard under Setup Keys:
#   https://app.netbird.io/setup-keys  (cloud)
#   https://your-netbird-server/setup-keys  (self-hosted)
NETBIRD_SETUP_KEY=your-setup-key-here
```

After editing `.env`, restart the service to pick up the new values:

```bash
sudo systemctl restart digitalpool-camera
```

Remote access can then be toggled on/off from **Admin Settings → Remote Access** in the web UI.

---

## 3. Install Node.js via nvm

The systemd service file runs Node.js installed through **nvm** (Node Version Manager) as the `dp` user.

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
cd /home/dp
git clone https://github.com/timtraver/digitalpool-camera.git
cd digitalpool-camera

# Install npm dependencies
npm install
```

> `puppeteer-core@20.9.0` is listed in `package.json` and is installed automatically by `npm install`. It **must** stay pinned at `20.9.0` — newer versions use a DevTools Protocol revision that the system Chromium 114 does not support, causing Chromium to crash silently during page navigation.

### 4a. Create the environment file

The three core environment variables (`NODE_ENV`, `PORT`, `CAMERA_DEVICE`) are already hard-coded as `Environment=` lines inside `digitalpool-camera.service`, so the `.env` file is optional for a default setup. Create it if you want to **override** any of those values without editing the service file, or to add additional variables used by the app at startup:

```bash
cat > /home/dp/digitalpool-camera/.env << 'EOF'
NODE_ENV=production
PORT=3000
CAMERA_DEVICE=/dev/video0
EOF
```

Adjust `CAMERA_DEVICE` if your camera appears on a different node (check with `v4l2-ctl --list-devices`).

> **Note:** Values set in `.env` take effect when `server.js` reads them at startup via `dotenv`. The `Environment=` lines in the service file are the authoritative defaults; `.env` overrides them for the Node.js process only (child processes like GStreamer are not affected by `.env`).

### 4b. MediaMTX — WebRTC ICE host update script

The admin preview uses WebRTC (WHEP protocol). For WebRTC to work from every network interface — LAN, NetBird, and the WiFi hotspot — MediaMTX must include each interface's IP address in its SDP ICE candidates. The `mediamtx-update-hosts.sh` script (included in the repo) detects all current non-loopback IPv4 addresses at startup and injects them into `webrtcAdditionalHosts` in `/etc/mediamtx.yml`.

```bash
# Install the script
sudo cp /home/dp/digitalpool-camera/mediamtx-update-hosts.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/mediamtx-update-hosts.sh

# Hook it into the mediamtx systemd service as a pre-start step
sudo mkdir -p /etc/systemd/system/mediamtx.service.d
sudo tee /etc/systemd/system/mediamtx.service.d/update-hosts.conf << 'EOF'
[Service]
ExecStartPre=/usr/local/bin/mediamtx-update-hosts.sh
EOF

sudo systemctl daemon-reload
sudo systemctl restart mediamtx

# Verify — should list all local IPs including NetBird and hotspot
grep webrtcAdditionalHosts /etc/mediamtx.yml
```

The script runs every time MediaMTX starts, so it picks up new NetBird IPs automatically.

**However**, MediaMTX starts at boot with `After=network.target` — before the WiFi hotspot interface exists. If the hotspot comes up several seconds later (which is normal), `192.168.50.1` won't be in the ICE candidates list until MediaMTX is restarted. A **NetworkManager dispatcher script** fixes this by re-running the update every time any interface comes up:

```bash
sudo tee /etc/NetworkManager/dispatcher.d/99-mediamtx-update-hosts > /dev/null << 'EOF'
#!/bin/bash
# Re-run the MediaMTX ICE host update whenever any interface comes up,
# so the hotspot IP is always included even if the hotspot started after MediaMTX.
INTERFACE="$1"
ACTION="$2"
if [ "$ACTION" = "up" ]; then
    sleep 2   # let the interface fully configure its IP
    /usr/local/bin/mediamtx-update-hosts.sh
fi
EOF

sudo chmod +x /etc/NetworkManager/dispatcher.d/99-mediamtx-update-hosts
```

After this, every time the hotspot (or any other interface) comes up — including after a reboot — the dispatcher fires within ~2 seconds and MediaMTX automatically picks up the new IP. No manual `systemctl restart mediamtx` is ever needed.

**NetBird caveat:** NetBird creates a `wt0` WireGuard interface directly in the kernel — it is **not** managed by NetworkManager, so the dispatcher above will not fire when NetBird connects. A **periodic systemd timer** closes this gap by re-running the update script every 60 seconds regardless of how any interface came up:

```bash
# Install the timer units (files are included in the repo)
sudo cp /home/dp/digitalpool-camera/mediamtx-update-hosts.service \
        /home/dp/digitalpool-camera/mediamtx-update-hosts.timer \
        /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable --now mediamtx-update-hosts.timer

# Verify the timer is scheduled
systemctl list-timers mediamtx-update-hosts.timer
```

MediaMTX **hot-reloads** its config file whenever it changes, so the updated `webrtcAdditionalHosts` list takes effect immediately — no MediaMTX restart needed. With this timer in place, any interface (NetBird, hotspot, a new ethernet link) will be reflected in the ICE candidate list within 60 seconds of coming up, automatically and permanently.

**Why you can't preset a CIDR range (e.g. all `100.x.x.x`):** `webrtcAdditionalHosts` takes a list of specific IP addresses — not subnets. ICE candidates must be actual reachable addresses the device currently holds. The periodic timer achieves the same result: any IP the device acquires (NetBird, hotspot, LAN) is picked up automatically within one timer cycle.

### 4b.3. MediaMTX network override — allow start without ethernet

By default MediaMTX's systemd service depends on `network-online.target`, which requires a "connected" interface to be available before MediaMTX can start. Without an ethernet cable this target never fires, so MediaMTX never starts — and the WebRTC admin preview therefore fails even over the WiFi hotspot.

The repo ships a systemd drop-in (`mediamtx-network-override.conf`) that removes this ethernet dependency and instead sequences MediaMTX after the WiFi hotspot service. This ensures:

1. MediaMTX always starts (even ethernet-free field deployments).
2. `mediamtx-update-hosts.sh` runs after `192.168.50.1` is already assigned, so the hotspot IP appears in WebRTC ICE candidates from the first boot.

```bash
sudo mkdir -p /etc/systemd/system/mediamtx.service.d
sudo cp /home/dp/digitalpool-camera/mediamtx-network-override.conf \
        /etc/systemd/system/mediamtx.service.d/network-override.conf

sudo systemctl daemon-reload
sudo systemctl restart mediamtx
```

Verify MediaMTX starts correctly without ethernet:

```bash
sudo systemctl status mediamtx   # must show "active (running)"
# Confirm the hotspot IP is in the ICE list:
grep webrtcAdditionalHosts /etc/mediamtx.yml
# Should include 192.168.50.1 if the hotspot was already up
```

### 4c. Verify NDI library (if NDI is used)

Now that the repo is cloned, confirm the NDI runtime library loads correctly:

```bash
# Run the discovery script (3 s timeout):
python3 /home/dp/digitalpool-camera/ndi-discover.py 3000
# Expected output:
#   []                          — library loaded fine; no NDI sources on the network yet
#   [{"name": "...", ...}]      — library loaded and NDI senders are visible
#
# If you see {"error": "Cannot load NDI library"} check that libndi.so.6 is in
# /usr/local/lib and that sudo ldconfig was run (see section 2l, Step 1).
```

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
sudo cp /home/dp/digitalpool-camera/digitalpool-camera.service \
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

> The service is declared `Wants=mediamtx.service` — it will start MediaMTX as a soft dependency. If MediaMTX fails to start the camera service still comes up (allowing the admin UI to be reached over the hotspot). Install the MediaMTX network override (Section 4b.3) to ensure MediaMTX itself starts reliably without ethernet.

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
sudo cp /home/dp/digitalpool-camera/network-watchdog.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/network-watchdog.sh

# Install the systemd units
sudo cp /home/dp/digitalpool-camera/network-watchdog.service \
        /home/dp/digitalpool-camera/network-watchdog.timer \
        /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable --now network-watchdog.timer

# Confirm the timer is scheduled
systemctl list-timers network-watchdog.timer
```

### Layer 3 — Hardware watchdog (last resort if the kernel itself freezes)

The RK3588/RK3588S2 SoC has a hardware watchdog at `/dev/watchdog0`. If systemd stops petting it (because the kernel has completely locked up), the hardware forces a board reset after 60 seconds — even a kernel panic can't prevent this.

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
sudo cp /home/dp/digitalpool-camera/monitor-camera.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/monitor-camera.sh
sudo cp /home/dp/digitalpool-camera/monitor-camera.service \
        /home/dp/digitalpool-camera/monitor-camera.timer \
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

The app creates and manages a WiFi AP named **DigitalPool-Camera** using NetworkManager (`nmcli`). Because the service runs as the `dp` user (not root), a **polkit rule** is required to grant it permission to add and activate NetworkManager connections. Without this the AP will silently fail with "Insufficient privileges".

### 7a. Grant NetworkManager permissions via polkit

```bash
sudo tee /etc/polkit-1/rules.d/50-digitalpool-networkmanager.rules > /dev/null << 'EOF'
polkit.addRule(function(action, subject) {
    if (action.id.indexOf("org.freedesktop.NetworkManager.") === 0 &&
        subject.user === "dp") {
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

> The AP runs concurrently alongside any regular WiFi client connection (AP+STA mode), so the device can be connected to your venue network and still serve the hotspot at the same time.

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

### 7b.2. USB WiFi adapter driver — disable power-saving modes (rtw_8822bu)

> **Rock 5C users:** The Rock 5C's built-in WiFi uses the **AIC8800D80** chip (driver: `aic8800_fdrv`), not the Realtek RTL8822BU. This section does **not** apply to the built-in chip — skip it if you are using the Rock 5C's onboard WiFi for the hotspot. The AIC8800D80 is managed by NetworkManager and does not suffer the same driver-level IPS/LPS firmware crash described below.

If the USB WiFi adapter uses the **Realtek RTL8822BU** chipset (driver module `rtw_8822bu`), the driver's built-in **Idle Power Save (IPS)** and **Leisure Power Save (LPS)** modes will cause periodic firmware crashes that silently take the hotspot offline. Symptoms in `dmesg`:

```
rtw_8822bu: error beacon valid
rtw_8822bu: failed to download firmware
rtw_8822bu: failed to leave ips state
rtw_8822bu: failed to leave idle state
```

Disable both power-saving modes permanently with a modprobe option file:

```bash
echo "options rtw_8822bu ips=0 lps=0" | sudo tee /etc/modprobe.d/rtw_8822bu.conf
```

For the change to take effect the driver must be reloaded. The easiest method is to **physically unplug the USB adapter, wait 5 seconds, and plug it back in** (or reboot). From that point forward the option is applied automatically on every boot and every plug-in.

**Verify — no firmware errors after replug:**

```bash
dmesg | grep rtw | tail -10
# Healthy: interface comes up with NO "failed to leave ips state" lines
```

> **Identify your adapter's chipset:** `lsusb` shows the Realtek USB ID; `dmesg | grep -i rtw` names the exact driver module. The fix above targets `rtw_8822bu`. For other Realtek variants (`rtw88`, `rtw89`, `rtl8xxxu`, etc.) substitute the correct module name in `/etc/modprobe.d/`.

### 7b.3. Blacklist the competing out-of-tree driver (rtl88x2bu)

Some Ubuntu images ship **two** kernel drivers for the RTL8822BU chipset: the in-kernel `rtw_8822bu` (recommended) and an older out-of-tree `rtl88x2bu`. When both load simultaneously they fight over the adapter, causing the hotspot to fail silently or the interface to rename unpredictably.

Check if both are loading:

```bash
dmesg | grep -E "rtw_8822bu|rtl88x2bu"
# If you see BOTH driver names, the conflict is present
lsmod | grep -E "rtw_8822bu|rtl88x2bu"
```

If both appear, blacklist the out-of-tree driver:

```bash
echo "blacklist rtl88x2bu" | sudo tee /etc/modprobe.d/blacklist-rtl88x2bu.conf
sudo update-initramfs -u   # bake the blacklist into the initrd
```

Reboot (or unplug/replug the adapter) and confirm only the in-kernel driver loads:

```bash
dmesg | grep -E "rtw_8822bu|rtl88x2bu"
# Should show only rtw_8822bu
lsmod | grep rtl88x2bu
# Should return nothing
```

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
dp ALL=(ALL) NOPASSWD: /usr/bin/mkdir -p /etc/NetworkManager/dnsmasq-shared.d
dp ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/NetworkManager/dnsmasq-shared.d/captive-portal.conf
dp ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload NetworkManager
dp ALL=(ALL) NOPASSWD: /usr/sbin/iptables -t nat *
# v4l2-ctl — camera format queries, PTZ controls, and image controls
dp ALL=(ALL) NOPASSWD: /usr/bin/v4l2-ctl *
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
cd /home/dp/digitalpool-camera && git pull
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
dp ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/netplan/99-digitalpool-ethernet.yaml
dp ALL=(ALL) NOPASSWD: /usr/sbin/netplan apply
dp ALL=(ALL) NOPASSWD: /usr/bin/timedatectl set-timezone *
dp ALL=(ALL) NOPASSWD: /usr/sbin/reboot
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

## 7e. Dedicated Hotspot Service — Fast Startup Without Ethernet

The WiFi hotspot is managed by a **dedicated systemd service** (`digitalpool-hotspot.service`) that runs independently of the Node.js camera app. This architecture means:

- The hotspot comes up even if the camera app crashes or hasn't started yet.
- MediaMTX and the camera service start **after** the hotspot so the hotspot IP (`192.168.50.1`) is already present when `mediamtx-update-hosts.sh` injects ICE candidates — making the WebRTC preview work over hotspot on every boot.
- The script auto-detects whichever WiFi interface is present — USB dongle (`wlx…`) or built-in PCIe/M.2 chip (`wlp…`) — with no configuration required.

### Before you begin — verify AP+STA concurrent mode

The hotspot runs as an **Access Point** on the same chip that also connects to your venue network as a **client** (STA). This requires the WiFi chip to support simultaneous AP+STA mode.

```bash
iw list | grep -A 20 "valid interface combinations"
```

Look for a combination line that includes both `AP` and `managed`:
```
#{ managed } <= 1, #{ AP } <= 1, total <= 2, ...   ← AP+STA supported ✅
```

If no such line exists, the chip only supports one mode at a time — the hotspot will still work, but the device cannot simultaneously connect to a venue WiFi network.

> **Intel built-in chips (GMKtec G5 N97 and similar):** Most Intel WiFi 5/6/6E chips (AX200, AX201, AX210, AX211) support AP+STA concurrent mode on Linux. Confirm with `iw list` before proceeding.

### Install the hotspot script and service

```bash
sudo cp /home/dp/digitalpool-camera/dp-hotspot.sh /usr/local/sbin/dp-hotspot.sh
sudo chmod +x /usr/local/sbin/dp-hotspot.sh

sudo cp /home/dp/digitalpool-camera/digitalpool-hotspot.service /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable digitalpool-hotspot.service
sudo systemctl start digitalpool-hotspot.service
```

**Verify it started and the hotspot is broadcasting:**

```bash
sudo systemctl status digitalpool-hotspot.service
sudo journalctl -u digitalpool-hotspot --no-pager -n 30
```

You should see lines like:

*USB WiFi dongle (Rockchip / Orange Pi 5):*
```
📡 WiFi interface: wlx8c86ddaa1f53 (found after 26s)
📡 Device SSID suffix: 1F53  →  DigitalPool-1F53
✅ Hotspot up — SSID: DigitalPool-1F53  IP: 192.168.50.1
```

*Built-in WiFi chip (Intel GMKtec G5 N97):*
```
📡 WiFi interface: wlp2s0 (found after 0s)
📡 Device SSID suffix: A3F1  →  DigitalPool-A3F1
✅ Hotspot up — SSID: DigitalPool-A3F1  IP: 192.168.50.1
```

The SSID is automatically derived from the last 4 hex characters of the interface MAC address (e.g. `DigitalPool-A3F1`). This ensures two cameras at the same venue never broadcast the same SSID.

> **Self-healing profile:** If the hardware changes (different chip or cloned image), the script detects the SSID or interface mismatch automatically and recreates the NM profile — no manual intervention needed.

### Install the udev rule (USB WiFi adapters only)

The udev rule (`99-digitalpool-hotspot.rules`) fires the hotspot service the instant the kernel registers the WiFi interface. For **USB WiFi adapters** this eliminates the software delay on top of hardware enumeration time.

For **built-in WiFi chips** the udev rule is optional — the chip is present before NetworkManager starts, so the regular `After=NetworkManager.service` ordering in the systemd unit is sufficient. Installing the rule on a built-in-chip machine is harmless (it just starts an already-enabled service redundantly).

```bash
sudo cp /home/dp/digitalpool-camera/99-digitalpool-hotspot.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
```

### Hotspot timing on cold boot

| Phase | Rockchip + USB dongle | Intel + built-in WiFi |
|---|---|---|
| BIOS / U-Boot | ~5 s | ~5 s |
| Kernel | ~4 s | ~4 s |
| WiFi hardware ready | ~26 s (USB enumeration) | ~1 s (PCIe/M.2) |
| Hotspot AP activation | ~8 s | ~8 s |
| **Total from power-on** | **~43 s** | **~18 s** |

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
| Resolution | `1920×1080` | Width × Height. **Match this to the camera's native output** — upscaling wastes CPU and adds 10+ s of startup latency that causes RTMP connections to drop before the first frame arrives. |
| Framerate | `30` fps | Target encode framerate |
| Bitrate | `5 Mbps` | H.264/H.265 target bitrate |
| Audio device | `plughw:2,0` | ALSA device for microphone — use `plughw:` (not `hw:`) so the plug layer handles sample-rate conversion automatically. Run `arecord -l` to find the card number; set it to `plughw:<card>,0`. |
| Audio enabled | `true` | Mux audio into stream |
| A/V Offset | `0` ms | Fine-tune audio/video sync. **Negative** values advance the audio (fix audio lag); **positive** values delay it. Adjust in 50 ms steps — RTSP/USB camera pipelines typically add 80–150 ms of video latency, so values of `-80` to `-150` are common starting points. The value is saved and restored on page load. |

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

Movement uses the camera's native **hardware step size** (read from `v4l2-ctl`) rather than a fixed degree value, giving the finest possible motor resolution for whatever camera is connected.

| Control | Behaviour |
|---|---|
| **Inner ring tap** / **Arrow key tap** | 1 hardware step — maximum precision |
| **Inner ring hold** / **Arrow key hold** | Accelerates from 1 step up to **1 % of total travel** over ~3 seconds |
| **Outer ring** / **Shift+Arrow** | Constant **5 % of total travel** — fast sweep |
| **🏠 Home button** | Return to saved startup position |
| **Set Home** | Save current PTZ as the startup position |
| **Invert Pan** | Reverses the pan direction (checkbox in the PTZ card) |
| **Zoom slider** | Optical zoom 0–100 |

> **Camera hot-swap:** Switching the USB input source resets all PTZ ranges, step sizes, and discovered controls to match the newly connected camera. The UI updates immediately via Socket.IO without a page reload.

> **OBSBot note:** The OBSBot Tiny 2 Lite UVC firmware only accepts whole-degree movements (`step=3600`). One inner-ring tap moves exactly 1 degree — that is the hardware limit, not a software constraint.

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
├── server.js                       # Express + Socket.IO server; main orchestrator
├── streamController.js             # GStreamer pipeline builder & stream lifecycle
├── cameraController.js             # v4l2-ctl wrappers (PTZ, image controls)
├── wifiManager.js                  # NetworkManager AP hotspot management (Node.js side)
├── authManager.js                  # Login / session / IP-ban management
├── puppeteerOverlay.js             # Headless Chromium → transparent PNG overlay
├── gst-overlay-pipeline.py         # Python GStreamer pipeline (overlay, NDI, RTSP)
├── ndi-discover.py                 # NDI source discovery via libndi.so.6 (ctypes)
├── png-overlay-helper.sh           # Shell wrapper invoking the Python pipeline script
├── digitalpool-camera.service      # Systemd unit — camera app (Wants= hotspot + mediamtx)
├── digitalpool-hotspot.service     # Systemd unit — dedicated WiFi hotspot service
├── dp-hotspot.sh                   # Hotspot script: detects adapter, creates NM profile, brings up AP
├── 99-digitalpool-hotspot.rules    # udev rule — starts hotspot service on WiFi adapter detect
├── mediamtx-network-override.conf  # mediamtx.service drop-in — removes ethernet dependency
├── mediamtx-update-hosts.sh        # Updates WebRTC ICE hosts in mediamtx.yml at startup
├── mediamtx-update-hosts.service   # Systemd unit for ICE host update
├── mediamtx-update-hosts.timer     # Systemd timer — re-runs update every 60 seconds
├── network-watchdog.sh             # Network-health watchdog (reboots if offline 20 min)
├── network-watchdog.service        # Systemd unit for watchdog
├── network-watchdog.timer          # Systemd timer — runs every 10 minutes
├── monitor-camera.sh               # Memory flight recorder (logs RSS every 5 min)
├── monitor-camera.service          # Systemd unit for flight recorder
├── monitor-camera.timer            # Systemd timer — runs every 5 minutes
├── package.json
├── .env                            # Environment variables (create — see Step 4a)
├── stream-config.json              # Auto-generated stream settings (persisted by UI)
└── public/
    ├── index.html                  # Web control interface
    ├── login.html                  # Login page
    ├── app.js                      # Client-side Socket.IO + UI logic
    ├── overlay.html                # Local scoreboard HTML template
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

# Add the dp user to the video group if needed:
sudo usermod -aG video dp
newgrp video   # or log out and back in

# Add the dp user to the audio group (required for camera mic / ALSA access):
sudo usermod -aG audio dp
sudo systemctl restart digitalpool-camera   # picks up the new group immediately
```

### Hardware encoder / decoder not found

```bash
gst-inspect-1.0 mpph264enc
gst-inspect-1.0 mpph265enc
gst-inspect-1.0 mppvideodec  # generic decoder — handles H.264/H.265/VP8/JPEG (no mpph264dec/mpph265dec)
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

**Version compatibility:** The system Chromium is version 114. `puppeteer-core` is pinned to `20.9.0` in `package.json` and installed automatically by `npm install`. Do not upgrade it — newer versions use a DevTools Protocol revision that Chromium 114 does not support, causing Chromium to crash silently with a misleading "Timed out after waiting 30000ms" error.

```bash
# Verify the correct version is installed:
npm list puppeteer-core
# Should print: puppeteer-core@20.9.0
```

### Audio / video drift after long streams

Ensure the Python script (`gst-overlay-pipeline.py`) is being used rather than the raw shell pipeline — it forces GStreamer's system clock to `CLOCK_REALTIME`, matching FFmpeg's `av_gettime` source and eliminating long-term drift between the video and audio PTS streams.

### OBS connects to RTSP but "no stream is available on path 'live'"

MediaMTX is running but nothing is pushing video to it. The most common cause is the `dp` user lacking permission to open the ALSA audio device, which causes the ffmpeg audio process to crash before it ever reaches MediaMTX.

```bash
# Confirm the audio card is present (should list capture devices)
cat /proc/asound/cards

# If arecord -l shows nothing for the dp user, the audio group is missing:
sudo usermod -aG audio dp
sudo systemctl restart digitalpool-camera

# Also confirm the audio device in Admin Settings uses plughw: (not hw:)
# Run arecord -l to find the card number, then set the device to plughw:<card>,0
arecord -l

# Confirm the RTMP push is now active (should show a connection to port 1935)
sudo ss -tnp | grep 1935
```

### Permission denied on camera device

```bash
sudo usermod -aG video,audio,render dp
# Verify:
groups dp
```

### RTSP source — stream fails immediately or "Could not write to resource"

**Symptom:** The stream starts, reaches PLAYING, then dies after ~10 seconds with `❌ GStreamer error: Could not write to resource` from `gstrtmpsink`.

**Cause:** The configured stream resolution is larger than what the RTSP camera actually delivers. The pipeline upscales (e.g. 1080p → 4K) to match the configured resolution, which takes >10 seconds to produce the first encoded frame. MediaMTX closes the RTMP connection before any data arrives.

**Fix:** Set the stream resolution in the admin UI to match the camera's native output (typically **1920×1080** for IP cameras). Do not configure 4K when the RTSP source is 1080p.

---

**Symptom:** Idle preview dies with `streaming stopped, reason not-linked (-1)`.

**Cause:** The RTSP camera sends both video and audio RTP streams. The idle preview pipeline using `uridecodebin` with `caps=video/x-raw` should handle this — if it still fails, confirm you are running the latest code (`git pull`).

```bash
# Check the idle preview is using uridecodebin (not rtspsrc ! decodebin):
sudo journalctl -u digitalpool-camera -f | grep -E "idle|RTSP|not.linked"
# Should show "Building RTSP idle preview pipeline" without "not-linked"
```

---

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
python3 /home/dp/digitalpool-camera/ndi-discover.py 3000
# [] means no sources visible — confirm sender is on the same subnet
# {"error": "Cannot load NDI library"} means libndi.so.6 is missing/wrong path
```

### NDI — GStreamer elements not found (`ndisrc`, `ndisrcdemux`)

```bash
# Check if the plugin .so is in the GStreamer plugin path:
# ARM64 (Rockchip):
ls /usr/lib/aarch64-linux-gnu/gstreamer-1.0/libgstndi.so
# Intel x86_64:
ls /usr/lib/x86_64-linux-gnu/gstreamer-1.0/libgstndi.so

# If missing, rebuild and reinstall the plugin (see section 2l, Step 2).
# After installing, force-refresh the GStreamer plugin registry:
rm -f ~/.cache/gstreamer-1.0/registry.aarch64.bin   # ARM64
rm -f ~/.cache/gstreamer-1.0/registry.x86_64.bin    # Intel x86_64
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
| `❌ NDI video link FAILED` | Element creation failed (plugin missing?) | Verify `mppvideodec` is present — see hardware encoder/decoder check above |

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
gst-inspect-1.0 mppvideodec
# Note: there is no mpph264dec or mpph265dec — mppvideodec is the one generic hardware decoder.
# If missing:
sudo apt install --reinstall gstreamer1.0-rockchip1
# Then clear the plugin registry and retry:
rm -f ~/.cache/gstreamer-1.0/registry.aarch64.bin
gst-inspect-1.0 mppvideodec
```

The pipeline automatically falls back to software decoding (`avdec_h264` / `avdec_h265`) if hardware decoders are unavailable, but CPU usage will be higher.

### Hotspot disappears or WebRTC preview fails over hotspot

If the hotspot appears to work but the WebRTC preview is blank when connected to it, or the hotspot randomly disappears after running for a few minutes, check for USB WiFi adapter firmware crashes:

```bash
dmesg | grep rtw | tail -20
```

Lines such as `failed to leave ips state`, `failed to download firmware`, or `error beacon valid` mean the `rtw_8822bu` driver's power-save mode is crashing the adapter. Fix it permanently:

```bash
# Create the modprobe option file (persists across reboots and plug-ins)
echo "options rtw_8822bu ips=0 lps=0" | sudo tee /etc/modprobe.d/rtw_8822bu.conf

# Verify
cat /etc/modprobe.d/rtw_8822bu.conf
# → options rtw_8822bu ips=0 lps=0

# Unplug the USB adapter, wait 5 s, plug it back in (or reboot)
# Then confirm no more errors:
dmesg | grep rtw | tail -10
```

If the hotspot itself is healthy but the WebRTC preview fails only when connected via hotspot (works fine on LAN), the MediaMTX ICE candidate list is probably missing the hotspot IP `192.168.50.1`. This happens when MediaMTX started before the hotspot came up:

```bash
# Check — 192.168.50.1 must be listed:
grep webrtcAdditionalHosts /etc/mediamtx.yml

# Quick fix — force the ICE hosts to update now:
sudo /usr/local/bin/mediamtx-update-hosts.sh

# Permanent fix — install the NM dispatcher (see Section 2k.2):
ls /etc/NetworkManager/dispatcher.d/99-mediamtx-update-hosts
```

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
cd /home/dp/digitalpool-camera
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

Required for the live WebRTC admin preview to work over LAN, NetBird, and the hotspot simultaneously.

```bash
sudo cp /home/dp/digitalpool-camera/mediamtx-update-hosts.sh /usr/local/bin/
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

#### USB WiFi adapter — disable power-saving modes (rtw_8822bu chipset)

Required if the hotspot adapter uses the Realtek RTL8822BU chipset. Without this the driver periodically crashes and the hotspot disappears.

```bash
# Check if already applied:
cat /etc/modprobe.d/rtw_8822bu.conf 2>/dev/null
# If that prints nothing, create it:
echo "options rtw_8822bu ips=0 lps=0" | sudo tee /etc/modprobe.d/rtw_8822bu.conf

# Unplug and replug the USB adapter (or reboot) to apply
```

#### NetworkManager dispatcher — keep ICE hosts updated when hotspot comes up late

Without this, the hotspot IP (`192.168.50.1`) won't be in the MediaMTX ICE candidate list if the hotspot started after MediaMTX (the normal boot order). WebRTC preview over the hotspot will fail until MediaMTX is restarted.

```bash
# Check if already present:
ls /etc/NetworkManager/dispatcher.d/99-mediamtx-update-hosts 2>/dev/null

# If missing, create it:
sudo tee /etc/NetworkManager/dispatcher.d/99-mediamtx-update-hosts > /dev/null << 'EOF'
#!/bin/bash
INTERFACE="$1"
ACTION="$2"
if [ "$ACTION" = "up" ]; then
    sleep 2
    /usr/local/bin/mediamtx-update-hosts.sh
fi
EOF

sudo chmod +x /etc/NetworkManager/dispatcher.d/99-mediamtx-update-hosts
```

#### Periodic ICE host refresh timer — catch NetBird and other non-NM interfaces

NetBird is not managed by NetworkManager, so the dispatcher above won't fire when NetBird connects. This timer re-runs the update script every 60 seconds so any interface (NetBird, hotspot, LAN) is always reflected in the ICE candidate list within one cycle.

```bash
# Check if already present:
systemctl list-timers mediamtx-update-hosts.timer 2>/dev/null

# If missing, install and enable it:
sudo cp /home/dp/digitalpool-camera/mediamtx-update-hosts.service \
        /home/dp/digitalpool-camera/mediamtx-update-hosts.timer \
        /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable --now mediamtx-update-hosts.timer

# Verify
systemctl list-timers mediamtx-update-hosts.timer
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

# MediaMTX ICE hosts injected — must include hotspot IP 192.168.50.1
grep webrtcAdditionalHosts /etc/mediamtx.yml

# NM dispatcher for ICE host updates must be present and executable
ls -l /etc/NetworkManager/dispatcher.d/99-mediamtx-update-hosts

# Periodic ICE host refresh timer must be active (catches NetBird and other non-NM interfaces)
systemctl list-timers mediamtx-update-hosts.timer

# WiFi adapter power-save disabled (rtw_8822bu only — skip if different chipset)
cat /etc/modprobe.d/rtw_8822bu.conf
# → options rtw_8822bu ips=0 lps=0

# Hotspot is up
nmcli con show --active | grep -i hotspot
```

---

## License

ISC

## Author

Tim Traver — [github.com/timtraver](https://github.com/timtraver)
