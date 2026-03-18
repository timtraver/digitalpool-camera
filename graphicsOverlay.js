const { createCanvas } = require("canvas");
const EventEmitter = require("events");
const fs = require("fs");

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
    this.outputPath = "/tmp/graphics-overlay.png";

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
   * Writes PNG frames to /tmp/graphics-overlay.png for GStreamer gdkpixbufoverlay
   */
  start() {
    if (this.isRunning) {
      console.log("⚠️  Graphics overlay already running");
      return;
    }

    if (!this.canvas) {
      this.initialize();
    }

    // Start generating frames
    this.isRunning = true;
    this.frameCount = 0;
    const frameTime = 1000 / this.fps;

    this.frameInterval = setInterval(() => {
      this.generateFrame();
    }, frameTime);

    console.log(`✅ Graphics overlay started (writing to ${this.outputPath})`);
    console.log(`📊 Generating frames at ${this.fps} FPS`);
    this.emit("started");
  }

  /**
   * Generate and write a single frame as PNG
   */
  generateFrame() {
    if (!this.isRunning) return;

    try {
      const timestamp = Date.now();

      // Call the drawing function
      this.drawFunction(this.ctx, this.frameCount, timestamp);

      // Write canvas to PNG file (with transparency support!)
      // Use synchronous toBuffer for reliability
      const pngBuffer = this.canvas.toBuffer('image/png');

      // Write directly to the output file
      // GStreamer's gdkpixbufoverlay will handle reading it
      fs.writeFileSync(this.outputPath, pngBuffer);

      // Log first frame to confirm it's working
      if (this.frameCount === 0) {
        console.log(`✅ First frame written to ${this.outputPath} (${pngBuffer.length} bytes)`);
      }

      this.frameCount++;
    } catch (err) {
      console.error("Error generating frame:", err);
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

    // Clean up the PNG file
    try {
      if (fs.existsSync(this.outputPath)) {
        fs.unlinkSync(this.outputPath);
      }
      if (fs.existsSync(this.outputPath + '.tmp')) {
        fs.unlinkSync(this.outputPath + '.tmp');
      }
    } catch (err) {
      // Ignore errors
    }

    this.emit("stopped");
    console.log("✅ Graphics overlay stopped");
  }
}

module.exports = GraphicsOverlay;

