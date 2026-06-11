const { spawn, exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");

// ── MPEG-TS PTS extractor ────────────────────────────────────────────────────
// Scans a raw MPEG-TS buffer and returns the first PTS value found in any PES
// packet, converted from 90 kHz ticks to seconds. Returns null if no PTS is
// found (e.g. the chunk contains only PAT/PMT/adaptation-only packets).
//
// Available for diagnostics / future use (e.g. logging the GStreamer running_time
// at ffmpeg spawn time).  Not used in the main sync path — both audio and video
// use -use_wallclock_as_timestamps 1 (av_gettime) for rate alignment.
function extractMpegtsPts(buf) {
  for (let i = 0; i + 188 <= buf.length; i += 188) {
    if (buf[i] !== 0x47) continue;                    // MPEG-TS sync byte

    const payloadStart = (buf[i + 1] >> 6) & 1;       // payload_unit_start_indicator
    if (!payloadStart) continue;

    const adaptCtrl = (buf[i + 3] >> 4) & 0x3;
    if ((adaptCtrl & 1) === 0) continue;               // no payload in this packet

    // Skip adaptation field if present (adaptation_field_length at byte [i+4])
    let pOff = i + 4;
    if (adaptCtrl & 2) pOff += 1 + buf[i + 4];

    // Verify PES start code: 0x000001
    if (buf[pOff] !== 0x00 || buf[pOff + 1] !== 0x00 || buf[pOff + 2] !== 0x01) continue;

    // PTS_DTS_flags are in byte 7 of the PES header (bits 7-6)
    if (pOff + 13 >= buf.length) continue;
    const ptsDtsFlags = (buf[pOff + 7] >> 6) & 0x3;
    if (ptsDtsFlags < 2) continue;                     // no PTS field

    // PTS is encoded across bytes [pOff+9 … pOff+13] in 5-byte MPEG-TS notation
    const p = pOff + 9;
    const pts =
      ((buf[p]     & 0x0E) >>> 1) * 0x40000000 +      // PTS[32:30] × 2³⁰
       (buf[p + 1]        ) * 0x400000    +            // PTS[29:22] × 2²²
      ((buf[p + 2] & 0xFE) >>> 1) * 0x8000   +        // PTS[21:15] × 2¹⁵
       (buf[p + 3]        ) * 0x80         +           // PTS[14: 7] × 2⁷
      ((buf[p + 4] & 0xFE) >>> 1);                     // PTS[ 6: 0]

    return pts / 90000; // 90 kHz → seconds
  }
  return null;
}

class StreamController extends EventEmitter {
  constructor(cameraDevice = "/dev/video0", options = {}) {
    super();
    this.cameraDevice = cameraDevice;
    // Stream identity — 1 or 2.  Drives config file names, MediaMTX paths, and ports.
    this.streamId = options.streamId || 1;

    // Derived per-stream paths / ports based on streamId
    // Camera 1: /live, /preview, SRT :8891
    // Camera 2: /live2, /preview2, SRT :8892
    this.rtspPath       = this.streamId === 2 ? "/live2"    : "/live";
    this.previewPath    = this.streamId === 2 ? "/preview2" : "/preview";
    this.srtDefaultPort = this.streamId === 2 ? 8892       : 8891;
    // Per-camera overlay PNG so both cameras can have independent graphics overlays.
    this.pngOverlayPath = this.streamId === 2
      ? "/tmp/graphics-overlay-2.png"
      : "/tmp/graphics-overlay.png";

    // Active input source — updated via setInputSource() when the user switches in the UI.
    this.inputSource = { type: "usb", device: cameraDevice, rtspUrl: "" };
    // Detected at startup by cameraController.detectCaptureFormat().
    // 'mjpeg' → image/jpeg ! jpegparse ! <decoder> (mppjpegdec on Rockchip, jpegdec elsewhere)
    // 'yuyv'  → video/x-raw,format=YUYV ! videoconvert (software convert, YUYV-only cameras)
    this.captureFormat = 'mjpeg';
    this.gstProcess = null;
    this.ffmpegProcess = null; // Separate ffmpeg process for SRT+audio hybrid
    this.isStreaming = false;
    this._fpsInterval = null;
    this._bitrateInterval = null;
    // Separate config file per stream so each camera persists its own settings.
    this.configFile = path.join(__dirname, this.streamId === 2 ? "stream-config-2.json" : "stream-config.json");

    // Default configuration
    const defaultConfig = {
      protocol: "rtsp", // 'rtsp' (RTSP server via MediaMTX), 'srt', or 'rtmp'
      destination: "",
      width: 1920,
      height: 1080,
      framerate: 30,
      bitrate: 5000000, // 5 Mbps
      encoder: "mpph264enc", // Rockchip MPP hardware encoder (Orange Pi 5 / RK3588)
      codec: "h264", // 'h264' or 'h265' — h265 not supported with RTMP
      autoStart: false, // Auto-start streaming on server startup
      // Overlay settings
      overlayEnabled: true,
      overlayType: "text", // 'text' or 'url'
      overlayText: "DigitalPool",
      showTimestamp: true,
      overlayUrl: "",
      overlayZoom: 100, // Zoom level for remote overlay page (50-200%)
      remoteOverlayEnabled: false, // Enable remote overlay (Puppeteer screenshot)
      timestampPosition: "bottom-right",
      titlePosition: "bottom-left",
      overlayFontSize: 12, // Default font size for overlays
      overlayColor: "white",
      overlayBackground: "transparent",
      overlayBackgroundOpacity: 70,
      // Per-element formatting
      titleFontSize: 12,
      titleColor: "white",
      titleBackground: "transparent",
      timestampFontSize: 6,
      timestampColor: "white",
      timestampBackground: "transparent",
      // Legacy fields
      timestampFormat: "%Y-%m-%d %H:%M:%S",
      logoPath: "", // Path to logo image overlay
      // Audio settings
      audioEnabled: true,      // Include audio in stream
      audioSource: "video",    // "video" = use embedded source audio; "external" = ALSA device
      audioDevice: "plughw:2,0", // ALSA device used when audioSource === "external"
      audioOffset: 0,          // A/V sync offset in ms: negative = advance audio (fix audio lag), positive = delay audio
      // Skia graphics overlay
      skiaGraphicsEnabled: false, // Enable Skia graphics overlay
      skiaGraphicsPort: 8556, // Port where Skia graphics server is running
      skiaGraphicsAlpha: 1.0, // Opacity of graphics overlay (0.0-1.0)
      // Video orientation (for upside-down or mirrored camera mounting)
      flipHorizontal: false, // Mirror video left-to-right
      flipVertical: false,   // Flip video upside-down
      panInverted: false,    // Invert pan direction (some cameras have reversed motor polarity)
      // YouTube Live settings
      youtubeStreamKey: "", // YouTube stream key (stored locally, used to build RTMP destination)
    };

    // Load config from file, merging with defaults to fill in any missing fields
    const savedConfig = this.loadConfig();
    if (savedConfig) {
      this.streamConfig = { ...defaultConfig, ...savedConfig };
    } else {
      this.streamConfig = defaultConfig;
      // Save defaults so a config file always exists
      this.saveConfig();
    }
  }

  /**
   * Update the active input source used by all pipeline builders.
   * Call this whenever the user switches from USB to RTSP (or back) in the UI.
   */
  setInputSource(source) {
    this.inputSource = { ...source };
    if (source.type === "usb" && source.device) {
      this.cameraDevice = source.device;
    }
    let sourceDetail = "";
    if (source.type === "rtsp") sourceDetail = " → " + source.rtspUrl;
    else if (source.type === "ndi") sourceDetail = " → " + (source.ndiName || "(no name)");
    else sourceDetail = " → " + this.cameraDevice;
    console.log(`📷 StreamController input source updated: ${source.type}${sourceDetail}`);
  }

  /**
   * Initialize and auto-start if configured
   */
  async initialize() {
    // Auto-detect encoder: if the configured encoder is not available on this
    // hardware, switch to the best available one and persist the change.
    // This lets the same codebase run on RK3588 (mpph264enc) and Intel N97
    // (vaapih264enc) without any manual config editing.
    await this._autoDetectEncoder();

    if (this.streamConfig.autoStart) {
      console.log("🚀 Auto-starting stream on server startup...");
      // Wait a moment for the system to be ready
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const result = await this.startStream();
      if (result.success) {
        console.log("✅ Auto-start successful");
      } else {
        console.error("❌ Auto-start failed:", result.error);
      }
    }
  }

  /**
   * Check whether the configured encoder plugin is present on this machine.
   * If it is missing, run full encoder detection and update streamConfig.encoder
   * to the best available option, then persist the change.
   *
   * Rockchip RK3588      → mpph264enc      (Rockchip MPP GStreamer plugin)
   * Intel N97 / iGPU    → vaapih264enc    (gstreamer1.0-vaapi)
   * NVIDIA Jetson        → nvv4l2h264enc
   * Allwinner A733 (OMX) → omxh264videoenc (libgstreamer-openmax-allwinner)
   * Software             → x264enc
   */
  async _autoDetectEncoder() {
    const configured = this.streamConfig.encoder || "mpph264enc";

    const available = await new Promise((resolve) => {
      const check = spawn("gst-inspect-1.0", [configured]);
      check.on("close", (code) => resolve(code === 0));
      check.on("error", () => resolve(false));
    });

    if (available) {
      console.log(`✅ Encoder "${configured}" confirmed available on this hardware`);
      return;
    }

    console.log(`⚠️  Configured encoder "${configured}" not found — running hardware detection…`);
    const result = await StreamController.testGStreamer();

    if (result.success && result.encoder !== configured) {
      console.log(`🔧 Auto-switching encoder: ${configured} → ${result.encoder} (${result.message})`);
      this.streamConfig.encoder = result.encoder;
      this.saveConfig();
    } else if (!result.success) {
      console.error("❌ No GStreamer encoder found — streaming will fail:", result.error);
    }
  }

  /**
   * Return the GStreamer JPEG decoder element name appropriate for the
   * active encoder family.
   *
   * Rockchip (mpph264enc / mpph265enc) → mppjpegdec (MPP hardware JPEG decode)
   * Everything else (Intel vaapih264enc, NVIDIA, x264enc) → jpegdec (software)
   *
   * On Intel N97, the CPU is fast enough for software JPEG decode at 1080p@30fps,
   * and using jpegdec avoids an additional dependency on vaapijpegdec.
   *
   * @param {string} [encoder] - encoder name; falls back to this.streamConfig.encoder
   * @returns {string} GStreamer element name
   */
  _getJpegDecoder(encoder) {
    const enc = encoder || this.streamConfig.encoder || "mpph264enc";
    return enc.startsWith("mpp") ? "mppjpegdec" : "jpegdec";
  }

  /**
   * Load configuration from JSON file
   */
  loadConfig() {
    try {
      if (fs.existsSync(this.configFile)) {
        const data = fs.readFileSync(this.configFile, "utf8");
        const config = JSON.parse(data);
        console.log("✅ Loaded stream config from file:", this.configFile);
        return config;
      }
    } catch (error) {
      console.error("❌ Error loading config file:", error.message);
    }
    return null;
  }

  /**
   * Save configuration to JSON file
   */
  saveConfig() {
    try {
      fs.writeFileSync(
        this.configFile,
        JSON.stringify(this.streamConfig, null, 2),
        "utf8",
      );
      console.log("✅ Saved stream config to file:", this.configFile);
      return true;
    } catch (error) {
      console.error("❌ Error saving config file:", error.message);
      return false;
    }
  }

  /**
   * Probe ALSA for capture devices and return the first valid plughw string,
   * or null if none are found.  Used to auto-correct a bad audioDevice setting.
   */
  async _detectAlsaCaptureDevice() {
    return new Promise((resolve) => {
      const proc = spawn("aplay", ["-l"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      proc.stdout.on("data", (d) => { out += d.toString(); });
      proc.on("close", () => {
        // "aplay -l" lists playback cards; we need capture → use "arecord -l"
        resolve(null); // placeholder; real logic below uses arecord
      });
      proc.on("error", () => resolve(null));
    }).then(() => new Promise((resolve) => {
      const proc = spawn("arecord", ["-l"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      proc.stdout.on("data", (d) => { out += d.toString(); });
      proc.on("close", () => {
        // Example line: "card 2: Device [USB PnP Sound Device], device 0: ..."
        const m = out.match(/card\s+(\d+):.*device\s+(\d+):/i);
        if (m) {
          resolve(`plughw:${m[1]},${m[2]}`);
        } else {
          resolve(null);
        }
      });
      proc.on("error", () => resolve(null));
    }));
  }

  /**
   * Given a V4L2 video device path (e.g. /dev/video0), locate the ALSA capture
   * device that shares the same USB bus port and return its plughw: string.
   *
   * Strategy: udevadm resolves each device to a sysfs path like
   *   /devices/platform/fc880000.usb/usb3/3-1/3-1:1.0/video4linux/video0
   * The USB device (port 3-1) is the ancestor two levels above the interface
   * (3-1:1.0).  Any ALSA card whose sysfs path starts with that same USB device
   * path belongs to the same physical USB device — i.e., this camera's mic.
   *
   * Returns null if udevadm is unavailable, the device path is unexpected, or
   * no matching audio card is found.
   */
  async _detectAlsaForVideoDevice(videoDevice) {
    try {
      // Get the sysfs path for the V4L2 device
      const { stdout: raw } = await execAsync(
        `udevadm info --query=path --name=${videoDevice} 2>/dev/null`,
        { timeout: 3000 }
      );
      const videoSysPath = raw.trim();

      // Extract the USB device path (strip the interface suffix and below).
      // e.g., /devices/.../usb3/3-1/3-1:1.0/video4linux/video0
      //   USB device path → /devices/.../usb3/3-1
      const m = videoSysPath.match(/^(.*\/usb\d+\/\d+-[\d.]+)\//);
      if (!m) return null;
      const usbDevPath = m[1];

      // Scan /sys/class/sound/cardN entries for one on the same USB device
      const { stdout: sndList } = await execAsync(
        "ls /sys/class/sound/ 2>/dev/null", { timeout: 2000 }
      );
      const cardDirs = sndList.trim().split("\n").filter((d) => /^card\d+$/.test(d));

      for (const cardDir of cardDirs) {
        const cardNum = cardDir.replace("card", "");
        try {
          const { stdout: cardRaw } = await execAsync(
            `udevadm info --query=path /sys/class/sound/${cardDir} 2>/dev/null`,
            { timeout: 2000 }
          );
          if (cardRaw.trim().startsWith(usbDevPath)) {
            return `plughw:${cardNum},0`;
          }
        } catch { /* card may not expose a udevadm path — skip */ }
      }
      return null;
    } catch {
      return null; // udevadm not installed or device not yet enumerated
    }
  }

  /**
   * Start streaming with current configuration
   */
  async startStream(config = {}) {
    if (this.isStreaming) {
      return { success: false, error: "Stream already running" };
    }

    // Merge config
    this.streamConfig = { ...this.streamConfig, ...config };

    // 'youtube' and 'facebook' are UI-only aliases — normalize to 'rtmp' so
    // every pipeline branch (protocol checks, ffmpeg hybrid, getStatus) works.
    if (this.streamConfig.protocol === "youtube" ||
        this.streamConfig.protocol === "facebook") {
      this.streamConfig.protocol = "rtmp";
    }

    // For RTMP, destination is optional (defaults to local MediaMTX)
    // For SRT server mode, destination is not needed (device acts as server)

    try {
      // Kill any ffmpeg processes using the camera device
      console.log("Checking for processes using camera device...");
      await this._killCameraProcesses();

      // Kill any process using port 8555 (legacy TCP preview server — Camera 1 only).
      // Camera 2 does not use port 8555 so skipping this prevents interfering with
      // an unrelated process that happens to be on that port.
      if (this.streamId === 1) {
        console.log("🔍 [Cam1] Checking for processes using port 8555...");
        await this._killPortProcess(8555);
        console.log("✅ [Cam1] Port 8555 cleanup complete");
      }

      // Create HLS directory for preview stream
      const fs = require("fs");
      const hlsDir = "/tmp/stream";
      if (!fs.existsSync(hlsDir)) {
        fs.mkdirSync(hlsDir, { recursive: true });
        console.log("📁 Created HLS directory:", hlsDir);
      } else {
        // Clean old segments
        const files = fs.readdirSync(hlsDir);
        files.forEach((file) => {
          fs.unlinkSync(`${hlsDir}/${file}`);
        });
        console.log("🧹 Cleaned old HLS segments");
      }

      // Short buffer after _killCameraProcesses() confirms the device is free.
      // The poll loop inside _killCameraProcesses() already waits for the kernel
      // to release the v4l2 device, so only a small grace period is needed here.
      console.log("⏳ Waiting for resources to be released...");
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Emit "preparing" event so graphics overlay can initialize before GStreamer starts
      // Wait for the event handlers to complete (they may be async)
      await new Promise((resolve) => {
        this.emit("preparing");
        // Give event handlers time to complete (PNG generation + file write)
        setTimeout(resolve, 1500);
      });

      // Auto-detect the ALSA capture device for USB cameras when using the
      // camera's built-in mic (audioSource !== "external").  This correlates
      // the V4L2 video device to its onboard audio card via the shared USB bus
      // path reported by udevadm.  The result is written to streamConfig so
      // both _buildGStreamerPipeline() and the ffmpeg hybrid audio section
      // below pick it up without needing separate detection calls.
      // When detection fails (udevadm unavailable, unexpected sysfs layout),
      // the previously configured audioDevice is used as a fallback.
      if (
        this.streamConfig.audioEnabled &&
        this.streamConfig.audioSource !== "external" &&
        this.inputSource.type === "usb"
      ) {
        const detected = await this._detectAlsaForVideoDevice(this.cameraDevice);
        if (detected) {
          console.log(
            `🎤 [Cam${this.streamId}] Auto-matched audio: ${this.cameraDevice} → ${detected}`
          );
          this.streamConfig.audioDevice = detected;
        } else {
          console.log(
            `🎤 [Cam${this.streamId}] USB audio auto-detect failed — ` +
            `using: ${this.streamConfig.audioDevice || "plughw:2,0"}`
          );
        }
      }

      const gstArgs = this._buildGStreamerPipeline();

      // Hybrid A/V sync strategy (audio-enabled SRT/RTMP):
      //   GStreamer (Python pipeline) outputs VIDEO-ONLY MPEG-TS to stdout, and a
      //   separate ffmpeg process captures ALSA audio and muxes both streams.
      //
      // Clock alignment — the root fix for long-term A/V drift:
      //   Both audio and video use -use_wallclock_as_timestamps 1 so ffmpeg stamps
      //   every packet with av_gettime() (CLOCK_REALTIME, NTP-adjusted).  Both streams
      //   therefore advance at exactly the same wall-clock rate — no drift can accumulate
      //   regardless of session length.
      //
      // Why -use_wallclock_as_timestamps 1 on the VIDEO pipe too?
      //   v4l2src sets buffer PTS from the kernel capture timestamp, which uses
      //   CLOCK_MONOTONIC (raw hardware oscillator).  Even with the GStreamer pipeline
      //   clock forced to CLOCK_REALTIME, the PTS embedded in mpegtsmux output still
      //   advance at the MONOTONIC rate.  On the Orange Pi 5 (RK3588), MONOTONIC runs
      //   slightly slower than NTP-adjusted REALTIME, so a -itsoffset-only approach
      //   causes audio to gradually overtake video (seen as audio starting a few seconds
      //   behind, slowly catching up, then passing — growing worse over hours).
      //   Replacing the MPEG-TS PTS with av_gettime() on the video pipe side eliminates
      //   this rate mismatch at the source.
      //
      // The duplicate-DTS problem and its accumulation-free fix:
      //   A single pipe read() often returns a burst of N frames that all get the SAME
      //   av_gettime() millisecond.  For SRT, +genpts regenerates sequential PTS from
      //   the frame duration and no further patching is needed.  For RTMP/FLV, DTS must
      //   also be strictly monotonic; the setts BSF assigns each frame an absolute DTS:
      //     DTS = STARTDTS + frame_number × frameTicks
      //   Because STARTDTS is set once from the first frame's wall-clock timestamp and
      //   frame_number (setts variable N) is an exact counter, every frame gets an
      //   independent, correctly-spaced DTS — no relative bumping, no accumulation.
      const useFfmpegAudio =
        (this.streamConfig.protocol === "srt" || this.streamConfig.protocol === "rtmp" || this.streamConfig.protocol === "rtsp") &&
        this.streamConfig.audioEnabled &&
        // When audioSource === "external" the user has chosen a plugged-in ALSA
        // device regardless of what the video input type is — enable the hybrid
        // ffmpeg audio path for all input types in that case.
        // When audioSource === "video", RTSP/NDI sources carry embedded audio that
        // GStreamer handles internally; the ffmpeg ALSA hybrid is not needed.
        (this.streamConfig.audioSource === "external" ||
          (this.inputSource.type !== "rtsp" && this.inputSource.type !== "ndi"));

      // Check if we're using the compositor helper script
      if (gstArgs.useCompositorScript) {
        console.log("Starting GStreamer with compositor script...");
        console.log("Script args:", gstArgs.scriptArgs.join(" "));

        // In SRT+audio mode the Python script writes a full audio+video MPEG-TS
        // to stdout (fdsink fd=1). Always pipe stdout so ffmpeg can read it;
        // all Python diagnostics go to stderr (captured by the stderr handler below).
        const compositorOpts = useFfmpegAudio
          ? { stdio: ["ignore", "pipe", "pipe"] }
          : { stdio: ["ignore", "pipe", "pipe"] }; // always pipe — diagnostics on stderr

        // Check if scriptPath is a Python script, Node script, or bash script
        if (gstArgs.scriptPath === 'python3' || gstArgs.scriptPath === 'node') {
          // For Python/Node scripts, spawn the interpreter directly with script as first arg
          this.gstProcess = spawn(gstArgs.scriptPath, gstArgs.scriptArgs, compositorOpts);
        } else {
          // For bash scripts, spawn bash with script path
          this.gstProcess = spawn("bash", [gstArgs.scriptPath, ...gstArgs.scriptArgs], compositorOpts);
        }
      } else {
        console.log("Starting GStreamer with pipeline:", gstArgs.join(" "));
        if (useFfmpegAudio) {
          // stdout is binary MPEG-TS destined for ffmpeg — must be a pipe, not inherited
          this.gstProcess = spawn("gst-launch-1.0", gstArgs, {
            stdio: ["ignore", "pipe", "pipe"],
          });
        } else {
          this.gstProcess = spawn("gst-launch-1.0", gstArgs);
        }
      }

      if (!useFfmpegAudio) {
        // In hybrid mode stdout is raw binary MPEG-TS — do not attach a text listener
        this.gstProcess.stdout.on("data", (data) => {
          console.log(`GStreamer stdout: ${data}`);
          this.emit("log", data.toString());
        });
      }

      this.gstProcess.stderr.on("data", (data) => {
        const message = data.toString();

        // Suppress high-frequency operational messages that add no debugging value.
        // "Overlay PNG reloaded" fires every time Puppeteer updates the screenshot
        // (every ~5s) — logging it every time floods the console and stream log.
        if (message.includes("Overlay PNG reloaded")) {
          return; // silently discard
        }

        console.error(`GStreamer stderr: ${message}`);

        // Parse drift check line and emit the primary (running-time) ppm to the UI.
        // Format: "🕒 Drift check — Wall: 60.056s  rt=59.800s Δ-0.256s (-4265.3 ppm)  pos=... [clock≈wall ✅]"
        // The regex grabs the first (N ppm) group, which is always the rt= running-time
        // drift — the accurate clock-based measurement.  The secondary pos= group (which
        // on audio pipelines reflects alsasrc USB-oscillator sample counting, not real
        // drift) appears later in the line and is intentionally ignored here.
        const driftMatch = message.match(/\((-?[\d.]+)\s*ppm\)/);
        if (driftMatch) {
          this.emit("drift", parseFloat(driftMatch[1]));
        }

        // Only emit as error if it's an actual error (contains ERROR, WARNING, or CRITICAL)
        // Ignore informational messages like NVMEDIA, NvMMLite, H264 profile info
        if (
          message.includes("ERROR") ||
          message.includes("WARNING") ||
          message.includes("CRITICAL") ||
          message.includes("failed") ||
          message.includes("Failed")
        ) {
          this.emit("error", message);
        } else {
          // Treat as informational log
          this.emit("log", message);
        }
      });

      this.gstProcess.on("close", async (code) => {
        console.log(`GStreamer process exited with code ${code}`);
        this.isStreaming = false;
        this.gstProcess = null;
        this._stopFpsMonitoring();
        this._stopBitrateMonitoring();

        // When GStreamer exits its stdout pipe closes, which causes ffmpeg to see EOF
        // on stdin and exit naturally. Kill explicitly in case it hangs.
        if (this.ffmpegProcess) {
          try { this.ffmpegProcess.kill("SIGINT"); } catch (_) {}
          this.ffmpegProcess = null;
        }

        // If GStreamer failed (non-zero exit code), ensure camera is released
        if (code !== 0 && code !== null) {
          console.error(`❌ GStreamer failed with exit code ${code}`);
          console.error("💡 Common causes:");
          console.error("   - Missing plugin (e.g., srtsink for SRT)");
          console.error("   - Invalid pipeline syntax");
          console.error("   - Camera device busy");
          console.error("💡 Run 'gst-inspect-1.0 srtsink' to check if SRT plugin is installed");
          console.log("⚠️  GStreamer failed, cleaning up camera resources...");
          await this._killCameraProcesses();
        }

        this.emit("stopped", code);
      });

      // Spawn ffmpeg for hybrid A/V mux: reads video-only MPEG-TS from GStreamer's
      // stdout and muxes it with ALSA audio capture.
      //
      // Timestamp strategy — "wall-clock timestamps on both streams":
      //
      //  Audio  → -use_wallclock_as_timestamps 1 replaces USB-oscillator-derived PTS
      //            with av_gettime() (CLOCK_REALTIME), eliminating USB drift entirely.
      //
      //  Video  → -use_wallclock_as_timestamps 1 replaces GStreamer's MONOTONIC-rate PTS
      //            (v4l2src uses kernel capture timestamps via CLOCK_MONOTONIC regardless
      //            of the pipeline clock setting) with av_gettime() (CLOCK_REALTIME).
      //            Both streams now advance at the same NTP-adjusted wall-clock rate.
      //            +genpts regenerates sequential PTS for frames that arrive in a burst
      //            (multiple frames per pipe read() — all stamped with the same ms).
      //            For RTMP/FLV, DTS must also be strictly monotonic: the setts BSF
      //            assigns each frame an ABSOLUTE DTS = STARTDTS + N × frameTicks.
      //            N is setts' built-in frame counter (0-based, never resets), so each
      //            frame gets an independent, evenly-spaced DTS — no relative bumping,
      //            no error accumulation regardless of how many bursts occur.
      //
      // Applies to both SRT (→ mpegts) and RTMP (→ flv) when audio is enabled.
      if (useFfmpegAudio) {
        const protocol = this.streamConfig.protocol;
        console.log(`📡 Hybrid mode — ffmpeg muxing ALSA audio + GStreamer video → ${protocol.toUpperCase()}`);

        let audioDevice = this.streamConfig.audioDevice || "plughw:2,0";

        // Verify the configured ALSA device exists; auto-detect a fallback if not.
        // arecord -l will fail fast if the device string is bogus, so we do a
        // quick existence check via arecord --duration=0 before spawning the
        // full ffmpeg pipeline.
        // audioDevice === null signals "use silent fallback" (anullsrc).
        let audioDeviceBusy = false;
        await new Promise((resolve) => {
          // Use arecord to probe whether the ALSA device is accessible.
          // IMPORTANT: --duration=0 means "record indefinitely" in ALSA, NOT
          // "record for 0 seconds". We use --nonblock so the open fails
          // immediately (rather than blocking) if the device is busy, and
          // kill the process after 2 s as a safety net in case arecord hangs
          // (e.g. on some USB audio drivers that don't honour --nonblock).
          const check = spawn("arecord", ["-D", audioDevice, "--nonblock", "--duration=2"], {
            stdio: ["ignore", "ignore", "pipe"],
          });

          // Hard-kill the probe after 2.5 s regardless of what it's doing.
          // This ensures the Promise always resolves even if the ALSA driver
          // or arecord itself hangs during device open / close.
          const probeTimeout = setTimeout(() => {
            try { check.kill("SIGKILL"); } catch (_) {}
          }, 2500);
          let checkErr = "";
          check.stderr.on("data", (d) => { checkErr += d.toString(); });
          check.on("close", async (chkCode) => {
            clearTimeout(probeTimeout);
            console.log(`🎤 [Cam${this.streamId}] arecord probe "${audioDevice}" → exit ${chkCode}${checkErr ? " stderr: " + checkErr.trim() : ""}`);
            if (chkCode !== 0) {
              const isBusy = checkErr.includes("Device or resource busy") ||
                             checkErr.includes("resource busy");
              // "No such file" or "Invalid" reliably mean the device path doesn't exist.
              // "cannot open" alone is NOT treated as missing — some ALSA devices return
              // it for format-mismatch reasons even when the device is present; letting
              // ffmpeg's own ALSA open attempt handle that avoids misdirecting to the
              // fallback (which would return the first audio card, usually the onboard
              // Rockchip codec, not the camera mic).
              const isMissing = checkErr.includes("No such file") ||
                                checkErr.includes("Invalid card");
              if (isBusy) {
                // Device exists but is held by another process (e.g., the other camera).
                // Fall back to a silent audio track so the stream still starts.
                console.warn(`⚠️  [Cam${this.streamId}] Audio device "${audioDevice}" is busy — ` +
                  `using silent audio fallback. To fix, go to Stream Settings → Audio ` +
                  `and disable audio or select a different device.`);
                audioDeviceBusy = true;
              } else if (isMissing) {
                console.warn(`⚠️  [Cam${this.streamId}] Audio device "${audioDevice}" not found — scanning for a valid capture device…`);
                const detected = await this._detectAlsaCaptureDevice();
                if (detected) {
                  console.log(`🎤 [Cam${this.streamId}] Fallback ALSA capture device: ${detected}`);
                  audioDevice = detected;
                } else {
                  console.warn(`⚠️  [Cam${this.streamId}] No ALSA capture device found — audio will be absent from this stream`);
                }
              } else {
                // Unknown arecord error (e.g. format mismatch on --duration=0 probe).
                // Let ffmpeg try the device anyway — it handles ALSA format negotiation
                // more robustly than arecord's default params.
                console.log(`🎤 [Cam${this.streamId}] arecord probe returned non-zero for unknown reason — proceeding with ffmpeg`);
              }
            }
            resolve();
          });
          check.on("error", () => resolve()); // arecord not installed — skip
        });

        // ── Part 1: Audio input args (built now) ────────────────────────────
        // -use_wallclock_as_timestamps 1 replaces ALSA's USB-clock-derived PTS
        // with av_gettime() (system wall clock), so audio never drifts relative
        // to real time regardless of how long the session runs.
        //
        // -itsoffset: A/V sync correction for cameras whose MJPEG/encode pipeline
        // adds more video latency than the ALSA capture path.
        //   Negative offset → advance audio timestamps (audio was lagging video).
        //   Positive offset → delay audio timestamps  (audio was leading video).
        // Both streams use wall-clock timestamps so this offset is applied ONCE
        // at start and does not accumulate over time.
        //
        // When the audio device is busy (held by the other camera), use lavfi
        // anullsrc to generate a silent audio track so the stream still starts.
        const audioOffsetSec = (this.streamConfig.audioOffset || 0) / 1000;
        const ffmpegAudioArgs = audioDeviceBusy
          ? [
            "-loglevel", "warning",
            "-f", "lavfi",
            "-i", "anullsrc=sample_rate=48000:channel_layout=stereo",
          ]
          : [
            "-loglevel", "warning",
            // Do NOT use -use_wallclock_as_timestamps for the ALSA input.
            //
            // USB ASYNC audio endpoints (like the OBSBOT Tiny SE) have their own
            // internal crystal and derive timestamps via USB SOF feedback packets.
            // ALSA surfaces these as accurate POSIX timestamps (seconds since epoch).
            //
            // Overriding them with av_gettime() (wall clock stamped AFTER read()
            // returns) introduces OS scheduling jitter of ±5–15 ms per packet.
            // The AAC encoder sees packets arriving "early" and "late" relative to
            // their nominal cadence → audible choppiness from the very first frame.
            //
            // ALSA's POSIX timestamps are absolute (same epoch as the system wall
            // clock) so they naturally align with the wall-clock video stream.
            // aresample=async=10000 below handles any residual USB clock rate drift.
            ...(audioOffsetSec !== 0 ? ["-itsoffset", String(audioOffsetSec)] : []),
            "-f", "alsa",
            // Capture at the OBSBOT's confirmed native rate (32 kHz, S16_LE stereo).
            // Specifying it explicitly avoids negotiation uncertainty.
            "-ar", "32000",
            "-ac", "2",
            // Large input queue: ALSA delivers audio in potentially uneven bursts
            // (especially after long runtimes when the USB oscillator has drifted).
            // A deep queue prevents ffmpeg from stalling its read thread while the
            // demuxer/decoder is busy, which would cause glitchy reads downstream.
            "-thread_queue_size", "32768",
            "-i", audioDevice,
          ];

        // ── Part 2: Output args (built now) ─────────────────────────────────
        const ffmpegOutputArgs = [
          "-map", "1:v",         // video from GStreamer (input 1)
          "-map", "0:a",         // audio from ALSA     (input 0)
          "-c:v", "copy",        // pass H.264 through unchanged
          // RTMP+audio hybrid: two BSFs chained with a comma:
          //
          //  1. filter_units=remove_types=7-8
          //     Strip inline SPS/PPS (NAL types 7 & 8) from the H.264 byte-stream
          //     BEFORE ffmpeg's internal h264_annexb_to_mp4 BSF runs.
          //     With header-mode=each-idr the encoder prepends SPS+PPS before every IDR.
          //     When ffmpeg converts Annex B → AVCC for FLV it sees those inline headers
          //     and emits a new AVC sequence header tag + IDR tag with the SAME DTS —
          //     MediaMTX drops the connection: "DTS is not monotonically increasing".
          //     filter_units strips them so the annexb→mp4 BSF only sees the IDR NALU;
          //     the sequence header is written once at startup from the MPEG-TS PMT
          //     extradata and DTS always strictly advances.
          //     SRT does not use this filter — inline SPS/PPS help OBS resync mid-stream.
          //
          //  2. setts — enforce strict DTS monotonicity for FLV without fixed-rate assumptions.
          //     -use_wallclock_as_timestamps 1 stamps every packet with av_gettime().
          //     A single pipe read() often returns a burst of N frames — all getting the
          //     SAME millisecond timestamp → duplicate DTS → MediaMTX drops the connection.
          //     The formula max(DTS, PREV_OUTDTS+100) bumps any duplicate by 100 ticks
          //     (~1.1 ms at 90 kHz).  This is NOT a continuous accumulator: as soon as the
          //     next non-duplicate frame arrives its av_gettime() value resets the baseline,
          //     so the 100-tick bump is absorbed in the ~33 ms gap to the next real frame.
          //     No N×frameTicks formula is used because that assumes a perfectly uniform
          //     frame rate — any deviation from the configured FPS would immediately skew
          //     all subsequent DTS values away from audio, causing severe A/V delay.
          //     Uses the identity max(a,b) = (a+b+|a-b|)/2 to avoid commas inside the
          //     BSF option string (ffmpeg's BSF parser treats commas as chain delimiters).
          ...(protocol === "rtmp" || protocol === "rtsp"
            ? ["-bsf:v",
               "filter_units=remove_types=7-8,setts=" +
               "dts=(DTS+PREV_OUTDTS+100+abs(DTS-PREV_OUTDTS-100))/2:" +
               "pts=(PTS+PREV_OUTPTS+100+abs(PTS-PREV_OUTPTS-100))/2"]
            : []),
          "-c:a", "aac",
          "-b:a", "128k",
          // Audio filter for long-running USB capture stability:
          //
          // aresample=48000:async=10000
          //    Resample 32 kHz → 48 kHz for AAC.  The USB audio oscillator runs at
          //    a slightly different rate than the system clock (typically ±0.01–0.1%).
          //    Over 13+ hours this accumulates ~65 ms of drift (-1.3 ppm measured).
          //    -use_wallclock_as_timestamps replaces PTS values but does NOT slow
          //    the USB oscillator — the ALSA buffer still fills up over time.
          //    async=10000 allows the resampler to correct up to 10 000 samples/sec
          //    (vs the old 1000), so large accumulated drift is absorbed gradually
          //    and inaudibly rather than in abrupt glitches.
          "-af", "aresample=48000:async=10000",
          // max_interleave_delta: both streams share the same wall-clock epoch, so
          // the interleave delta stays near zero. 1 s cap is a safety margin.
          // muxdelay=0 removes mux buffering.
          "-max_interleave_delta", "1000000",
          "-muxdelay", "0",
          // flush_packets=1 (RTMP/RTSP only): force ffmpeg to flush each encoded packet to
          // the TCP socket immediately. Without this the FLV muxer may hold packets in
          // its write cache waiting for a full block — over a long session that cache
          // can grow and become another source of creeping latency.
          ...(protocol === "rtmp" || protocol === "rtsp" ? ["-flush_packets", "1"] : []),
          ...(protocol === "srt"
            ? ["-f", "mpegts", `srt://0.0.0.0:${this.srtDefaultPort}?mode=listener&latency=200000`]
            : protocol === "rtsp"
            ? ["-f", "flv", `rtmp://localhost:1935${this.rtspPath}`]
            : ["-f", "flv", (
                this.streamConfig.destination && this.streamConfig.destination.trim() !== ""
                  ? this.streamConfig.destination.trim()
                  : `rtmp://localhost:1935${this.rtspPath}`
              )]),
        ];

        // ── Deferred ffmpeg spawn ────────────────────────────────────────────
        // GStreamer's MPP hardware encoder takes 1-2 s to produce its first
        // frame. Deferring the spawn until the first video chunk arrives ensures
        // ALSA capture (and its wall-clock timestamps) begins at the same instant
        // as video, so both streams start stamping with av_gettime() at ~the same
        // wall-clock moment and the muxer normalises them both to start at ~0.
        //
        // NOTE: do NOT call gstStdout.pause() before attaching the listener.
        // pause() sets _readableState.flowing = false; a subsequent "data"
        // listener checks `if (flowing !== false) resume()` and skips resume,
        // leaving the stream permanently paused → once() never fires → ffmpeg
        // never spawns → SRT port never opens.
        const gstStdout = this.gstProcess.stdout;

        gstStdout.once("data", (firstChunk) => {
          // ── Wall-clock timestamps on the video pipe ──────────────────────
          // -use_wallclock_as_timestamps 1 replaces the MPEG-TS packet timestamps
          // (which are CLOCK_MONOTONIC-derived from v4l2src kernel capture times)
          // with av_gettime() (CLOCK_REALTIME).  This matches the rate used by
          // the ALSA audio input and eliminates the MONOTONIC/REALTIME rate
          // mismatch that causes audio to gradually overtake video over hours.
          //
          // +genpts: when a single pipe read() returns a burst of N frames they
          // all receive the same av_gettime() millisecond.  +genpts regenerates
          // sequential PTS for those frames based on the stream's frame duration,
          // so the demuxer never sees duplicate PTS.  For RTMP the setts BSF (in
          // the output args) enforces DTS monotonicity via max(DTS, PREV_OUTDTS+100),
          // absorbing burst duplicates without assuming any fixed frame rate.
          console.log(`🕒 A/V sync (${protocol.toUpperCase()}) — wall-clock timestamps on both audio and video (av_gettime / CLOCK_REALTIME)`);

          const ffmpegVideoArgs = [
            "-use_wallclock_as_timestamps", "1",
            // +genpts: regenerate sequential PTS for burst-read frames.
            // +nobuffer: don't accumulate an internal demux buffer (latency guard).
            // +discardcorrupt (SRT only): drop garbled MPEG-TS packets.
            // low_delay: minimise internal buffering at every stage.
            ...(protocol === "rtmp" || protocol === "rtsp"
              ? ["-fflags", "+genpts+nobuffer", "-flags", "low_delay"]
              : ["-fflags", "+genpts+nobuffer+discardcorrupt", "-flags", "low_delay"]),
            ...(protocol === "rtmp" || protocol === "rtsp"
              ? ["-probesize", "1048576", "-analyzeduration", "500000"]
              : ["-probesize", "32", "-analyzeduration", "0"]),
            "-thread_queue_size", "4096",
            "-f", "mpegts",
            "-i", "pipe:0",
          ];

          const ffmpegArgs = [...ffmpegAudioArgs, ...ffmpegVideoArgs, ...ffmpegOutputArgs];

          console.log("Starting ffmpeg with args:", ffmpegArgs.join(" "));
          // Spawn ffmpeg via `nice -n -5` to give the A/V mux process slightly
          // higher scheduling priority than the default.  GStreamer's Python overlay
          // pipeline runs at 100%+ CPU continuously; without a priority bump the OS
          // scheduler can preempt ffmpeg's ALSA capture thread long enough to cause
          // a buffer underrun → audible choppiness that worsens over many hours.
          // nice -n -5 keeps ffmpeg competitive without requiring root/SCHED_FIFO.
          this.ffmpegProcess = spawn("nice", ["-n", "-5", "ffmpeg", ...ffmpegArgs], {
            stdio: ["pipe", "pipe", "pipe"],
          });

          // Write the first chunk manually, then hand off to pipe().
          this.ffmpegProcess.stdin.write(firstChunk);
          gstStdout.pipe(this.ffmpegProcess.stdin);

          // Accumulate ffmpeg stderr so the close handler can surface a
          // human-readable reason when ffmpeg exits before the stream starts.
          let ffmpegStderrBuf = "";
          this.ffmpegProcess.stderr.on("data", (data) => {
            const msg = data.toString();
            ffmpegStderrBuf += msg;
            // Keep only the last 4 KB — enough to catch startup errors.
            if (ffmpegStderrBuf.length > 4096) {
              ffmpegStderrBuf = ffmpegStderrBuf.slice(-4096);
            }
            console.log(`ffmpeg: ${msg}`);
            this.emit("log", msg);
          });

          this.ffmpegProcess.stdin.on("error", (err) => {
            if (err.code !== "EPIPE") console.error(`ffmpeg stdin error: ${err.message}`);
          });

          this.ffmpegProcess.on("close", (code) => {
            console.log(`ffmpeg exited with code ${code}`);
            this.ffmpegProcess = null;

            if (code !== 0 && code !== null) {
              const isBusy = ffmpegStderrBuf.includes("Device or resource busy") ||
                             ffmpegStderrBuf.includes("resource busy");
              const isAudioErr = ffmpegStderrBuf.includes("cannot open audio device") ||
                                 ffmpegStderrBuf.includes("No such file or directory") ||
                                 ffmpegStderrBuf.includes("Error opening input");

              // ── Auto-retry with silent audio when the ALSA device is busy ──
              // The other camera is holding the only USB audio card. Unpipe
              // GStreamer's stdout, respawn ffmpeg using lavfi anullsrc (silent
              // generated audio) so the video stream still starts.
              if (isBusy && isAudioErr && !this.isStreaming) {
                console.warn(`⚠️  [Cam${this.streamId}] Audio device busy — auto-retrying with silent audio (anullsrc)…`);
                gstStdout.unpipe();

                const silentAudioArgs = [
                  "-loglevel", "warning",
                  "-f", "lavfi",
                  "-i", "anullsrc=sample_rate=48000:channel_layout=stereo",
                ];
                const retryArgs = [...silentAudioArgs, ...ffmpegVideoArgs, ...ffmpegOutputArgs];
                console.log("🔄 Retrying ffmpeg with silent audio:", retryArgs.join(" "));

                this.ffmpegProcess = spawn("nice", ["-n", "-5", "ffmpeg", ...retryArgs], { stdio: ["pipe", "pipe", "pipe"] });
                gstStdout.pipe(this.ffmpegProcess.stdin);

                let retryStderrBuf = "";
                this.ffmpegProcess.stderr.on("data", (data) => {
                  const msg = data.toString();
                  retryStderrBuf += msg;
                  if (retryStderrBuf.length > 4096) retryStderrBuf = retryStderrBuf.slice(-4096);
                  console.log(`ffmpeg (silent retry): ${msg}`);
                  this.emit("log", msg);
                });
                this.ffmpegProcess.stdin.on("error", (err) => {
                  if (err.code !== "EPIPE") console.error(`ffmpeg retry stdin error: ${err.message}`);
                });
                this.ffmpegProcess.on("close", (retryCode) => {
                  console.log(`ffmpeg (silent retry) exited with code ${retryCode}`);
                  this.ffmpegProcess = null;
                  if (retryCode !== 0 && retryCode !== null) {
                    const msg = `ffmpeg retry failed (code ${retryCode}): ${retryStderrBuf.slice(-512)}`;
                    console.error(`❌ ${msg}`);
                    this.emit("error", msg);
                    if (!this.isStreaming && this.gstProcess) {
                      try { this.gstProcess.kill("SIGINT"); } catch (_) {}
                    }
                  }
                });
                setTimeout(() => {
                  if (this.ffmpegProcess && !this.isStreaming) {
                    console.log(`🟢 [Cam${this.streamId}] ffmpeg (silent audio) connected — emitting 'started'`);
                    this.isStreaming = true;
                    this.emit("started");
                    this._startFpsMonitoring();
                    this._startBitrateMonitoring();
                  }
                }, 2000);
                return; // do NOT kill GStreamer or emit error
              }

              // Build a human-readable reason from the buffered stderr.
              let reason = `ffmpeg exited with code ${code}`;
              if (isAudioErr) {
                const devMatch = ffmpegStderrBuf.match(/cannot open audio device (\S+)/);
                const badDev = devMatch ? devMatch[1] : (this.streamConfig.audioDevice || "plughw:2,0");
                if (isBusy) {
                  reason =
                    `❌ Audio device "${badDev}" is in use by another stream.\n` +
                    `Go to Stream Settings → Audio and either:\n` +
                    `  • Disable audio for this camera, or\n` +
                    `  • Connect a second USB audio device and select it here`;
                } else {
                  reason =
                    `❌ Audio device "${badDev}" not found.\n` +
                    `Go to Stream Settings → Audio and either:\n` +
                    `  • Disable audio, or\n` +
                    `  • Enter the correct ALSA device (run "aplay -l" on the device to list cards)`;
                }
              }

              console.error(`❌ ffmpeg failed: ${reason}`);
              this.emit("error", reason);

              // If the stream never became live, kill GStreamer too so the
              // camera is released and the UI gets a clean 'stopped' event.
              if (!this.isStreaming) {
                if (this.gstProcess) {
                  try { this.gstProcess.kill("SIGINT"); } catch (_) {}
                  // gstProcess close handler will emit 'stopped'.
                }
              }
            }
          });

          // In hybrid mode (ffmpeg muxer), the stream is only truly live once
          // ffmpeg has connected to its destination (MediaMTX RTMP/SRT).
          // Wait 2 s after ffmpeg spawns so the upstream has data before clients
          // (OBS, VLC, browser) are told to connect — prevents a race where OBS
          // connects to MediaMTX before the first frames arrive and gives up.
          if (!this.isStreaming) {
            setTimeout(() => {
              if (this.ffmpegProcess && !this.isStreaming) {
                console.log("🟢 ffmpeg connected — emitting 'started'");
                this.isStreaming = true;
                this.emit("started");
                this._startFpsMonitoring();
                this._startBitrateMonitoring();
              }
            }, 2000);
          }
        });
      }

      if (!useFfmpegAudio) {
        // Non-hybrid path: GStreamer handles the sink directly — declare live immediately.
        this.isStreaming = true;
        this.emit("started");
        this._startFpsMonitoring();
        this._startBitrateMonitoring();
      }

      // Enable auto-start and save config
      this.streamConfig.autoStart = true;
      this.saveConfig();

      return { success: true, message: "Stream started" };
    } catch (error) {
      // Ensure camera is released on error
      console.log("⚠️  Stream start failed, cleaning up camera resources...");
      await this._killCameraProcesses();
      this.isStreaming = false;
      this.gstProcess = null;

      return { success: false, error: error.message };
    }
  }

  /**
   * Stop the current stream
   */
  async stopStream() {
    if (!this.isStreaming || !this.gstProcess) {
      return { success: false, error: "No stream running" };
    }

    try {
      this.gstProcess.kill("SIGINT");

      // In hybrid mode, killing GStreamer closes the pipe → ffmpeg sees EOF → exits.
      // Kill explicitly here too in case it doesn't exit on its own.
      if (this.ffmpegProcess) {
        try { this.ffmpegProcess.kill("SIGINT"); } catch (_) {}
        this.ffmpegProcess = null;
      }

      this.isStreaming = false;
      this._stopFpsMonitoring();
      this._stopBitrateMonitoring();

      // Wait for process to fully exit and release the camera device
      // V4L2 devices need time to be released by the kernel after the process exits
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Ensure camera is fully released
      await this._killCameraProcesses();

      // Additional wait for kernel to fully release the V4L2 device
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Disable auto-start and save config
      this.streamConfig.autoStart = false;
      this.saveConfig();

      return { success: true, message: "Stream stopped" };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get current stream status
   */
  getStatus() {
    const localIP = this._getLocalIP();
    const protocol = this.streamConfig.protocol;
    let connectionUrl = null;
    if (protocol === "rtsp") {
      connectionUrl = `rtsp://${localIP}:8554${this.rtspPath}`;
    } else if (protocol === "srt") {
      connectionUrl = `srt://${localIP}:${this.srtDefaultPort}`;
    }
    return {
      isStreaming: this.isStreaming,
      config: this.streamConfig,
      connectionUrl,
      localIP,
      streamId:    this.streamId,
      rtspPath:    this.rtspPath,
      previewPath: this.previewPath,
    };
  }

  /**
   * Update stream configuration (requires restart)
   */
  updateConfig(config) {
    this.streamConfig = { ...this.streamConfig, ...config };
    this.saveConfig(); // Save to file
    return { success: true, config: this.streamConfig };
  }

  /**
   * Kill any processes holding the camera device open, then poll until the
   * kernel confirms the device is free.
   *
   * Strategy:
   *   1. `fuser -k` sends SIGKILL to every process that has the device open.
   *      SIGKILL is immediate — no graceful-shutdown delay — which is what we
   *      need to avoid the "S_FMT busy" error that SIGTERM causes on Rockchip.
   *   2. Poll `fuser` every 300 ms (up to 3 s) to confirm the device is free
   *      before returning.  This replaces the old fixed 2-second sleep.
   */
  async _killCameraProcesses() {
    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    try {
      // SIGKILL every process that currently has the camera device open.
      // fuser -k sends SIGKILL by default; || true suppresses exit-code 1
      // when no processes are found.
      console.log(`🔪 Killing all processes using ${this.cameraDevice}...`);
      await execPromise(`sudo fuser -k ${this.cameraDevice} 2>/dev/null || true`);

      // Fallback: also kill any gst-launch / python3 (overlay script) processes
      // that reference THIS camera device but may not have it open yet (still starting).
      // IMPORTANT: grep for the specific device path so we never kill processes
      // belonging to a different camera controller instance.
      try {
        await execPromise(
          `ps aux | grep -E '(gst-launch|gst-overlay-pipeline|png-overlay-helper)' | grep '${this.cameraDevice}' | grep -v grep | awk '{print $2}' | xargs -r sudo kill -9 2>/dev/null || true`
        );
      } catch (_) { /* ignore */ }

      // Poll until fuser reports no PIDs using the device (max 3 s, 300 ms steps).
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        try {
          const { stdout } = await execPromise(
            `sudo fuser ${this.cameraDevice} 2>/dev/null || true`
          );
          // fuser prints nothing (or only the device name) when the device is free.
          const pids = stdout.replace(this.cameraDevice, "").trim();
          if (!pids || !/\d/.test(pids)) {
            console.log("✅ Camera device is free");
            return;
          }
          console.log(`⏳ Waiting for camera device to be released (still held by: ${pids})`);
        } catch (_) {
          break; // fuser not available — fall through to fixed wait
        }
      }

      // If we reach here the device is still busy; last-ditch SIGKILL + short wait.
      console.log("⚠️  Camera still busy after 3 s — forcing release");
      await execPromise(`sudo fuser -k ${this.cameraDevice} 2>/dev/null || true`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      console.log("✅ Camera resources cleaned up (forced)");
    } catch (error) {
      console.log("Error cleaning up camera processes:", error.message);
    }
  }

  /**
   * Kill any process using a specific port
   */
  async _killPortProcess(port) {
    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    try {
      let pids = [];

      // Method 1: Try lsof first
      try {
        const { stdout: lsofOut } = await execPromise(
          `lsof -ti:${port} 2>/dev/null || true`,
        );
        if (lsofOut.trim()) {
          pids = lsofOut
            .trim()
            .split("\n")
            .filter((p) => p && !isNaN(p));
          console.log(`lsof found PIDs using port ${port}:`, pids);
        }
      } catch (err) {
        console.log("lsof not available or failed");
      }

      // Method 2: Try fuser as fallback
      if (pids.length === 0) {
        try {
          const { stdout: fuserOut } = await execPromise(
            `fuser ${port}/tcp 2>/dev/null || true`,
          );
          if (fuserOut.trim()) {
            pids = fuserOut
              .trim()
              .split(/\s+/)
              .filter((p) => p && !isNaN(p));
            console.log(`fuser found PIDs using port ${port}:`, pids);
          }
        } catch (err) {
          console.log("fuser not available or failed");
        }
      }

      // Method 3: Try netstat/ss as last resort
      if (pids.length === 0) {
        try {
          const { stdout: netstatOut } = await execPromise(
            `netstat -tlnp 2>/dev/null | grep :${port} || ss -tlnp 2>/dev/null | grep :${port} || true`,
          );
          if (netstatOut.trim()) {
            console.log(`netstat/ss output:`, netstatOut);
            // Extract PID from output like "tcp 0 0 0.0.0.0:8554 0.0.0.0:* LISTEN 12345/gst-launch-1"
            const match = netstatOut.match(/(\d+)\//);
            if (match) {
              pids.push(match[1]);
              console.log(`netstat/ss found PID using port ${port}:`, pids);
            }
          }
        } catch (err) {
          console.log("netstat/ss not available or failed");
        }
      }

      // Kill all found PIDs
      if (pids.length > 0) {
        for (const pid of pids) {
          if (pid && !isNaN(pid)) {
            console.log(`Killing process ${pid} using port ${port}...`);
            try {
              process.kill(parseInt(pid), "SIGTERM");
              console.log(`Sent SIGTERM to ${pid}`);
            } catch (err) {
              console.log(`Could not send SIGTERM to ${pid}:`, err.message);
            }
          }
        }

        // Wait for graceful shutdown
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Force kill if still running
        for (const pid of pids) {
          if (pid && !isNaN(pid)) {
            try {
              process.kill(parseInt(pid), "SIGKILL");
              console.log(`Sent SIGKILL to ${pid}`);
            } catch (err) {
              // Process already dead, that's fine
              console.log(`Process ${pid} already terminated`);
            }
          }
        }

        // Wait a bit more for port to be released
        await new Promise((resolve) => setTimeout(resolve, 500));
      } else {
        console.log(`No process found using port ${port}`);
      }
    } catch (error) {
      console.log(`Error checking port ${port}:`, error.message);
    }
  }

  /**
   * Build PNG overlay pipeline with graphics overlay
   * Uses gdkpixbufoverlay to overlay a dynamically updated PNG file
   * This is MUCH simpler and more reliable than the compositor approach
   */
  _buildPNGOverlayPipeline() {
    const {
      destination,
      width,
      height,
      framerate,
      bitrate,
      overlayText,
    } = this.streamConfig;

    // Check whether a real graphics overlay (PNG) is actually needed.
    // When called purely for CLOCK_REALTIME (audio-enabled SRT/RTMP without
    // graphics), we pass an empty pngPath so gst-overlay-pipeline.py skips
    // the gdkpixbufoverlay element entirely while still applying CLOCK_REALTIME.
    const needsGraphicsOverlay = this.streamConfig.skiaGraphicsEnabled ||
      (this.streamConfig.remoteOverlayEnabled &&
        this.streamConfig.overlayUrl && this.streamConfig.overlayUrl.trim());

    if (needsGraphicsOverlay) {
      console.log("🎨 Graphics overlay enabled - using PNG overlay (gdkpixbufoverlay)");
    } else {
      console.log("🕒 Routing through Python pipeline to apply CLOCK_REALTIME (A/V sync fix)");
    }

    const protocol = this.streamConfig.protocol || "srt";

    // RTSP mode pushes to local MediaMTX via RTMP internally.
    // The shell/Python scripts only understand 'srt' and 'rtmp', so we translate
    // 'rtsp' → 'rtmp' with a fixed local destination before passing args through.
    const scriptProtocol = protocol === "rtsp" ? "rtmp" : protocol;

    // Build the full destination URL based on protocol
    let effectiveDestination = destination || "";
    if (protocol === "rtsp") {
      effectiveDestination = `rtmp://localhost:1935${this.rtspPath}`;
    } else if (!effectiveDestination) {
      if (protocol === "srt") {
        effectiveDestination = `srt://:${this.srtDefaultPort}`;
      } else if (protocol === "rtmp") {
        effectiveDestination = "rtmp://localhost:1935/stream";
      }
    }
    // Only pass the real PNG path when graphics overlay is active.
    // An empty string tells gst-overlay-pipeline.py to skip gdkpixbufoverlay.
    // Each camera writes to its own file so overlays don't overwrite each other.
    const pngPath = needsGraphicsOverlay ? this.pngOverlayPath : "";

    // Per-element formatting (fall back to legacy shared values)
    const titleFs = this.streamConfig.titleFontSize || this.streamConfig.overlayFontSize || 32;
    const titleColor = this._colorToInt(this.streamConfig.titleColor || this.streamConfig.overlayColor || "white");
    const titleBackground = this.streamConfig.titleBackground || this.streamConfig.overlayBackground || "transparent";
    const tsFs = this.streamConfig.timestampFontSize || Math.round((this.streamConfig.overlayFontSize || 32) * 0.75);
    const tsColor = this._colorToInt(this.streamConfig.timestampColor || this.streamConfig.overlayColor || "white");
    const tsBackground = this.streamConfig.timestampBackground || this.streamConfig.overlayBackground || "transparent";

    // Scale font sizes the same way the text-only pipeline does (1.5x for 1080p)
    const scaledTitleFontSize = Math.round(titleFs * 1.5);
    const scaledTsFontSize = Math.round(tsFs * 1.5);

    console.log(`🎨 PNG overlay formatting — Title: size=${titleFs}→${scaledTitleFontSize}, color=${titleColor}, bg=${titleBackground}`);
    console.log(`🎨 PNG overlay formatting — Timestamp: size=${tsFs}→${scaledTsFontSize}, color=${tsColor}, bg=${tsBackground}`);
    console.log(`🎨 Raw config values — titleFontSize=${this.streamConfig.titleFontSize}, timestampFontSize=${this.streamConfig.timestampFontSize}, overlayFontSize=${this.streamConfig.overlayFontSize}`);

    const timestampFormat = this.streamConfig.timestampFormat || "%Y-%m-%d %H:%M:%S";
    const titlePosition = this.streamConfig.titlePosition || "top-left";
    const timestampPosition = this.streamConfig.timestampPosition || "bottom-right";

    // Use the PNG overlay helper script
    const scriptPath = path.join(__dirname, 'png-overlay-helper.sh');

    // Only pass overlay text if the Title checkbox is enabled
    const effectiveOverlayText = this.streamConfig.overlayEnabled ? (overlayText || "") : "";
    // Only pass timestamp if the Timestamp checkbox is enabled
    const effectiveShowTimestamp = this.streamConfig.showTimestamp ? "true" : "false";

    // Resolve the audio device string passed to gst-overlay-pipeline.py:
    //
    //   audioSource === "external"  → always use the ALSA device string.
    //     The Python script detects a non-sentinel value and switches to the
    //     fdsink hybrid output so ffmpeg can mux the ALSA audio in.
    //
    //   audioSource === "video" + RTSP input  → sentinel "rtsp".
    //     gst-overlay-pipeline.py installs a pad-added handler on decodebin
    //     to tap the embedded RTSP audio track.
    //
    //   audioSource === "video" + NDI input   → sentinel "ndi".
    //     gst-overlay-pipeline.py wires the ndisrcdemux audio pad into an
    //     audiomixer → avenc_aac chain in the static pipeline string.
    //
    //   audioSource === "video" + USB input   → ALSA device (camera mic).
    const audioDevice = this.streamConfig.audioEnabled
      ? (this.streamConfig.audioSource === "external"
          ? (this.streamConfig.audioDevice || "plughw:2,0")
          : (this.inputSource.type === "rtsp"
              ? "rtsp"
              : this.inputSource.type === "ndi"
                ? "ndi"
                : (this.streamConfig.audioDevice || "plughw:2,0")))
      : "";

    // H.265 is incompatible with RTMP (FLV container only supports H.264)
    const scriptCodec = (this.streamConfig.codec === "h265" && scriptProtocol !== "rtmp") ? "h265" : "h264";

    const scriptArgs = [
      this.cameraDevice,
      width.toString(),
      height.toString(),
      framerate.toString(),
      bitrate.toString(),
      scriptProtocol,   // 'rtsp' translated to 'rtmp' for the shell/Python scripts
      effectiveDestination,
      pngPath,
      effectiveOverlayText,
      effectiveShowTimestamp,
      scaledTitleFontSize.toString(),
      titleColor.toString(),
      titleBackground,
      timestampFormat,
      titlePosition,
      timestampPosition,
      audioDevice,
      // Per-element timestamp formatting (new args)
      scaledTsFontSize.toString(),
      tsColor.toString(),
      tsBackground,
      scriptCodec,
      // Input source type, RTSP URL, and NDI source name (args 22-24)
      this.inputSource.type || "usb",
      this.inputSource.rtspUrl || "",
      this.inputSource.ndiName || "",   // arg 24 — empty for USB and RTSP sources
      // Video orientation (args 25-26)
      (this.streamConfig.flipHorizontal || false).toString(),  // arg 25
      (this.streamConfig.flipVertical   || false).toString(),  // arg 26
      // Camera capture format (arg 27) — 'mjpeg' or 'yuyv'
      this.captureFormat || "mjpeg",                           // arg 27
      // Preview RTMP path for MediaMTX (arg 28) — /preview or /preview2
      `rtmp://localhost:1935${this.previewPath}`,              // arg 28
      // Active encoder (arg 29) — e.g. mpph264enc, vaapih264enc, x264enc
      // Lets gst-overlay-pipeline.py select the right encoder and JPEG decoder
      this.streamConfig.encoder || "mpph264enc",              // arg 29
    ];

    return {
      useCompositorScript: true,
      scriptPath: scriptPath,
      scriptArgs: scriptArgs,
    };
  }

  /**
   * Build GStreamer pipeline based on configuration
   */
  _buildGStreamerPipeline() {
    const {
      protocol,
      destination,
      width,
      height,
      framerate,
      bitrate,
      encoder,
    } = this.streamConfig;

    // H.265 is incompatible with RTMP (FLV container only supports H.264)
    const codec = (this.streamConfig.codec === "h265" && protocol !== "rtmp") ? "h265" : "h264";

    // Check if graphics overlay is needed:
    // - Legacy: skiaGraphicsEnabled checkbox (being removed from UI)
    // - New: Remote overlay checkbox with a URL set
    const needsGraphicsOverlay = this.streamConfig.skiaGraphicsEnabled ||
      (this.streamConfig.remoteOverlayEnabled &&
        this.streamConfig.overlayUrl && this.streamConfig.overlayUrl.trim());

    // Route through the Python GStreamer script when:
    //   1. Graphics overlay is needed (gdkpixbufoverlay), OR
    //   2. Audio is enabled on SRT/RTMP — the Python script forces the pipeline
    //      clock to CLOCK_REALTIME, which matches the time base used by ffmpeg's
    //      -use_wallclock_as_timestamps flag on the ALSA audio input. Without
    //      this, GStreamer defaults to CLOCK_MONOTONIC (raw hardware oscillator),
    //      which drifts ~764 µs/s relative to CLOCK_REALTIME — accumulating
    //      ~22 seconds of A/V offset after 8 hours.
    const needsPythonForClock =
      (protocol === "srt" || protocol === "rtmp" || protocol === "rtsp") &&
      this.streamConfig.audioEnabled;

    if (needsGraphicsOverlay || needsPythonForClock) {
      return this._buildPNGOverlayPipeline();
    }

    let pipeline;
    if (this.inputSource.type === "ndi" && this.inputSource.ndiName) {
      // NDI source: ndisrc outputs application/x-ndi; ndisrcdemux splits it into
      // separate "video" (video/x-raw) and "audio" (audio/x-raw) dynamic pads.
      pipeline = [
        "ndisrc",
        `ndi-name="${this.inputSource.ndiName}"`,
        "connect-timeout=5000",
        "!", "ndisrcdemux", "name=ndi_demux",
        "ndi_demux.video",
        "!",
        "queue", "max-size-buffers=3", "max-size-time=0", "max-size-bytes=0", "leaky=downstream",
        "!",
        "videoconvert",
        "!",
        "videoscale",
        "!",
        `video/x-raw,width=${width},height=${height}`,
        "!",
        "videorate",
        "!",
        `video/x-raw,framerate=${framerate}/1`,
        "!",
      ];
    } else if (this.inputSource.type === "rtsp" && this.inputSource.rtspUrl) {
      // RTSP source: decode the incoming stream, normalise resolution/rate, then
      // re-encode with overlays.  videoconvert is required immediately after
      // decodebin because decodebin emits dynamic caps (NV12, I420, BGRx, etc.)
      // that downstream fixed-caps elements (videoscale caps filter, videorate)
      // cannot negotiate without an explicit conversion step.
      pipeline = [
        "rtspsrc", `location=${this.inputSource.rtspUrl}`, "latency=200", "protocols=tcp",
        "!", "decodebin",
        "!", "videoconvert",
        "!", "videoscale",
        "!", `video/x-raw,width=${width},height=${height}`,
        "!", "videorate",
        "!", `video/x-raw,framerate=${framerate}/1`,
        "!",
      ];
    } else if (this.captureFormat === 'yuyv') {
      // YUYV-only cameras (e.g. Minrray/Cypress): no MJPEG support.
      // Omit format=YUYV from caps — Rockchip's RGA-backed videoconvert doesn't
      // list YUYV in its static sink pad template, causing a parse-time link
      // failure when format=YUYV is explicitly constrained.  Without it,
      // GStreamer negotiates YUYV at runtime and videoconvert outputs NV12.
      pipeline = [
        "v4l2src",
        `device=${this.cameraDevice}`,
        "do-timestamp=true",
        "!",
        `video/x-raw,width=${width},height=${height},framerate=${framerate}/1`,
        "!",
        "videoconvert",
        "!",
        "video/x-raw,format=NV12",
        "!",
        "videorate",
        "!",
        `video/x-raw,framerate=${framerate}/1`,
        "!",
      ];
    } else {
      // jpegparse is required before mppjpegdec (Rockchip hardware decoder needs parsed
      // frames), but omitted for software jpegdec — jpegparse is too strict and rejects
      // JPEG streams with minor header quirks (e.g. "Duplicated or bad SOF marker") that
      // jpegdec handles gracefully on its own.
      const _jpegDec = this._getJpegDecoder(encoder);
      const _jpegParseElems = _jpegDec === "mppjpegdec" ? ["jpegparse", "!"] : [];
      pipeline = [
        // USB camera: MJPEG capture → hardware or software JPEG decode → rate control
        // Decoder is chosen by _getJpegDecoder(): mppjpegdec on Rockchip, jpegdec elsewhere.
        "v4l2src",
        `device=${this.cameraDevice}`,
        "do-timestamp=true",
        "!",
        `image/jpeg,width=${width},height=${height},framerate=${framerate}/1`,
        "!",
        ..._jpegParseElems,
        _jpegDec,
        "!",
        "videorate",
        "!",
        `video/x-raw,framerate=${framerate}/1`,
        "!",
      ];
    }

    // Insert videoflip before overlays so text stays right-side-up.
    // Methods: 0=none, 2=rotate-180 (H+V), 4=horizontal-flip, 5=vertical-flip
    const flipH = this.streamConfig.flipHorizontal || false;
    const flipV = this.streamConfig.flipVertical   || false;
    let flipMethod = 0;
    if (flipH && flipV) flipMethod = 2;
    else if (flipH)     flipMethod = 4;
    else if (flipV)     flipMethod = 5;
    if (flipMethod !== 0) {
      pipeline.push("videoflip", `method=${flipMethod}`, "!");
    }

    // Add overlays if any individual overlay is enabled
    const hasAnyOverlay = this.streamConfig.overlayEnabled || this.streamConfig.showTimestamp;
    if (hasAnyOverlay) {
      // Convert to format suitable for textoverlay
      pipeline.push("videoconvert", "!");

      // Add timestamp overlay if enabled (per-element formatting)
      if (this.streamConfig.showTimestamp) {
        const tsPosition =
          this.streamConfig.timestampPosition || "bottom-right";
        const [vpos, hpos] = tsPosition.split("-");
        const valign =
          vpos === "bottom" ? "bottom" : vpos === "center" ? "center" : "top";
        const halign =
          hpos === "left" ? "left" : hpos === "right" ? "right" : "center";

        // Per-element font size (fall back to legacy shared value)
        const tsFs = this.streamConfig.timestampFontSize || Math.round((this.streamConfig.overlayFontSize || 32) * 0.75);
        const scaledFontSize = Math.round(tsFs * 1.5);
        const tsColor = this.streamConfig.timestampColor || this.streamConfig.overlayColor || "white";
        const tsBg = this.streamConfig.timestampBackground || this.streamConfig.overlayBackground || "transparent";
        console.log(`🎨 Text-only pipeline — Timestamp: size=${tsFs}→${scaledFontSize}, color=${tsColor}, bg=${tsBg}`);

        const timestampArgs = [
          "clockoverlay",
          `valignment=${valign}`,
          `halignment=${halign}`,
          `font-desc=Sans Bold ${scaledFontSize}`,
          `color=${this._colorToInt(tsColor)}`,
          `time-format="${this.streamConfig.timestampFormat || '%Y-%m-%d %H:%M:%S'}"`,
        ];

        if (tsBg !== "transparent") {
          timestampArgs.push("shaded-background=true");
        }

        timestampArgs.push("xpad=20", "ypad=20", "!");
        pipeline.push(...timestampArgs);
      }

      // Add custom text overlay 1 (main title) - only if Title checkbox is enabled
      if (this.streamConfig.overlayEnabled && (this.streamConfig.overlayText || this.streamConfig.customText1)) {
        const text =
          this.streamConfig.overlayText || this.streamConfig.customText1;

        const position =
          this.streamConfig.titlePosition ||
          this.streamConfig.overlayPosition ||
          "bottom-left";
        const [vpos, hpos] = position.split("-");
        const valign =
          vpos === "bottom" ? "bottom" : vpos === "center" ? "center" : "top";
        const halign =
          hpos === "left" ? "left" : hpos === "right" ? "right" : "center";

        // Per-element font size (fall back to legacy shared value)
        const titleFs = this.streamConfig.titleFontSize || this.streamConfig.overlayFontSize || 32;
        const scaledFontSize = Math.round(titleFs * 1.5);
        const titleClr = this.streamConfig.titleColor || this.streamConfig.overlayColor || "white";
        const titleBg = this.streamConfig.titleBackground || this.streamConfig.overlayBackground || "transparent";

        const textArgs = [
          "textoverlay",
          `text="${text}"`,
          `valignment=${valign}`,
          `halignment=${halign}`,
          `font-desc=Sans Bold ${scaledFontSize}`,
          `color=${this._colorToInt(titleClr)}`,
        ];

        if (titleBg !== "transparent") {
          textArgs.push("shaded-background=true");
        }

        textArgs.push("xpad=20", "ypad=20", "!");
        pipeline.push(...textArgs);
      }

      // Add custom text overlay 2 (subtitle/secondary text)
      if (this.streamConfig.customText2) {
        const valign =
          this.streamConfig.overlayPosition === "bottom" ? "bottom" : "center";
        pipeline.push(
          "textoverlay",
          `text="${this.streamConfig.customText2}"`,
          `valignment=${valign}`,
          "halignment=center",
          `font-desc=Sans ${Math.floor(this.streamConfig.overlayFontSize * 0.75)}`,
          `color=${this._colorToInt(this.streamConfig.overlayColor)}`,
          "shaded-background=true",
          "!",
        );
      }

      // Add logo overlay if path provided
      if (this.streamConfig.logoPath) {
        // Note: gdkpixbufoverlay requires the image file to exist
        pipeline.push(
          "gdkpixbufoverlay",
          `location=${this.streamConfig.logoPath}`,
          "offset-x=20",
          "offset-y=20",
          "!",
        );
      }
    }

    // Graphics overlay compositing is disabled for now
    // The compositor requires a complex multi-source pipeline that doesn't work
    // well with our linear pipeline building approach
    //
    // TODO: Implement proper compositor using gst-launch-1.0 with multiple sources

    // For now, just use the normal pipeline
    // When using MPP hardware path without overlays, mppjpegdec outputs NV12 directly
    // so we can skip videoconvert before the tee to save CPU
    // Both mpph264enc and mpph265enc receive NV12 from mppjpegdec directly
    if ((encoder === "mpph264enc" || codec === "h265") && !hasAnyOverlay) {
      pipeline.push("video/x-raw,format=NV12", "!", "tee", "name=t");
    } else {
      pipeline.push("videoconvert", "!", "tee", "name=t");
    }

    // Branch 1: Encoding pipeline for streaming
    // IMPORTANT: must be limited + leaky. Default queue (200 buf / 10 MB, non-leaky) blocks the
    // entire capture chain when the encoder is momentarily slow (e.g. thermal throttle), which
    // causes kernel V4L2 buffer overflows and frame drops at the driver level.
    pipeline.push(
      "t.", "!",
      "queue",
      "max-size-buffers=2",   // Only 2 raw NV12 frames — encoder must keep up
      "max-size-time=0",      // Disable time limit (use buffer count only)
      "max-size-bytes=0",     // Disable byte limit (use buffer count only)
      "leaky=downstream",     // Drop oldest raw frame on overflow rather than blocking capture
      "!",
    );

    // Encoding pipeline
    if (codec === "h265") {
      // H.265 (HEVC) — incompatible with RTMP (FLV only supports H.264);
      // only reached for SRT / RTSP.  Encoder chosen by hardware family.
      if (encoder === "vaapih264enc") {
        // Intel VA-API H.265 encoder
        const bitrate_kbps = Math.round(bitrate / 1000);
        pipeline.push(
          "videoconvert",
          "!",
          "vaapih265enc",
          `bitrate=${bitrate_kbps}`,
          "rate-control=vbr",
          "keyframe-period=5",  // Keyframe every ~167ms at 30fps
          "!",
          "video/x-h265,stream-format=byte-stream",
          "!",
          "h265parse",
          "config-interval=-1",
          "!",
        );
      } else {
        // Rockchip MPP H.265 hardware encoder (Orange Pi 5 / RK3588)
        if (hasAnyOverlay) {
          pipeline.push("videoconvert", "!", "video/x-raw,format=NV12", "!");
        }
        pipeline.push(
          "mpph265enc",
          `bps=${bitrate}`,
          `bps-max=${Math.round(bitrate * 1.6)}`,
          "rc-mode=vbr",
          "gop=5",                // Keyframe every ~167ms at 30fps, ~83ms at 60fps
          "header-mode=each-idr", // VPS/SPS/PPS prepended to every IDR in the bitstream
          "!",
          "video/x-h265,stream-format=byte-stream",
          "!",
          "h265parse",
          "config-interval=-1",   // Inline parameter sets; RTMP not supported with H.265
          "!",
        );
      }
    } else if (encoder === "vaapih264enc") {
      // Intel VA-API H.264 hardware encoder (N97, other x86 with Intel iGPU)
      // vaapih264enc accepts most raw formats via VA-API; videoconvert normalises.
      // bitrate is in kbps (not bps like mpph264enc).
      const bitrate_kbps = Math.round(bitrate / 1000);
      pipeline.push(
        "videoconvert",
        "!",
        "vaapih264enc",
        `bitrate=${bitrate_kbps}`,
        "rate-control=vbr",
        "keyframe-period=5",    // Keyframe every ~167ms at 30fps
        "!",
        "video/x-h264,stream-format=byte-stream",
        "!",
        "h264parse",
        `config-interval=${protocol === "rtmp" && this.streamConfig.audioEnabled ? "0" : "-1"}`,
        "!",
      );
    } else if (encoder === "mpph264enc") {
      // Rockchip MPP H.264 hardware encoder (Orange Pi 5 / RK3588)
      // When no overlay, NV12 comes directly from mppjpegdec — no videoconvert needed
      if (hasAnyOverlay) {
        pipeline.push("videoconvert", "!", "video/x-raw,format=NV12", "!");
      }
      pipeline.push(
        "mpph264enc",
        `bps=${bitrate}`,
        // Allow bursts up to 1.6x target for motion headroom. Pure CBR (bps-max=bps) forces
        // the encoder to raise quantizer on high-motion frames (fast pool shots) causing
        // pixelation. SRT latency=500ms absorbs short bursts; average stays at target bps.
        `bps-max=${Math.round(bitrate * 1.6)}`,
        "rc-mode=vbr",          // VBR with bps-max cap = constrained VBR — best quality/stability tradeoff
        "gop=5",                // Keyframe every ~167ms — fast recovery from any dropped frame
        "header-mode=each-idr", // SPS/PPS prepended to every IDR in the bitstream
        "profile=baseline", // No B-frames — required for RTMP/FLV and better for low-latency
        "!",
        "video/x-h264,stream-format=byte-stream",
        "!",
        "h264parse",
        // RTMP+audio hybrid: config-interval=0 — SPS/PPS go only into the MPEG-TS PMT.
        // ffmpeg reads them once from the PMT and emits ONE AVC sequence header in the FLV.
        // With config-interval=-1 ffmpeg sees inline SPS/PPS before EVERY IDR and emits a
        // new sequence header + IDR NALU with the same DTS → MediaMTX drops the connection.
        // All other paths use -1 so OBS/players can resync after packet loss.
        `config-interval=${protocol === "rtmp" && this.streamConfig.audioEnabled ? "0" : "-1"}`,
        "!",
      );
    } else if (encoder === "x264enc") {
      // Software encoder (fallback)
      const bitrate_kbps = Math.round(bitrate / 1000);
      pipeline.push(
        "videoconvert",
        "!",
        "video/x-raw,format=I420",
        "!",
        "x264enc",
        `speed-preset=ultrafast`,
        `tune=zerolatency`,
        `bitrate=${bitrate_kbps}`,
        "key-int-max=30",
        "threads=0",
        "sliced-threads=true",
        "!",
        "video/x-h264,stream-format=byte-stream",
        "!",
        "h264parse",
        `config-interval=${protocol === "rtmp" && this.streamConfig.audioEnabled ? "0" : "-1"}`,
        "!",
      );
    } else if (encoder === "nvv4l2h264enc") {
      // NVIDIA V4L2 encoder (Jetson)
      pipeline.push(
        "nvvidconv",
        "!",
        "video/x-raw(memory:NVMM)",
        "!",
        "nvv4l2h264enc",
        `bitrate=${bitrate}`,
        "preset-level=1",
        "profile=0",
        "iframeinterval=15",
        "insert-sps-pps=true",
        "maxperf-enable=true",
        "!",
        "video/x-h264,stream-format=byte-stream",
        "!",
        "h264parse",
        `config-interval=${protocol === "rtmp" && this.streamConfig.audioEnabled ? "0" : "-1"}`,
        "!",
      );
    } else if (encoder === "omxh264videoenc") {
      // Allwinner OpenMAX H.264 hardware encoder (Radxa Cubie A7S / A733)
      pipeline.push(
        "videoconvert",
        "!",
        "video/x-raw,format=NV12",
        "!",
        "omxh264videoenc",
        `target-bitrate=${bitrate}`,
        "control-rate=constant",
        "interval-intraframes=5",   // Keyframe every ~167ms at 30fps
        "!",
        "h264parse",
        `config-interval=${protocol === "rtmp" && this.streamConfig.audioEnabled ? "0" : "-1"}`,
        "!",
      );
    }

    // Add another tee after encoding to split H.264 for output and preview
    pipeline.push("tee", "name=t2");

    // Branch 2a: Output stream (SRT or RTMP) - from t2 (H.264)
    if (protocol === "srt") {
      // SRT streaming - low latency with error correction
      // Use srtsink as listener - device acts as server, OBS connects as client
      // Port 8891 (8890 is used by MediaMTX)

      console.log(
        `📡 SRT server mode - OBS should connect to: srt://${this._getLocalIP()}:${this.srtDefaultPort}`,
      );

      pipeline.push(
        "t2.",
        "!",
        "queue",
        "max-size-buffers=0", // Use time-based buffering
        "max-size-time=500000000", // 500 ms buffer — enough to absorb encoding spikes without adding latency
        "max-size-bytes=0",
        "leaky=downstream", // Drop old frames if queue is full
        "!",
        "mpegtsmux",
        "name=mux",
        "alignment=7", // Align packets for better compatibility
        "!",
      );

      if (this.streamConfig.audioEnabled) {
        // Hybrid mode: GStreamer outputs VIDEO-ONLY MPEG-TS to stdout.
        // ffmpeg captures audio from ALSA and muxes it with the incoming video,
        // then forwards everything to the SRT listener.
        //
        // Why video-only in the GStreamer mux:
        // mpegtsmux is a SYNCHRONIZING muxer. When audio is one of its inputs,
        // even a brief USB mic stall (ALSA underrun, USB clock drift) causes it
        // to freeze video output while waiting for the next audio timestamp to
        // align — producing pixelation. With a single video-only input, mpegtsmux
        // never has to wait for anything and video flows without interruption.
        //
        // A/V sync is maintained by:
        //   1. Deferred ffmpeg spawn: ALSA starts the instant GStreamer's first
        //      video chunk arrives, so both streams begin at ~t=0.
        //   2. aresample=async=1000: ffmpeg continuously resamples audio to
        //      match video timestamps, correcting USB clock drift on an ongoing
        //      basis without any accumulated offset.
        console.log(`🎤 Audio via ffmpeg ALSA (hybrid mode — video-only GStreamer mux)`);

        pipeline.push(
          "fdsink",
          "fd=1",      // stdout — video-only MPEG-TS piped to ffmpeg by Node.js
          "sync=false",
          "async=false",
        );
      } else {
        // No audio — GStreamer handles SRT directly (known stable path)
        pipeline.push(
          "srtsink",
          `uri=srt://:${this.srtDefaultPort}`,
          "wait-for-connection=false",
          "latency=500",
          "sync=false",
          "async=false",
        );
      }
    } else if (protocol === "rtmp" || protocol === "rtsp") {
      // RTSP mode: always push to local MediaMTX, which serves the stream as RTSP.
      // RTMP mode: push to the configured destination (or local MediaMTX as fallback).
      const rtmpUrl =
        protocol === "rtsp"
          ? `rtmp://localhost:1935${this.rtspPath}`
          : (destination && destination.trim() !== ""
              ? destination
              : "rtmp://localhost:1935/stream");

      if (protocol === "rtsp") {
        console.log(`📡 RTSP server mode — MediaMTX serving: rtsp://${this._getLocalIP()}:8554${this.rtspPath}`);
        console.log(`   Also available as HLS: http://${this._getLocalIP()}:8888${this.rtspPath}`);
      } else {
        console.log(`📡 RTMP destination: ${rtmpUrl}`);
      }

      if (this.streamConfig.audioEnabled) {
        // ── RTMP hybrid mode ──────────────────────────────────────────────────
        // GStreamer outputs VIDEO-ONLY MPEG-TS to stdout (fdsink fd=1).
        // ffmpeg (spawned by Node.js) captures ALSA audio and muxes it with the
        // video before pushing the FLV stream to the RTMP server.
        //
        // This is identical in principle to the SRT hybrid path and fixes the
        // exact same root cause: the USB mic oscillator runs ~0.12% faster than
        // the system clock. In GStreamer's flvmux path that drift accumulates
        // over hours (causing the 1-hour delay). ffmpeg's wall-clock timestamps
        // on both inputs anchors them to the same reference so no accumulation
        // is possible, and aresample=async=1000 corrects residual jitter.
        console.log(`🎤 Audio via ffmpeg ALSA (${protocol.toUpperCase()} hybrid mode — video-only GStreamer mux)`);

        pipeline.push(
          "t2.", "!",
          "queue",
          "max-size-buffers=0",
          "max-size-time=500000000", // 500 ms — matches SRT hybrid; mpegtsmux is video-only so leaky is safe
          "max-size-bytes=0",
          "leaky=downstream",        // leaky is fine with a single-stream mux (no A/V wait)
          "!",
          "mpegtsmux",
          "name=mux",
          "alignment=7",             // Align TS packets for clean handoff to ffmpeg
          "!",
          "fdsink",
          "fd=1",                    // stdout — video-only MPEG-TS piped to ffmpeg by Node.js
          "sync=false",
          "async=false",
        );
        // No GStreamer audio branch — ffmpeg handles ALSA capture and muxing
      } else {
        // ── RTMP no-audio mode ────────────────────────────────────────────────
        // No USB clock drift to worry about (no audio clock). GStreamer handles
        // RTMP directly via flvmux. Note: do NOT add a second h264parse here —
        // the upstream h264parse config-interval=-1 negotiates stream-format=avc,
        // alignment=au directly with flvmux through the queue. A second parse
        // re-splits SPS+PPS+IDR into buffers with identical DTS values, causing
        // MediaMTX to drop readers with "DTS not monotonically increasing".
        pipeline.push(
          "t2.", "!",
          "queue",
          "max-size-buffers=0",
          "max-size-time=2000000000", // 2 s — absorbs encoding spikes without audio latency concern
          "max-size-bytes=0",
          // No leaky — dropping encoded H264 frames causes DTS duplicates/gaps in flvmux
          "!",
          "video/x-h264,stream-format=avc,alignment=au",
          "!",
          "flvmux",
          "name=mux",
          "streamable=true",
          "!",
          "rtmpsink",
          `location=${rtmpUrl}`,
          "sync=false",
        );
      }
    } else {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }

    // Branch 2b: Preview stream — H.264 push to MediaMTX for WebRTC admin preview.
    // Taps raw video (before H.264 encoding) from tee t, scales to 720p/15fps with the
    // hardware MPP encoder, and pushes to rtmp://localhost:1935/preview.
    // MediaMTX serves WebRTC via WHEP at http://localhost:8889/preview — the Node.js
    // server proxies it at /api/whep/preview so the admin browser fetches it over port 3000.
    pipeline.push(
      "t.",
      "!",
      "queue",
      "max-size-buffers=10",
      "leaky=downstream",
      "!",
      "videoscale",
      "!",
      "video/x-raw,width=1280,height=720",
      "!",
      "videorate",
      "!",
      "video/x-raw,framerate=15/1",
      "!",
      // Preview encoder — matches the main encoder family so all hardware paths work.
      // Rockchip: mpph264enc (requires NV12 input)
      // Intel VA-API: vaapih264enc (accepts any raw format; bitrate in kbps)
      // Software / other: x264enc
      ...(encoder === "vaapih264enc"
        ? [
            "videoconvert", "!",
            "vaapih264enc", "bitrate=500", "keyframe-period=15", "!",
          ]
        : encoder === "omxh264videoenc"
        ? [
            "videoconvert", "!", "video/x-raw,format=NV12", "!",
            "omxh264videoenc", "target-bitrate=500000", "control-rate=constant", "interval-intraframes=15", "!",
          ]
        : encoder === "x264enc"
        ? [
            "videoconvert", "!", "video/x-raw,format=I420", "!",
            "x264enc", "bitrate=500", "speed-preset=ultrafast", "tune=zerolatency", "key-int-max=15", "!",
          ]
        : [
            // Default: Rockchip mpph264enc (also used as preview encoder for nvv4l2h264enc fallback)
            "videoconvert", "!", "video/x-raw,format=NV12", "!",
            "mpph264enc", "bps=500000", "header-mode=each-idr", "gop=15", "!",
          ]
      ),
      "h264parse",
      "config-interval=-1",
      "!",
      "video/x-h264,stream-format=avc,alignment=au",
      "!",
      "queue",
      "max-size-buffers=0",
      "max-size-time=500000000",
      "max-size-bytes=0",
      "leaky=downstream",
      "!",
      "flvmux",
      "streamable=true",
      "!",
      "rtmpsink",
      `location=rtmp://localhost:1935${this.previewPath}`,
      "sync=false",
      "async=false",  // must not participate in preroll — the preview branch must never block PLAYING
    );

    // TODO: Compositor integration will be added in a future update
    // For now, graphics overlay is disabled in the pipeline

    return pipeline;
  }

  /**
   * Convert color name to GStreamer integer format
   * GStreamer uses 0xAARRGGBB format
   */
  _colorToInt(colorName) {
    const colors = {
      white: "0xFFFFFFFF",
      black: "0xFF000000",
      red: "0xFFFF0000",
      green: "0xFF00FF00",
      blue: "0xFF0000FF",
      yellow: "0xFFFFFF00",
      cyan: "0xFF00FFFF",
      magenta: "0xFFFF00FF",
    };
    return colors[colorName.toLowerCase()] || colors.white;
  }

  /**
   * Start polling v4l2-ctl for the actual negotiated camera frame rate and
   * emitting "fps" events so callers can forward them to connected clients.
   * Safe to call while GStreamer holds the V4L2 device open (VIDIOC_G_PARM
   * is a read-only ioctl that does not interfere with streaming).
   */
  _startFpsMonitoring() {
    this._stopFpsMonitoring(); // clear any leftover interval first

    // Emit configured framerate immediately so the UI is never blank
    const configuredFps = this.streamConfig.framerate || 30;
    this.emit("fps", configuredFps);

    // Query v4l2 once — the negotiated FPS is fixed for the lifetime of the
    // stream and only changes if the user swaps the input source and restarts.
    // Polling repeatedly just floods journalctl with sudo/PAM session entries.
    (async () => {
      try {
        const { stdout } = await execAsync(
          `v4l2-ctl -d ${this.cameraDevice} --get-parm`
        );
        // Example line: "  Frames per second: 30.000 (30/1)"
        const m = stdout.match(/Frames per second:\s+[\d.]+\s+\((\d+)\/(\d+)\)/);
        if (m) {
          const fps = Math.round(parseInt(m[1], 10) / parseInt(m[2], 10));
          this.emit("fps", fps);
        }
        // If no match, the initial configuredFps emit above already covers the UI.
      } catch (_) {
        // Device busy or v4l2-ctl unavailable — configured value is already shown.
      }
    })();
  }

  _stopFpsMonitoring() {
    if (this._fpsInterval) {
      clearInterval(this._fpsInterval);
      this._fpsInterval = null;
    }
    this.emit("fps", null); // signal "no data" to clients
  }

  /**
   * Monitor the encoded stream bitrate by polling the MediaMTX Control API.
   * Endpoint: GET http://127.0.0.1:9997/v3/paths/get/live
   *
   * `bytesReceived` = cumulative bytes GStreamer has pushed into MediaMTX on the
   * "live" path.  Computing the delta each second gives the exact encoded bitrate
   * — completely independent of the MJPEG preview, the admin web UI, or how many
   * RTSP viewers are currently connected.
   *
   * Falls back to null (shows "—" in the UI) when MediaMTX is not running or the
   * path is not yet active (e.g. stream just started and GStreamer hasn't published
   * its first bytes yet).
   *
   * Requires the MediaMTX API to be enabled in /etc/mediamtx.yml:
   *   api: yes   # default in MediaMTX v1.x — already on unless explicitly disabled
   */
  _startBitrateMonitoring() {
    this._stopBitrateMonitoring();
    const http = require("http");
    let prevBytes = null;
    let prevTime  = null;

    const poll = () => {
      const req = http.get(
        { hostname: "127.0.0.1", port: 9997, path: "/v3/paths/get/live", timeout: 2000 },
        (res) => {
          let body = "";
          res.on("data", (d) => { body += d; });
          res.on("end", () => {
            try {
              const data = JSON.parse(body);
              // bytesSent = total bytes MediaMTX has delivered to ALL readers combined.
              // This scales with the number of connected viewers, which is what the
              // "Total Out" graph should reflect.  bytesReceived (encode rate) would
              // stay flat regardless of viewer count.
              const bytes = typeof data.bytesSent === "number" ? data.bytesSent : null;
              if (bytes === null) return;
              const now = Date.now();
              if (prevBytes !== null && bytes >= prevBytes) {
                const elapsed = (now - prevTime) / 1000;
                const mbps = (bytes - prevBytes) * 8 / elapsed / 1_000_000;
                this.emit("bitrate", parseFloat(mbps.toFixed(2)));
              }
              prevBytes = bytes;
              prevTime  = now;
            } catch (_) {
              // JSON parse error — skip tick
            }
          });
        }
      );
      req.on("error",   () => {}); // ECONNREFUSED etc. — MediaMTX not running
      req.on("timeout", () => req.destroy());
    };

    poll(); // first tick: primes prevBytes/prevTime, no emit yet
    this._bitrateInterval = setInterval(poll, 1000);
  }

  _stopBitrateMonitoring() {
    if (this._bitrateInterval) {
      clearInterval(this._bitrateInterval);
      this._bitrateInterval = null;
    }
    this.emit("bitrate", null);
  }

  /**
   * Get local IP address for display purposes
   */
  _getLocalIP() {
    const os = require("os");
    const interfaces = os.networkInterfaces();

    // Find first non-internal IPv4 address
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) {
          return iface.address;
        }
      }
    }
    return "localhost";
  }

  /**
   * Update overlay text dynamically (requires stream restart)
   */
  updateOverlay(overlayConfig) {
    this.streamConfig = { ...this.streamConfig, ...overlayConfig };
    this.saveConfig(); // Save to file
    return {
      success: true,
      message: "Overlay updated and saved. Restart stream to apply changes.",
      config: this.streamConfig,
    };
  }

  /**
   * Test if GStreamer and required plugins are available
   */
  static async testGStreamer() {
    return new Promise((resolve) => {
      // Try mpph264enc first (Rockchip MPP hardware encoder, Orange Pi 5 / RK3588)
      const test = spawn("gst-inspect-1.0", ["mpph264enc"]);
      test.on("close", (code) => {
        if (code === 0) {
          resolve({
            success: true,
            encoder: "mpph264enc",
            message: "Rockchip MPP hardware encoder available",
          });
        } else {
          // Try vaapih264enc (Intel VA-API hardware encoder — N97, other x86 iGPU)
          const testVaapi = spawn("gst-inspect-1.0", ["vaapih264enc"]);
          testVaapi.on("close", (vaapiCode) => {
            if (vaapiCode === 0) {
              resolve({
                success: true,
                encoder: "vaapih264enc",
                message: "Intel VA-API hardware encoder available",
              });
            } else {
              // Try nvv4l2h264enc (Jetson)
              const testNv = spawn("gst-inspect-1.0", ["nvv4l2h264enc"]);
              testNv.on("close", (nvCode) => {
                if (nvCode === 0) {
                  resolve({
                    success: true,
                    encoder: "nvv4l2h264enc",
                    message: "NVIDIA hardware encoder available",
                  });
                } else {
                  // Try omxh264videoenc (Allwinner OpenMAX — Radxa Cubie A7S / A733)
                  const testOmx = spawn("gst-inspect-1.0", ["omxh264videoenc"]);
                  testOmx.on("close", (omxCode) => {
                    if (omxCode === 0) {
                      resolve({
                        success: true,
                        encoder: "omxh264videoenc",
                        message: "Allwinner OpenMAX hardware encoder available",
                      });
                    } else {
                      // Try x264enc (software fallback)
                      const testX264 = spawn("gst-inspect-1.0", ["x264enc"]);
                      testX264.on("close", (x264Code) => {
                        if (x264Code === 0) {
                          resolve({
                            success: true,
                            encoder: "x264enc",
                            message: "x264 software encoder available",
                          });
                        } else {
                          resolve({
                            success: false,
                            error: "No encoder found (tried mpph264enc, vaapih264enc, nvv4l2h264enc, omxh264videoenc, x264enc)",
                          });
                        }
                      });
                    }
                  });
                }
              });
            }
          });
        }
      });
    });
  }
}

module.exports = StreamController;
