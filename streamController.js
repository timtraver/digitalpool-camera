const { spawn } = require("child_process");
const EventEmitter = require("events");

class StreamController extends EventEmitter {
  constructor(cameraDevice = "/dev/video0") {
    super();
    this.cameraDevice = cameraDevice;
    this.gstProcess = null;
    this.isStreaming = false;
    this.streamConfig = {
      protocol: "srt", // 'srt' or 'rtmp'
      destination: "",
      width: 1920,
      height: 1080,
      framerate: 30,
      bitrate: 5000000, // 5 Mbps
      encoder: "nvv4l2h264enc", // Hardware encoder
      // Overlay settings
      overlayEnabled: false,
      overlayText: "",
      overlayPosition: "top", // 'top', 'bottom', 'center'
      overlayFontSize: 32,
      overlayColor: "white",
      overlayBackground: true, // Add semi-transparent background
      // Additional overlay options
      showTimestamp: false,
      timestampFormat: "%Y-%m-%d %H:%M:%S",
      customText1: "",
      customText2: "",
      logoPath: "", // Path to logo image overlay
    };
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

    if (!this.streamConfig.destination) {
      return { success: false, error: "No destination URL specified" };
    }

    try {
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
    return { success: true, config: this.streamConfig };
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
      // Video source
      "v4l2src",
      `device=${this.cameraDevice}`,
      "!",
      `video/x-raw,width=${width},height=${height},framerate=${framerate}/1`,
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
          `time-format="${this.streamConfig.timestampFormat}"`,
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
      pipeline.push(
        "flvmux",
        "streamable=true",
        "!",
        "rtmpsink",
        `location=${destination}`,
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
    return {
      success: true,
      message: "Overlay updated. Restart stream to apply changes.",
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
