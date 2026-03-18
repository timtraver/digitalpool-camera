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
   * Start the graphics overlay
   * Streams raw RGBA frames via GStreamer pipeline for compositing
   */
  start() {
    if (this.isRunning) {
      console.log("⚠️  Graphics overlay already running");
      return;
    }

    if (!this.canvas) {
      this.initialize();
    }

    // Start GStreamer pipeline that outputs raw RGBA video via TCP
    const pipeline = [
      "fdsrc",
      "!",
      `video/x-raw,format=RGBA,width=${this.width},height=${this.height},framerate=${this.fps}/1`,
      "!",
      "videoconvert",
      "!",
      "video/x-raw,format=RGBA",
      "!",
      "tcpserversink",
      "host=127.0.0.1",
      "port=8556",
      "sync=false",
      "recover-policy=keyframe",
    ];

    console.log("🚀 Starting graphics overlay GStreamer pipeline...");
    this.gstProcess = spawn("gst-launch-1.0", pipeline);

    this.gstProcess.stderr.on("data", (data) => {
      const msg = data.toString();
      if (!msg.includes("Setting pipeline") && !msg.includes("Prerolled")) {
        console.log("GStreamer graphics:", msg.trim());
      }
    });

    this.gstProcess.on("exit", (code) => {
      console.log(`Graphics overlay GStreamer exited with code ${code}`);
      this.isRunning = false;
    });

    // Start generating frames
    this.isRunning = true;
    this.frameCount = 0;
    const frameTime = 1000 / this.fps;

    this.frameInterval = setInterval(() => {
      this.generateFrame();
    }, frameTime);

    console.log(`✅ Graphics overlay started (streaming via TCP port 8556)`);
    console.log(`📊 Generating frames at ${this.fps} FPS`);
    this.emit("started");
  }

  /**
   * Generate and send a single frame to GStreamer
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

      // Write to GStreamer stdin (check if writable first)
      if (this.gstProcess.stdin && this.gstProcess.stdin.writable) {
        try {
          this.gstProcess.stdin.write(buffer);

          // Log first frame to confirm it's working
          if (this.frameCount === 0) {
            console.log(`✅ First frame sent to GStreamer (${buffer.length} bytes)`);
          }
        } catch (err) {
          if (err.code === 'EPIPE') {
            // Pipe closed, stop gracefully
            this.stop();
          }
        }
      } else {
        // Pipe is closed, stop generating frames
        this.stop();
      }

      this.frameCount++;
    } catch (err) {
      // Ignore EPIPE errors (broken pipe) - just stop gracefully
      if (err.code !== 'EPIPE') {
        console.error("Error generating frame:", err);
      }
      this.stop();
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

