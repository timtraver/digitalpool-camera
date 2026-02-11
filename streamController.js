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
      protocol: "srt", // 'srt' or 'rtmp'
      destination: "",
      width: 1920,
      height: 1080,
      framerate: 30,
      bitrate: 5000000, // 5 Mbps
      encoder: "nvv4l2h264enc", // Hardware encoder
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

      // Wait a moment for the device to be released
      await new Promise((resolve) => setTimeout(resolve, 500));

      const gstArgs = this._buildGStreamerPipeline();
      console.log("Starting GStreamer with pipeline:", gstArgs.join(" "));

      this.gstProcess = spawn("gst-launch-1.0", gstArgs);

      this.gstProcess.stdout.on("data", (data) => {
        console.log(`GStreamer stdout: ${data}`);
        this.emit("log", data.toString());
      });

      this.gstProcess.stderr.on("data", (data) => {
        console.error(`GStreamer stderr: ${data}`);
        this.emit("error", data.toString());
      });

      this.gstProcess.on("close", (code) => {
        console.log(`GStreamer process exited with code ${code}`);
        this.isStreaming = false;
        this.gstProcess = null;
        this.emit("stopped", code);
      });

      this.isStreaming = true;
      this.emit("started");

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
        const valign =
          this.streamConfig.overlayPosition === "bottom" ? "bottom" : "top";
        pipeline.push(
          "timeoverlay",
          `valignment=${valign}`,
          "halignment=right",
          `font-desc=Sans Bold ${this.streamConfig.overlayFontSize}`,
          "shaded-background=true",
          "!",
        );
      }

      // Add custom text overlay 1 (main title)
      if (this.streamConfig.overlayText || this.streamConfig.customText1) {
        const text =
          this.streamConfig.overlayText || this.streamConfig.customText1;
        const valign =
          this.streamConfig.overlayPosition === "bottom" ? "bottom" : "top";
        const halign = "center";

        pipeline.push(
          "textoverlay",
          `text="${text}"`,
          `valignment=${valign}`,
          `halignment=${halign}`,
          `font-desc=Sans Bold ${this.streamConfig.overlayFontSize}`,
          `color=${this._colorToInt(this.streamConfig.overlayColor)}`,
          this.streamConfig.overlayBackground ? "shaded-background=true" : "",
          "!",
        );
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
        "!",
        "video/x-h264,stream-format=byte-stream",
        "!",
        "h264parse",
        "!",
      );
    } else if (encoder === "omxh264enc") {
      // OpenMAX encoder (fallback)
      pipeline.push("omxh264enc", `bitrate=${bitrate}`, "!", "h264parse", "!");
    }

    // Output based on protocol
    if (protocol === "srt") {
      pipeline.push(
        "mpegtsmux",
        "!",
        "srtsink",
        `uri=${destination}`,
        "latency=125",
      );
    } else if (protocol === "rtmp") {
      // For RTMP, push to local nginx server
      // If destination is empty or localhost, use local nginx
      const rtmpUrl = destination || "rtmp://localhost:1935/live/stream";
      pipeline.push(
        "flvmux",
        "streamable=true",
        "!",
        "rtmpsink",
        `location=${rtmpUrl}`,
      );
    } else {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }

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
