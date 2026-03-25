const { spawn } = require("child_process");
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");

class StreamController extends EventEmitter {
  constructor(cameraDevice = "/dev/video0") {
    super();
    this.cameraDevice = cameraDevice;
    this.gstProcess = null;
    this.ffmpegProcess = null; // Separate ffmpeg process for SRT+audio hybrid
    this.isStreaming = false;
    this.configFile = path.join(__dirname, "stream-config.json");

    // Default configuration
    const defaultConfig = {
      protocol: "srt", // 'srt' or 'rtmp'
      destination: "",
      width: 1920,
      height: 1080,
      framerate: 30,
      bitrate: 5000000, // 5 Mbps
      encoder: "mpph264enc", // Rockchip MPP hardware encoder (Orange Pi 5 / RK3588)
      autoStart: false, // Auto-start streaming on server startup
      // Overlay settings
      overlayEnabled: false,
      overlayType: "text", // 'text' or 'url'
      overlayText: "",
      showTimestamp: false,
      overlayUrl: "",
      overlayZoom: 100, // Zoom level for remote overlay page (50-200%)
      remoteOverlayEnabled: false, // Enable remote overlay (Puppeteer screenshot)
      timestampPosition: "bottom-right",
      titlePosition: "top-left",
      overlayFontSize: 32, // Default font size for overlays
      overlayColor: "white",
      overlayBackground: "transparent",
      overlayBackgroundOpacity: 70,
      // Per-element formatting
      titleFontSize: 32,
      titleColor: "white",
      titleBackground: "transparent",
      timestampFontSize: 24,
      timestampColor: "white",
      timestampBackground: "transparent",
      // Legacy fields
      timestampFormat: "%Y-%m-%d %H:%M:%S",
      logoPath: "", // Path to logo image overlay
      // Audio settings
      audioEnabled: true, // Include audio from camera mic in stream
      audioDevice: "hw:3,0", // ALSA device for camera microphone
      // Skia graphics overlay
      skiaGraphicsEnabled: false, // Enable Skia graphics overlay
      skiaGraphicsPort: 8556, // Port where Skia graphics server is running
      skiaGraphicsAlpha: 1.0, // Opacity of graphics overlay (0.0-1.0)
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
   * Initialize and auto-start if configured
   */
  async initialize() {
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
   * Start streaming with current configuration
   */
  async startStream(config = {}) {
    if (this.isStreaming) {
      return { success: false, error: "Stream already running" };
    }

    // Merge config
    this.streamConfig = { ...this.streamConfig, ...config };

    // For RTMP, destination is optional (defaults to local MediaMTX)
    // For SRT server mode, destination is not needed (device acts as server)

    try {
      // Kill any ffmpeg processes using the camera device
      console.log("Checking for processes using camera device...");
      await this._killCameraProcesses();

      // Kill any process using port 8555 (preview TCP server)
      console.log("🔍 Checking for processes using port 8555...");
      await this._killPortProcess(8555);
      console.log("✅ Port 8555 cleanup complete");

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

      // Wait a moment for the device and port to be released
      console.log("⏳ Waiting for resources to be released...");
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Emit "preparing" event so graphics overlay can initialize before GStreamer starts
      // Wait for the event handlers to complete (they may be async)
      await new Promise((resolve) => {
        this.emit("preparing");
        // Give event handlers time to complete (PNG generation + file write)
        setTimeout(resolve, 1500);
      });

      const gstArgs = this._buildGStreamerPipeline();

      // Hybrid mode: GStreamer outputs video-only MPEG-TS to stdout,
      // and a separate ffmpeg process adds ALSA audio + sends SRT.
      // Applies to BOTH the direct gst-launch path and the compositor (Python) script
      // path — the Python script also uses fdsink fd=1 when audio is enabled for SRT.
      const useFfmpegAudio =
        this.streamConfig.protocol === "srt" &&
        this.streamConfig.audioEnabled;

      // Check if we're using the compositor helper script
      if (gstArgs.useCompositorScript) {
        console.log("Starting GStreamer with compositor script...");
        console.log("Script args:", gstArgs.scriptArgs.join(" "));

        // In hybrid mode the Python script writes video-only MPEG-TS to stdout (fd=1)
        // so stdout must be a pipe, not inherited. In non-hybrid mode we still pipe so
        // the stderr log listener works; Python now writes all diagnostics to stderr.
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

      // Spawn ffmpeg for SRT+audio hybrid: reads video-only MPEG-TS from GStreamer's
      // stdout and adds ALSA audio. ffmpeg manages audio/video timing independently so
      // USB mic clock drift can NEVER stall the video path.
      if (useFfmpegAudio) {
        const audioDevice = this.streamConfig.audioDevice || "hw:3,0";
        console.log(`🎤 SRT hybrid mode — ffmpeg adding audio from ALSA: ${audioDevice}`);

        const ffmpegArgs = [
          "-loglevel", "warning",
          // ── Low-latency input flags ─────────────────────────────────────────
          "-fflags", "+nobuffer+discardcorrupt",
          "-flags", "low_delay",
          "-probesize", "32",       // probe only 32 bytes (MPEG-TS needs just the 0x47 sync byte)
          "-analyzeduration", "0",  // skip stream analysis — stream format is already known
          // ── Video input: video-only MPEG-TS piped from GStreamer stdout ─────
          //
          // NOTE — no use_wallclock_as_timestamps here:
          // That flag causes A/V sync problems. When ffmpeg is spawned, ALSA audio
          // capture begins at t=0, but GStreamer's hardware encoder (MPP) takes 1-2
          // seconds to initialize. With wallclock stamping, the first video packet
          // arrives stamped at wall t=1-2s while audio has been at t=0 for 1-2
          // seconds — instant sync offset visible to the viewer.
          //
          // Instead, ffmpeg is deferred (see below): it is not spawned until the
          // very first video chunk arrives from GStreamer's pipe. Both ALSA and video
          // therefore start at approximately the same real-world moment, and
          // aresample=async handles any residual USB clock drift long-term.
          "-thread_queue_size", "4096",  // raised from 512 — eliminates blocking warning
          "-f", "mpegts",
          "-i", "pipe:0",
          // ── Audio input: ALSA USB mic ───────────────────────────────────────
          "-thread_queue_size", "4096",
          "-f", "alsa", "-ac", "2", "-ar", "32000",
          "-i", audioDevice,
          // ── Stream mapping ──────────────────────────────────────────────────
          "-map", "0:v:0",  // video from pipe
          "-map", "1:a:0",  // audio from ALSA
          // ── Video: passthrough — no re-encode ───────────────────────────────
          "-c:v", "copy",
          // ── Audio: AAC + async resampler absorbs any residual USB clock jitter
          // async=1000: can stretch/compress up to 1000 samples/sec (~20ms/sec).
          // Over 8 hours that's >500 seconds of drift correction capacity —
          // more than enough for any real USB hardware clock drift.
          "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
          "-af", "aresample=async=1000",
          // ── Output: MPEG-TS over SRT, listener mode ─────────────────────────
          "-max_delay", "0",
          "-f", "mpegts",
          "srt://0.0.0.0:8891?mode=listener&latency=500000",
        ];

        // ── Deferred ffmpeg spawn ───────────────────────────────────────────────
        // GStreamer's hardware encoder (MPP) takes 1-2 seconds to produce its
        // first frame. If we spawn ffmpeg immediately, ALSA starts recording at
        // t=0 but video doesn't arrive until t=1-2s, creating an A/V offset that
        // is visible to the viewer from the very first second of the stream.
        //
        // Solution: pause GStreamer's stdout stream and wait for the first data
        // event. The moment GStreamer sends its first video chunk we spawn ffmpeg
        // (so ALSA starts at the same instant as video), write that first chunk
        // into ffmpeg's stdin manually, then switch to pipe() for all subsequent
        // chunks. Both streams begin at ~t=0 relative to each other → no offset.
        const gstStdout = this.gstProcess.stdout;
        gstStdout.pause(); // hold data in the OS pipe buffer until ffmpeg is ready

        const spawnFfmpegOnFirstChunk = (firstChunk) => {
          console.log("Starting ffmpeg with args:", ffmpegArgs.join(" "));
          this.ffmpegProcess = spawn("ffmpeg", ffmpegArgs, {
            stdio: ["pipe", "pipe", "pipe"],
          });

          // Write the first chunk that triggered the spawn, then pipe the rest
          this.ffmpegProcess.stdin.write(firstChunk);
          gstStdout.pipe(this.ffmpegProcess.stdin);
          gstStdout.resume();

          this.ffmpegProcess.stderr.on("data", (data) => {
            const msg = data.toString();
            console.log(`ffmpeg: ${msg}`);
            this.emit("log", msg);
          });

          this.ffmpegProcess.stdin.on("error", (err) => {
            // ffmpeg stdin closes when ffmpeg exits — suppress EPIPE noise
            if (err.code !== "EPIPE") console.error(`ffmpeg stdin error: ${err.message}`);
          });

          this.ffmpegProcess.on("close", (code) => {
            console.log(`ffmpeg exited with code ${code}`);
            this.ffmpegProcess = null;
          });
        };

        gstStdout.once("data", spawnFfmpegOnFirstChunk);
      }

      this.isStreaming = true;
      this.emit("started");

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
    return {
      isStreaming: this.isStreaming,
      config: this.streamConfig,
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
   * Kill any processes using the camera device
   */
  async _killCameraProcesses() {
    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    try {
      // Try multiple methods to find and kill processes using the camera

      // Method 1: Use fuser (most reliable for device files)
      try {
        const { stdout: fuserOut } = await execPromise(
          `sudo fuser ${this.cameraDevice} 2>&1 || true`,
        );
        if (fuserOut.trim()) {
          console.log("fuser output:", fuserOut);
          // Extract PIDs (fuser outputs like "/dev/video0: 1234 5678")
          const match = fuserOut.match(/:\s*(.+)/);
          if (match) {
            const pids = match[1].trim().split(/\s+/);
            for (const pid of pids) {
              if (pid && !isNaN(pid) && parseInt(pid) !== process.pid) {
                console.log(`Killing process ${pid} (found by fuser)...`);
                try {
                  await execPromise(`sudo kill -TERM ${pid}`);
                } catch (err) {
                  console.log(`Could not kill process ${pid}:`, err.message);
                }
              }
            }
          }
        }
      } catch (err) {
        console.log("fuser not available or failed:", err.message);
      }

      // Method 2: Kill all GStreamer and ffmpeg processes using the camera (fallback)
      try {
        const { stdout: psOut } = await execPromise(
          `ps aux | grep -E '(ffmpeg|gst-launch|gst-launch-1.0)' | grep -v grep || true`,
        );
        if (psOut.trim()) {
          console.log("Found media processes:", psOut);
          const lines = psOut.trim().split("\n");
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length > 1) {
              const pid = parts[1];
              // Don't kill our own process
              if (parseInt(pid) !== process.pid) {
                console.log(`Killing media process ${pid}...`);
                try {
                  process.kill(parseInt(pid), "SIGTERM");
                } catch (err) {
                  console.log(`Could not kill process ${pid}:`, err.message);
                }
              }
            }
          }
        }
      } catch (err) {
        console.log("Could not find media processes:", err.message);
      }

      // Verify the device is actually free now
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        const { stdout: verifyOut } = await execPromise(
          `sudo fuser ${this.cameraDevice} 2>&1 || true`,
        );
        const stillBusy = verifyOut.trim() && /\d/.test(verifyOut);
        if (stillBusy) {
          console.log(`⚠️  Camera still busy after cleanup: ${verifyOut.trim()}`);
          // Force kill remaining processes
          await execPromise(`sudo fuser -k ${this.cameraDevice} 2>/dev/null || true`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
          console.log("🔪 Force-killed remaining camera processes");
        }
      } catch (err) {
        // ignore
      }

      console.log("Finished checking for camera processes");
    } catch (error) {
      console.log("Error checking for camera processes:", error.message);
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

    console.log("🎨 Graphics overlay enabled - using PNG overlay (gdkpixbufoverlay)");

    const protocol = this.streamConfig.protocol || "srt";
    // Build the full destination URL based on protocol
    let effectiveDestination = destination || "";
    if (!effectiveDestination) {
      if (protocol === "srt") {
        effectiveDestination = "srt://:8891";
      } else if (protocol === "rtmp") {
        effectiveDestination = "rtmp://localhost:1935/stream";
      }
    }
    const pngPath = "/tmp/graphics-overlay.png";

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

    const audioDevice = this.streamConfig.audioEnabled ? (this.streamConfig.audioDevice || "hw:3,0") : "";

    const scriptArgs = [
      this.cameraDevice,
      width.toString(),
      height.toString(),
      framerate.toString(),
      bitrate.toString(),
      protocol,
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

    // Check if graphics overlay is needed:
    // - Legacy: skiaGraphicsEnabled checkbox (being removed from UI)
    // - New: Remote overlay checkbox with a URL set
    const needsGraphicsOverlay = this.streamConfig.skiaGraphicsEnabled ||
      (this.streamConfig.remoteOverlayEnabled &&
        this.streamConfig.overlayUrl && this.streamConfig.overlayUrl.trim());

    if (needsGraphicsOverlay) {
      // Use the PNG overlay pipeline (Python GStreamer with gdkpixbufoverlay)
      return this._buildPNGOverlayPipeline();
    }

    let pipeline = [
      // Video source - use MJPEG format which most USB cameras support at high resolution
      "v4l2src",
      `device=${this.cameraDevice}`,
      "do-timestamp=true", // Use pipeline clock timestamps for better sync
      "!",
      `image/jpeg,width=${width},height=${height},framerate=${framerate}/1`,
      "!",
      "jpegparse",
      "!",
      "mppjpegdec",
      "!",
    ];

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
    if (encoder === "mpph264enc" && !hasAnyOverlay) {
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
    if (encoder === "mpph264enc") {
      // Rockchip MPP hardware encoder (Orange Pi 5 / RK3588)
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
        "header-mode=each-idr",
        "profile=baseline", // No B-frames — required for RTMP/FLV and better for low-latency
        "!",
        "video/x-h264,stream-format=byte-stream",
        "!",
        "h264parse",
        "config-interval=-1", // Insert SPS/PPS before every keyframe
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
        "config-interval=-1",
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
        "config-interval=-1",
        "!",
      );
    } else if (encoder === "omxh264enc") {
      // OpenMAX encoder (fallback)
      pipeline.push("omxh264enc", `bitrate=${bitrate}`, "!", "h264parse", "!");
    }

    // Add another tee after encoding to split H.264 for output and preview
    pipeline.push("tee", "name=t2");

    // Branch 2a: Output stream (SRT or RTMP) - from t2 (H.264)
    if (protocol === "srt") {
      // SRT streaming - low latency with error correction
      // Use srtsink as listener - device acts as server, OBS connects as client
      // Port 8891 (8890 is used by MediaMTX)

      console.log(
        `📡 SRT server mode - OBS should connect to: srt://${this._getLocalIP()}:8891`,
      );

      pipeline.push(
        "t2.",
        "!",
        "queue",
        "max-size-buffers=0", // Use time-based buffering
        "max-size-time=1000000000", // 1 second buffer to absorb processing spikes
        "max-size-bytes=0",
        "leaky=downstream", // Drop old frames if queue is full
        "!",
        "mpegtsmux",
        "name=mux",
        "alignment=7", // Align packets for better compatibility
        "!",
      );

      if (this.streamConfig.audioEnabled) {
        // HYBRID MODE: GStreamer outputs video-only MPEG-TS to stdout.
        // A separate ffmpeg process reads it, adds ALSA audio, and sends SRT.
        //
        // Why: mpegtsmux is a SYNCHRONIZING muxer — it holds video output until audio
        // timestamps align. USB mic clock drift eventually causes audio to stall, which
        // stalls video through the mux, causing pixelation. No queue tuning can fix this;
        // it is inherent to how mpegtsmux works.
        //
        // ffmpeg manages audio/video sync completely independently: audio issues never
        // block the video path. startStream() spawns the ffmpeg process and pipes stdout.
        pipeline.push(
          "fdsink",
          "fd=1",      // stdout — piped to ffmpeg by Node.js
          "sync=false",
          "async=false",
        );
        // No audio branch in GStreamer — ffmpeg handles ALSA capture and AAC encoding.
      } else {
        // No audio — GStreamer handles SRT directly (known stable path)
        pipeline.push(
          "srtsink",
          "uri=srt://:8891",
          "wait-for-connection=false",
          "latency=500",
          "sync=false",
          "async=false",
        );
      }
    } else if (protocol === "rtmp") {
      // For RTMP, push to MediaMTX server
      // If destination is empty or localhost, use local MediaMTX
      const rtmpUrl =
        destination && destination.trim() !== ""
          ? destination
          : "rtmp://localhost:1935/stream";

      console.log(`📡 RTMP destination: ${rtmpUrl}`);

      pipeline.push(
        "t2.",
        "!",
        "queue",
        "max-size-buffers=0",
        "max-size-time=2000000000", // 2 second buffer to absorb processing spikes
        "max-size-bytes=0",
        // No leaky — dropping encoded H264 frames causes DTS duplicates/gaps
        "!",
        // Do NOT add a second h264parse here. The h264parse config-interval=-1 upstream
        // negotiates stream-format=avc,alignment=au directly with flvmux through the
        // queue. A second parse re-splits SPS+PPS+IDR into separate NAL buffers that all
        // share the same DTS, causing MediaMTX "DTS not monotonically increasing" drops.
        "video/x-h264,stream-format=avc,alignment=au", // negotiate avc+AU back to the upstream h264parse
        "!",
        "flvmux",
        "name=mux",
        "streamable=true",
        "!",
        "rtmpsink",
        `location=${rtmpUrl}`,
        "sync=false", // Don't sync to clock for lower latency
      );

      // Add audio branch into the mux if enabled
      if (this.streamConfig.audioEnabled) {
        const audioDevice = this.streamConfig.audioDevice || "hw:3,0";
        console.log(`🎤 Audio enabled - capturing from ALSA device: ${audioDevice}`);
        pipeline.push(
          "alsasrc",
          `device=${audioDevice}`,
          "provide-clock=false", // Don't let USB device clock become the pipeline clock
          "do-timestamp=true",   // Stamp each buffer with pipeline clock time, not USB hardware clock
          "buffer-time=50000",   // 50ms ALSA buffer (µs) — tight so do-timestamp stays accurate
          "latency-time=25000",  // 25ms period — how often ALSA delivers chunks to the pipeline
          "!",
          "audio/x-raw,rate=32000,channels=2,format=S16LE",
          "!",
          // Thread-isolation queue before audiorate — MUST be leaky=downstream.
          // A blocked alsasrc → no audiorate output → mux waits for audio → video stalls.
          "queue",
          "max-size-buffers=2",
          "max-size-time=0",
          "max-size-bytes=0",
          "leaky=downstream",
          "!",
          // audiorate fills timestamp gaps (from leaky drops) with silence so mux never waits.
          "audiorate",
          "!",
          "audioconvert",
          "!",
          "audioresample",
          "!",
          "audio/x-raw,rate=48000,channels=2",
          "!",
          "voaacenc",
          "bitrate=128000",
          "!",
          "aacparse",
          "!",
          // leaky=downstream drops the OLDEST buffer when full — mux always gets current timestamps
          "queue",
          "max-size-buffers=0",
          "max-size-time=200000000", // 200ms
          "max-size-bytes=0",
          "leaky=downstream",
          "!",
          "mux.",
        );
      }
    } else {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }

    // Branch 2b: Preview stream (MJPEG over TCP) - from t (raw video before encoding)
    // This taps the raw video BEFORE H.264 encoding, so no decoding needed!
    // Much more efficient and reliable than decoding H.264
    pipeline.push(
      "t.",
      "!",
      "queue",
      "max-size-buffers=10",
      "leaky=downstream",
      "!",
      "videorate", // Limit preview framerate to reduce CPU/bandwidth usage
      "!",
      "video/x-raw,framerate=2/1", // 2fps is sufficient for web preview
      "!",
      "videoconvert", // Convert from NV12 (or other) to format suitable for videoscale/jpegenc
      "!",
      "videoscale", // Scale down for lower bandwidth
      "!",
      "video/x-raw,width=1280,height=720", // 720p preview (lower bandwidth)
      "!",
      "jpegenc",
      "quality=65", // Lower quality to reduce preview bandwidth
      "!",
      "multipartmux",
      "boundary=--jpgboundary",
      "!",
      "tcpserversink",
      "host=0.0.0.0",
      "port=8555",
      "sync=false",
      "recover-policy=keyframe",
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
      let output = "";

      test.stdout.on("data", (data) => {
        output += data.toString();
      });

      test.on("close", (code) => {
        if (code === 0) {
          resolve({
            success: true,
            encoder: "mpph264enc",
            message: "Rockchip MPP hardware encoder available",
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
                  resolve({
                    success: false,
                    error: "No encoder found (tried mpph264enc, x264enc, nvv4l2h264enc)",
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
