const { createCanvas } = require("canvas");
const { spawn } = require("child_process");
const EventEmitter = require("events");

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
    this.gstProcess = null;
    this.frameInterval = null;
    this.frameCount = 0;
    
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
   * Start the graphics overlay pipeline
   * This creates a GStreamer pipeline that accepts raw RGBA frames
   */
  start(outputPort = 8556) {
    if (this.isRunning) {
      console.log("⚠️  Graphics overlay already running");
      return;
    }

    if (!this.canvas) {
      this.initialize();
    }

    // GStreamer pipeline to accept raw RGBA frames and output as TCP server
    // This can be composited with the video stream using 'compositor' element
    const pipeline = [
      "fdsrc",
      "!",
      `video/x-raw,format=RGBA,width=${this.width},height=${this.height},framerate=${this.fps}/1`,
      "!",
      "videoconvert",
      "!",
      "video/x-raw,format=I420",
      "!",
      "jpegenc",
      "quality=85",
      "!",
      "multipartmux",
      "boundary=--graphicsboundary",
      "!",
      "tcpserversink",
      "host=0.0.0.0",
      `port=${outputPort}`,
      "sync=false",
    ];

    console.log("🚀 Starting graphics overlay GStreamer pipeline...");
    console.log("Pipeline:", pipeline.join(" "));

    this.gstProcess = spawn("gst-launch-1.0", pipeline);

    this.gstProcess.stderr.on("data", (data) => {
      console.log("GStreamer graphics:", data.toString());
    });

    this.gstProcess.on("exit", (code) => {
      console.log(`Graphics overlay GStreamer exited with code ${code}`);
      this.stop();
    });

    // Start generating frames
    this.isRunning = true;
    this.frameCount = 0;
    const frameTime = 1000 / this.fps;

    this.frameInterval = setInterval(() => {
      this.generateFrame();
    }, frameTime);

    console.log(`✅ Graphics overlay started on port ${outputPort}`);
    this.emit("started");
  }

  /**
   * Generate and send a single frame
   */
  async generateFrame() {
    if (!this.isRunning || !this.gstProcess) return;

    try {
      const timestamp = Date.now();
      
      // Call the drawing function
      this.drawFunction(this.ctx, this.frameCount, timestamp);
      
      // Get raw RGBA buffer from canvas
      const imageData = this.ctx.getImageData(0, 0, this.width, this.height);
      const buffer = Buffer.from(imageData.data.buffer);
      
      // Write to GStreamer stdin
      this.gstProcess.stdin.write(buffer);
      
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
    
    if (this.gstProcess) {
      this.gstProcess.kill();
      this.gstProcess = null;
    }
    
    this.emit("stopped");
    console.log("✅ Graphics overlay stopped");
  }
}

module.exports = GraphicsOverlay;

