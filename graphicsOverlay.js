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
   * Streams raw RGBA frames via TCP for real-time compositing
   */
  start() {
    if (this.isRunning) {
      console.log("⚠️  Graphics overlay already running");
      return;
    }

    if (!this.canvas) {
      this.initialize();
    }

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
        const success = this.gstProcess.stdin.write(buffer);

        // Log first frame to confirm it's working
        if (this.frameCount === 0) {
          console.log(`✅ First frame sent (${buffer.length} bytes)`);
        }

        // If write buffer is full, wait for drain
        if (!success) {
          this.gstProcess.stdin.once('drain', () => {
            // Ready for more data
          });
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

