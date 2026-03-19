const { createCanvas } = require("canvas");
const EventEmitter = require("events");
const fs = require("fs");
const { spawn } = require("child_process");

/**
 * Graphics Overlay Manager
 * Uses node-canvas to draw custom graphics and composites them over the video stream
 */
class GraphicsOverlay extends EventEmitter {
  constructor() {
    super();
    this.canvas = null;
    this.ctx = null;
    this.width = 1920;
    this.height = 1080;
    this.fps = 30;
    this.isRunning = false;
    this.frameInterval = null;
    this.frameCount = 0;
    this.gstProcess = null;
    this.pipePath = "/tmp/graphics-overlay-pipe";

    // Custom drawing function (can be overridden)
    this.drawFunction = this.defaultDrawFunction.bind(this);

    // Output stream for RGBA pipe mode (defaults to process.stdout)
    this.outputStream = null;
  }

  /**
   * Initialize the canvas
   */
  initialize(width = 1920, height = 1080, fps = 5) {
    this.width = width;
    this.height = height;
    this.fps = fps;

    // Create node-canvas
    this.canvas = createCanvas(width, height);
    this.ctx = this.canvas.getContext("2d");

    console.log(`🎨 Initialized canvas: ${width}x${height} @ ${fps}fps`);
  }

  /**
   * Default drawing function - draws a simple example
   * Override this with your custom drawing logic
   */
  defaultDrawFunction(ctx, frameNumber, timestamp) {
    // Clear with transparent background
    ctx.clearRect(0, 0, this.width, this.height);
    
    // Example: Draw a moving circle
    const x = (frameNumber * 5) % this.width;
    const y = this.height / 2;
    
    ctx.fillStyle = "rgba(255, 0, 0, 0.5)";
    ctx.beginPath();
    ctx.arc(x, y, 50, 0, Math.PI * 2);
    ctx.fill();
    
    // Example: Draw some text
    ctx.fillStyle = "white";
    ctx.font = "bold 48px Sans";
    ctx.fillText(`Frame: ${frameNumber}`, 50, 100);
    
    // Example: Draw a rectangle
    ctx.strokeStyle = "lime";
    ctx.lineWidth = 5;
    ctx.strokeRect(100, 200, 300, 200);
  }

  /**
   * Set a custom drawing function
   * @param {Function} drawFn - Function(ctx, frameNumber, timestamp)
   */
  setDrawFunction(drawFn) {
    this.drawFunction = drawFn;
  }

  /**
   * Set a custom output stream for RGBA pipe mode (instead of process.stdout)
   * @param {WritableStream} stream - Writable stream to write RGBA frames to
   */
  setOutputStream(stream) {
    this.outputStream = stream;
  }

  /**
   * Start the graphics overlay
   * @param {string} mode - "png" for file-based overlay (simple), "tcp" for streaming (complex), "pipe" for raw RGBA streaming
   * @param {string} pngPath - Path to PNG file (only used in PNG mode)
   */
  async start(mode = "png", pngPath = "/tmp/graphics-overlay.png") {
    if (this.isRunning) {
      console.log("⚠️  Graphics overlay already running");
      return;
    }

    if (!this.canvas) {
      this.initialize();
    }

    this.mode = mode;
    this.pngPath = pngPath;

    if (mode === "png") {
      // PNG file mode - simple and reliable for gdkpixbufoverlay
      console.log("🎨 Starting graphics overlay (PNG file mode)");
      this.isRunning = true;
      this.frameCount = 0;

      // Generate first frame SYNCHRONOUSLY so the file exists before GStreamer starts
      console.log("📝 Generating initial PNG frame...");
      await this.generateFramePNG(true);

      // Wait a moment to ensure filesystem has flushed the file
      await new Promise(resolve => setTimeout(resolve, 100));
      console.log("✅ PNG file ready for GStreamer");

      // Now start the interval for subsequent frames
      const frameTime = 1000 / this.fps;
      this.frameInterval = setInterval(() => {
        this.generateFramePNG();
      }, frameTime);

      console.log(`✅ Graphics overlay started (PNG mode)`);
      console.log(`📊 Generating frames at ${this.fps} FPS`);
      console.log(`📁 Output: ${this.pngPath}`);
      this.emit("started");

    } else if (mode === "pipe") {
      // Pipe mode - stream raw RGBA frames to stdout for GStreamer appsrc
      console.log("🎨 Starting graphics overlay (PIPE mode - raw RGBA frames)");
      this.isRunning = true;
      this.frameCount = 0;

      // Start generating frames immediately
      const frameTime = 1000 / this.fps;
      this.frameInterval = setInterval(() => {
        this.generateFrameRGBA();
      }, frameTime);

      console.log(`✅ Graphics overlay started (PIPE mode)`);
      console.log(`📊 Generating RGBA frames at ${this.fps} FPS`);
      this.emit("started");

    } else {
      // TCP mode - for compositor (currently broken on Jetson)
      // Start GStreamer pipeline that serves raw RGBA video via TCP
      const pipeline = [
        "fdsrc",
        "!",
        `video/x-raw,format=RGBA,width=${this.width},height=${this.height},framerate=${this.fps}/1`,
        "!",
        "tcpserversink",
        "host=127.0.0.1",
        "port=8556",
        "sync=false",
        "recover-policy=keyframe",
      ];

      console.log("🚀 Starting graphics overlay TCP server...");
      this.gstProcess = spawn("gst-launch-1.0", pipeline);

      // Handle EPIPE errors gracefully
      this.gstProcess.stdin.on('error', (err) => {
        if (err.code === 'EPIPE') {
          console.log("Graphics stream pipe closed");
          this.stop();
        } else {
          console.error("Graphics stdin error:", err);
        }
      });

      this.gstProcess.stderr.on("data", (data) => {
        const msg = data.toString();
        if (!msg.includes("Setting pipeline") && !msg.includes("Prerolled")) {
          console.log("Graphics GStreamer:", msg.trim());
        }
      });

      this.gstProcess.on("exit", (code) => {
        console.log(`Graphics GStreamer exited with code ${code}`);
        this.isRunning = false;
      });

      // Wait a moment for GStreamer to start
      setTimeout(() => {
        // Start generating frames
        this.isRunning = true;
        this.frameCount = 0;
        const frameTime = 1000 / this.fps;

        this.frameInterval = setInterval(() => {
          this.generateFrame();
        }, frameTime);

        console.log(`✅ Graphics overlay started (TCP port 8556)`);
        console.log(`📊 Generating frames at ${this.fps} FPS`);
        this.emit("started");
      }, 500);
    }
  }

  /**
   * Generate and save frame as PNG (for gdkpixbufoverlay)
   * @param {boolean} sync - If true, wait for file to be written (for first frame)
   *
   * NOTE: We write to BOTH a static file AND a numbered sequence:
   * - /tmp/graphics-overlay.png - for gdkpixbufoverlay (static, first frame only)
   * - /tmp/graphics-overlay-NNNN.png - for multifilesrc (dynamic, all frames)
   */
  generateFramePNG(sync = false) {
    if (!this.isRunning && !sync) return;

    const timestamp = Date.now();

    // Call the drawing function
    this.drawFunction(this.ctx, this.frameCount, timestamp);

    // Save as PNG to the configured path (or default)
    const staticPath = this.pngPath || "/tmp/graphics-overlay.png";
    const numberedPath = `/tmp/graphics-overlay-${String(this.frameCount).padStart(6, '0')}.png`;

    if (sync) {
      // Synchronous mode - wait for file to be fully written
      return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(staticPath);
        const stream = this.canvas.createPNGStream();

        stream.pipe(out);

        out.on("finish", () => {
          console.log(`✅ First PNG frame saved to ${staticPath} (${fs.statSync(staticPath).size} bytes)`);
          this.frameCount++;
          resolve();
        });

        out.on("error", (err) => {
          console.error("Error writing PNG:", err);
          reject(err);
        });

        stream.on("error", (err) => {
          console.error("Error creating PNG stream:", err);
          reject(err);
        });
      });
    } else {
      // Async mode for subsequent frames
      // Write to numbered files that multifilesrc can read in sequence
      try {
        const out = fs.createWriteStream(numberedPath);
        const stream = this.canvas.createPNGStream();

        stream.pipe(out);

        out.on("finish", () => {
          // Also update the static file for compatibility
          const targetPath = this.pngPath || staticPath;
          try {
            fs.copyFileSync(numberedPath, targetPath);
          } catch (err) {
            // Ignore copy errors
          }

          // Clean up old numbered files (keep only last 20 for smooth playback)
          if (this.frameCount > 20) {
            const oldFile = `/tmp/graphics-overlay-${String(this.frameCount - 20).padStart(6, '0')}.png`;
            try {
              if (fs.existsSync(oldFile)) {
                fs.unlinkSync(oldFile);
              }
            } catch (err) {
              // Ignore cleanup errors
            }
          }
        });

        this.frameCount++;
      } catch (err) {
        console.error("Error generating PNG frame:", err);
      }
    }
  }

  /**
   * Generate and stream a single frame
   */
  generateFrame() {
    if (!this.isRunning || !this.gstProcess) return;

    try {
      const timestamp = Date.now();

      // Call the drawing function
      this.drawFunction(this.ctx, this.frameCount, timestamp);

      // Get raw RGBA buffer from canvas
      const imageData = this.ctx.getImageData(0, 0, this.width, this.height);
      const buffer = Buffer.from(imageData.data.buffer);

      // Write to GStreamer stdin
      if (this.gstProcess.stdin && this.gstProcess.stdin.writable && !this.gstProcess.stdin.destroyed) {
        this.gstProcess.stdin.write(buffer);

        // Log first frame to confirm it's working
        if (this.frameCount === 0) {
          console.log(`✅ First frame sent (${buffer.length} bytes)`);
        }
      } else {
        // Pipe is closed, stop generating frames
        console.log("Graphics pipe closed, stopping...");
        this.stop();
      }

      this.frameCount++;
    } catch (err) {
      if (err.code !== 'EPIPE') {
        console.error("Error generating frame:", err);
      }
    }
  }

  /**
   * Generate a single RGBA frame and write to stdout for GStreamer appsrc
   */
  generateFrameRGBA() {
    if (!this.isRunning) return;

    try {
      const timestamp = Date.now();

      // Call the drawing function
      this.drawFunction(this.ctx, this.frameCount, timestamp);

      // Get raw RGBA buffer from canvas
      const imageData = this.ctx.getImageData(0, 0, this.width, this.height);
      const buffer = Buffer.from(imageData.data.buffer);

      // Write to output stream (FIFO or stdout)
      const out = this.outputStream || process.stdout;
      out.write(buffer);

      // Log every 30 frames (once per second at 30fps, or every 15 seconds at 2fps)
      if (this.frameCount % 30 === 0) {
        console.error(`🎨 Generated frame ${this.frameCount} (${buffer.length} bytes)`);
      }

      this.frameCount++;
    } catch (err) {
      if (err.code !== 'EPIPE') {
        console.error("Error generating RGBA frame:", err);
      }
    }
  }

  /**
   * Stop the graphics overlay
   */
  stop() {
    if (!this.isRunning) return;

    console.log("🛑 Stopping graphics overlay...");

    this.isRunning = false;

    if (this.frameInterval) {
      clearInterval(this.frameInterval);
      this.frameInterval = null;
    }

    if (this.gstProcess) {
      try {
        this.gstProcess.stdin.end();
      } catch (err) {
        // Ignore errors
      }
      this.gstProcess.kill();
      this.gstProcess = null;
    }

    this.emit("stopped");
    console.log("✅ Graphics overlay stopped");
  }
}

module.exports = GraphicsOverlay;

