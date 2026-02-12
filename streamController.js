const { spawn } = require("child_process");
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");

class StreamController extends EventEmitter {
  constructor(cameraDevice = "/dev/video0") {
    super();
    this.cameraDevice = cameraDevice;
    this.gstProcess = null;
    this.isStreaming = false;
    this.configFile = path.join(__dirname, "stream-config.json");

    // Default configuration
    const defaultConfig = {
      protocol: "rtmp", // 'srt' or 'rtmp'
      destination: "rtmp://localhost:1935/stream",
      width: 1920,
      height: 1080,
      framerate: 30,
      bitrate: 5000000, // 5 Mbps
      encoder: "nvv4l2h264enc", // Hardware encoder
      autoStart: false, // Auto-start streaming on server startup
      // Overlay settings
      overlayEnabled: false,
      overlayType: "text",
      overlayText: "",
      showTimestamp: false,
      overlayUrl: "",
      timestampPosition: "bottom-right",
      titlePosition: "top-left",
      overlayFontSize: 32,
      overlayColor: "white",
      overlayBackground: "transparent",
      overlayBackgroundOpacity: 70,
      // Legacy fields
      timestampFormat: "%Y-%m-%d %H:%M:%S",
      logoPath: "", // Path to logo image overlay
    };

    // Load config from file or use defaults
    this.streamConfig = this.loadConfig() || defaultConfig;
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

    // For RTMP, destination is optional (defaults to local nginx)
    // For SRT, destination is required
    if (
      this.streamConfig.protocol === "srt" &&
      !this.streamConfig.destination
    ) {
      return { success: false, error: "No destination URL specified for SRT" };
    }

    try {
      // Kill any ffmpeg processes using the camera device
      console.log("Checking for processes using camera device...");
      await this._killCameraProcesses();

      // Kill any process using port 8555 (preview TCP server)
      console.log("🔍 Checking for processes using port 8555...");
      await this._killPortProcess(8555);
      console.log("✅ Port 8555 cleanup complete");

      // Wait a moment for the device and port to be released
      console.log("⏳ Waiting for resources to be released...");
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const gstArgs = this._buildGStreamerPipeline();
      console.log("Starting GStreamer with pipeline:", gstArgs.join(" "));

      this.gstProcess = spawn("gst-launch-1.0", gstArgs);

      this.gstProcess.stdout.on("data", (data) => {
        console.log(`GStreamer stdout: ${data}`);
        this.emit("log", data.toString());
      });

      this.gstProcess.stderr.on("data", (data) => {
        const message = data.toString();
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

      this.gstProcess.on("close", (code) => {
        console.log(`GStreamer process exited with code ${code}`);
        this.isStreaming = false;
        this.gstProcess = null;
        this.emit("stopped", code);
      });

      this.isStreaming = true;
      this.emit("started");

      // Enable auto-start and save config
      this.streamConfig.autoStart = true;
      this.saveConfig();

      return { success: true, message: "Stream started" };
    } catch (error) {
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
      this.isStreaming = false;

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
          `fuser ${this.cameraDevice} 2>&1 || true`,
        );
        if (fuserOut.trim()) {
          console.log("fuser output:", fuserOut);
          // Extract PIDs (fuser outputs like "/dev/video0: 1234 5678")
          const match = fuserOut.match(/:\s*(.+)/);
          if (match) {
            const pids = match[1].trim().split(/\s+/);
            for (const pid of pids) {
              if (pid && !isNaN(pid)) {
                console.log(`Killing process ${pid} (found by fuser)...`);
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
        console.log("fuser not available or failed:", err.message);
      }

      // Method 2: Kill all ffmpeg processes (fallback)
      try {
        const { stdout: psOut } = await execPromise(
          `ps aux | grep ffmpeg | grep -v grep || true`,
        );
        if (psOut.trim()) {
          console.log("Found ffmpeg processes:", psOut);
          const lines = psOut.trim().split("\n");
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length > 1) {
              const pid = parts[1];
              console.log(`Killing ffmpeg process ${pid}...`);
              try {
                process.kill(parseInt(pid), "SIGTERM");
              } catch (err) {
                console.log(`Could not kill process ${pid}:`, err.message);
              }
            }
          }
        }
      } catch (err) {
        console.log("Could not find ffmpeg processes:", err.message);
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

    let pipeline = [
      // Video source - use MJPEG format which most USB cameras support at high resolution
      "v4l2src",
      `device=${this.cameraDevice}`,
      "do-timestamp=true", // Use pipeline clock timestamps for better sync
      "!",
      `image/jpeg,width=${width},height=${height},framerate=${framerate}/1`,
      "!",
      "jpegdec",
      "!",
    ];

    // Add overlays if enabled
    if (this.streamConfig.overlayEnabled) {
      // Convert to format suitable for textoverlay
      pipeline.push("videoconvert", "!");

      // Add timestamp overlay if enabled
      if (this.streamConfig.showTimestamp) {
        const tsPosition =
          this.streamConfig.timestampPosition || "bottom-right";
        const [vpos, hpos] = tsPosition.split("-");
        const valign =
          vpos === "bottom" ? "bottom" : vpos === "center" ? "center" : "top";
        const halign =
          hpos === "left" ? "left" : hpos === "right" ? "right" : "center";

        // Scale font size for 1920x1080 output (web preview uses scaled size for 1280x720)
        const scaledFontSize = Math.round(
          this.streamConfig.overlayFontSize * 1.5,
        );

        // Use clockoverlay to show actual time instead of timeoverlay (stream duration)
        const timestampArgs = [
          "clockoverlay",
          `valignment=${valign}`,
          `halignment=${halign}`,
          `font-desc=Sans Bold ${scaledFontSize}`,
          `color=${this._colorToInt(this.streamConfig.overlayColor)}`,
          'time-format="%Y-%m-%d %H:%M:%S"', // Show date and time
        ];

        // Only add shaded background if not transparent
        if (this.streamConfig.overlayBackground !== "transparent") {
          timestampArgs.push("shaded-background=true");
        }

        timestampArgs.push("xpad=20", "ypad=20", "!");
        pipeline.push(...timestampArgs);
      }

      // Add custom text overlay 1 (main title)
      if (this.streamConfig.overlayText || this.streamConfig.customText1) {
        const text =
          this.streamConfig.overlayText || this.streamConfig.customText1;

        // Parse position (e.g., "bottom-left", "top-center")
        const position =
          this.streamConfig.titlePosition ||
          this.streamConfig.overlayPosition ||
          "bottom-left";
        const [vpos, hpos] = position.split("-");
        const valign =
          vpos === "bottom" ? "bottom" : vpos === "center" ? "center" : "top";
        const halign =
          hpos === "left" ? "left" : hpos === "right" ? "right" : "center";

        // Scale font size for 1920x1080 output (web preview uses scaled size for 1280x720)
        const scaledFontSize = Math.round(
          this.streamConfig.overlayFontSize * 1.5,
        );

        const textArgs = [
          "textoverlay",
          `text="${text}"`,
          `valignment=${valign}`,
          `halignment=${halign}`,
          `font-desc=Sans Bold ${scaledFontSize}`,
          `color=${this._colorToInt(this.streamConfig.overlayColor)}`,
        ];

        // Only add shaded background if not transparent
        if (this.streamConfig.overlayBackground !== "transparent") {
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

    // Hardware encoding pipeline
    if (encoder === "nvv4l2h264enc") {
      // NVIDIA V4L2 encoder (best for Jetson)
      pipeline.push(
        "nvvidconv",
        "!",
        "video/x-raw(memory:NVMM)",
        "!",
        "nvv4l2h264enc",
        `bitrate=${bitrate}`,
        "preset-level=1", // Ultra-fast preset for low latency
        "profile=0", // Baseline profile (fastest encoding)
        "iframeinterval=15", // Keyframe every 0.5 seconds (reduced from 30)
        "insert-sps-pps=true", // Insert SPS/PPS with every IDR frame
        "insert-vui=false", // Disable VUI for lower overhead
        "insert-aud=false", // Disable AUD for lower overhead
        "maxperf-enable=true", // Enable maximum performance mode
        "!",
        "video/x-h264,stream-format=byte-stream",
        "!",
        "h264parse",
        "config-interval=-1", // Insert SPS/PPS before every keyframe
        "!",
      );
    } else if (encoder === "omxh264enc") {
      // OpenMAX encoder (fallback)
      pipeline.push("omxh264enc", `bitrate=${bitrate}`, "!", "h264parse", "!");
    }

    // Use tee to split the stream for both output and preview
    pipeline.push("tee", "name=t");

    // Branch 1: Output stream (RTMP, SRT, or UDP)
    if (protocol === "srt") {
      // SRT streaming - low latency with error correction
      // Format: srt://HOST:PORT (e.g., srt://192.168.1.100:8890)
      // Use srtclientsink in caller mode to connect to OBS listener

      // Validate destination
      if (!destination || destination.trim() === "") {
        throw new Error(
          "SRT destination is required (e.g., srt://192.168.1.100:8890)",
        );
      }

      console.log(`📡 SRT destination: ${destination}`);

      pipeline.push(
        "t.",
        "!",
        "queue",
        "max-size-buffers=2", // Minimal buffering for low latency
        "max-size-time=0",
        "max-size-bytes=0",
        "leaky=downstream", // Drop old frames if queue is full
        "!",
        "mpegtsmux",
        "!",
        "srtclientsink", // srtclientsink connects to listener (OBS)
        `uri=${destination}`,
        "latency=125", // Latency in milliseconds
        "poll-timeout=100", // Poll timeout in milliseconds
      );
    } else if (protocol === "udp") {
      // UDP streaming - lowest latency (200-500ms)
      // Format: udp://HOST:PORT (e.g., udp://192.168.1.100:5000)
      // Sends raw MPEG-TS over UDP

      // Validate destination
      if (!destination || destination.trim() === "") {
        throw new Error(
          "UDP destination is required (e.g., udp://192.168.1.100:5000)",
        );
      }

      const udpHost = this._parseUdpHost(destination);
      const udpPort = this._parseUdpPort(destination);

      console.log(`📡 UDP destination: ${udpHost}:${udpPort}`);

      pipeline.push(
        "t.",
        "!",
        "queue",
        "max-size-buffers=0", // No buffering for absolute minimum latency
        "max-size-time=0",
        "max-size-bytes=0",
        "!",
        "mpegtsmux",
        "!",
        "udpsink",
        `host=${udpHost}`,
        `port=${udpPort}`,
        "sync=false", // Don't sync to clock
        "async=false", // Don't wait for preroll
      );
    } else if (protocol === "rtmp") {
      // For RTMP, push to MediaMTX server
      // If destination is empty or localhost, use local MediaMTX
      const rtmpUrl =
        destination && destination.trim() !== ""
          ? destination
          : "rtmp://localhost:1935/stream";

      console.log(`📡 RTMP destination: ${rtmpUrl}`);

      pipeline.push(
        "t.",
        "!",
        "queue",
        "max-size-buffers=2", // Minimal buffering for low latency
        "max-size-time=0",
        "max-size-bytes=0",
        "leaky=downstream", // Drop old frames if queue is full
        "!",
        "flvmux",
        "streamable=true",
        "!",
        "rtmpsink",
        `location=${rtmpUrl}`,
        "sync=false", // Don't sync to clock for lower latency
      );
    } else {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }

    // Branch 2: Preview stream (TCP server for web interface)
    // TEMPORARILY DISABLED - causing pipeline to fail
    // TODO: Re-enable once main stream is working
    /*
    pipeline.push(
      "t.",
      "!",
      "queue",
      "max-size-buffers=10",
      "leaky=downstream",
      "!",
      "h264parse",
      "!",
      "nvv4l2decoder",
      "enable-max-performance=1",
      "!",
      "nvvidconv",
      "!",
      "video/x-raw,format=I420,width=1280,height=720",
      "!",
      "nvjpegenc",
      "quality=85",
      "!",
      "multipartmux",
      "boundary=frame",
      "!",
      "tcpserversink",
      "host=0.0.0.0",
      "port=8555",
      "recover-policy=keyframe",
      "sync=false",
      "async=false",
    );
    */

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
   * Parse UDP destination to extract host
   * Format: udp://HOST:PORT or HOST:PORT
   */
  _parseUdpHost(destination) {
    try {
      const url = new URL(destination);
      return url.hostname || "127.0.0.1";
    } catch (e) {
      // If not a valid URL, assume it's just HOST:PORT
      const parts = destination.split(":");
      return parts[0] || "127.0.0.1";
    }
  }

  /**
   * Parse UDP destination to extract port
   * Format: udp://HOST:PORT or HOST:PORT
   */
  _parseUdpPort(destination) {
    try {
      const url = new URL(destination);
      return url.port || "5000";
    } catch (e) {
      // If not a valid URL, assume it's just HOST:PORT
      const parts = destination.split(":");
      return parts[1] || "5000";
    }
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
      const test = spawn("gst-inspect-1.0", ["nvv4l2h264enc"]);
      let output = "";

      test.stdout.on("data", (data) => {
        output += data.toString();
      });

      test.on("close", (code) => {
        if (code === 0) {
          resolve({
            success: true,
            encoder: "nvv4l2h264enc",
            message: "Hardware encoder available",
          });
        } else {
          // Try fallback to omxh264enc
          const testOmx = spawn("gst-inspect-1.0", ["omxh264enc"]);
          testOmx.on("close", (omxCode) => {
            if (omxCode === 0) {
              resolve({
                success: true,
                encoder: "omxh264enc",
                message: "OpenMAX encoder available",
              });
            } else {
              resolve({
                success: false,
                error: "No hardware encoder found",
              });
            }
          });
        }
      });
    });
  }
}

module.exports = StreamController;
