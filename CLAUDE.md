# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node.js web service that turns a USB PTZ camera into a professional live-streaming
appliance for pool/billiards match production. It runs headless on **Intel N97 mini-PCs**
(GMKtec G5) and **Rockchip RK3588 SBCs** (Orange Pi 5, Radxa Rock 5C) under Ubuntu Server
24.04, and is reached from a tablet/phone over an always-on WiFi hotspot it hosts itself.

It streams hardware-encoded H.264 (SRT / RTMP / RTSP), composites transparent PNG overlays
(scoreboards, logos) into the GStreamer pipeline, and exposes camera PTZ + settings control.

## Running & operating

There is **no build step, no linter, and no test suite** (`npm test` is a placeholder that
exits 1). The app is plain CommonJS Node.

```bash
npm start                 # === node server.js ; serves on PORT (default 3000)
```

On a deployed device it runs as a systemd service named `digitalpool-camera`, as user **`dp`**,
from `/home/dp/digitalpool-camera`:

```bash
sudo systemctl restart digitalpool-camera
journalctl -u digitalpool-camera -f     # logs
```

The app **cannot run meaningfully on macOS** — it depends on Linux-only tooling
(`v4l2-ctl`, GStreamer with hardware encoders, `nmcli`/NetworkManager, ALSA, MediaMTX).
Development is done on the target device over SSH; the author syncs from the Mac with
`rsync` (see `DEPLOY_GRAPHICS.md`). The default admin login is `admin` / `Digitalpool`
(forced password change on first login; see `authManager.js`).

`do_git.py` is a personal helper that scripts `git add/commit/push` and writes output to
`do_git_out.txt` — plain `git` works fine; you do not need it.

> Note: `package.json`, several docs, and code comments still reference "Jetson Nano" — that
> is **legacy**. Current hardware targets are Intel N97 and Rockchip RK3588. Jetson encoder
> paths (`nvv4l2h264enc`) remain as fallbacks but aren't the primary target.

## Architecture

The system is one Node process orchestrating external media processes. Nothing does encoding
in Node — Node builds command lines, spawns child processes, and pipes/monitors them.

**`server.js`** (~4800 lines) — the hub. Express REST API + Socket.IO, session auth (shared
between HTTP and WebSocket via the same session middleware), captive-portal responses for the
hotspot, a GraphQL/API proxy to `digitalpool.com`, system/network/WiFi/remote-access admin
endpoints, and graceful shutdown (kills child media processes within a hard 7s deadline).

**`streamController.js`** (~2470 lines, extends EventEmitter) — one instance *per stream*.
Owns the full media pipeline lifecycle: auto-detects the hardware encoder, builds the
GStreamer/ffmpeg command, spawns and supervises the child processes, monitors FPS / bitrate /
clock drift, and tears everything down on stop. Emits `preparing`/`started`/`stopped`/`error`/
`log`/`fps`/`bitrate`/`drift` which `server.js` relays to clients over Socket.IO.

**`gst-overlay-pipeline.py`** (~81KB, Python + GLib/GStreamer) — the *actual* streaming engine,
spawned as a child by `streamController`. Unlike `gst-launch-1.0` it reloads the overlay PNG at
runtime by polling the file's mtime and updating `gdkpixbufoverlay`'s `location`. It forces the
GStreamer system clock to `CLOCK_REALTIME` at startup — this is the basis of long-term A/V sync
(both audio and video use wall-clock timestamps). CLI arg order is a fragile contract between
this script and `streamController._buildGStreamerPipeline()` / `_buildPNGOverlayPipeline()` —
changing one requires changing the other.

**`cameraController.js`** (~843 lines) — one instance *per camera*. PTZ + image controls via
`v4l2-ctl`. PTZ commands are serialized onto a promise chain (`_ptzQueue`) to prevent racing
`v4l2-ctl` processes from reading stale pan/tilt state. Discovers real hardware control ranges
at activation; falls back to hardcoded OBSBOT Tiny 2 Lite ranges otherwise.

**`puppeteerOverlay.js`** (~528 lines) — renders the overlay PNG that GStreamer composites.
Two modes: local HTML via `wkhtmltoimage` + ImageMagick chroma-key, or a remote URL screenshotted
by headless Chromium (`puppeteer-core`) with native transparency. Writes to
`/tmp/graphics-overlay.png`. Restarts Chromium hourly to bound memory growth (Chrome orphans are
also killed by the service's `ExecStopPost`).

**`authManager.js`** — bcrypt users persisted to `users.json`; guards `requireAuth`/`requireAdmin`.

**`wifiManager.js`** — manages the always-on AP hotspot (`DigitalPool-Camera`) via `nmcli`,
running concurrently with client WiFi (AP+STA). Onboard chip runs the AP; USB dongle is the client.

**`public/`** — static frontend served by Express: `index.html` + `app.js` (~4900 lines),
`login.html`, `overlay.html`. No framework, no bundler.

### Dual-camera / dual-stream model

The app supports two independent cameras/streams. `server.js` constructs
`streamController` + `camera` (id 1, `/dev/video0`) and `streamController2` + `camera2`
(id 2, `/dev/video2`, optional). `getSC(idx)` / camera lookups route requests by index. The
`streamId` / `controllerId` (1 or 2) drives **everything that must not collide**: per-stream
config filenames (`camera-config-2.json`, etc.), MediaMTX path names, and ports — e.g. camera 1
serves SRT on **8891**, camera 2 on **8892**.

### External services it depends on

- **MediaMTX** (separate systemd service) — provides the RTSP server (`:8554`), RTMP (`:8890`),
  and the WebRTC **WHEP** low-fps browser preview. The Node app proxies WHEP offers over
  Socket.IO (`whep-offer`) and manages MediaMTX paths per stream.
- **NetBird** — the VPN behind the admin "Remote Access" toggle (`/api/remote/*`).
- Config is `.env` (see `.env.example`: `PORT`, `CAMERA_DEVICE`, `CAMERA_DEVICE_2`, NetBird keys)
  plus JSON state files written into the repo dir (`users.json`, `camera-config*.json`,
  `camera-startup-config*.json`) — these are runtime state, not committed.

### Systemd hardening worth knowing (`digitalpool-camera.service`)

- `MemoryMax=2500M` cgroup cap — the Python/GStreamer process leaked to 3.3GB over ~8h and
  triggered the kernel OOM killer, which took down the WiFi driver. The cgroup cap makes the
  kernel kill only this service (→ `Restart=always`) instead of random system processes.
- `OOMScoreAdjust=-900` protects Node itself. Watchdog is deliberately **not** per-service
  (keepalives from `execFile` children get rejected and killed the service every ~60s);
  last-resort protection is the hardware watchdog in `/etc/systemd/system.conf.d/watchdog.conf`.

## Reference docs in the repo

`README.md` is a ~95KB step-by-step device provisioning guide (OS install → drivers → service).
`STREAMING_ARCHITECTURE.md`, `SRT_SETUP_GUIDE.md`, `OBS_SETUP_GUIDE.md`, `DEPLOY_GRAPHICS.md`
cover streaming/receiver setup. `.sh`/`.service`/`.timer`/`.rules` files at the repo root are
device provisioning artifacts (hotspot, network watchdog, camera monitor, device reset).
