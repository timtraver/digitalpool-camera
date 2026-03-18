const { createCanvas } = require("canvas");
const { spawn } = require("child_process");
const EventEmitter = require("events");
const http = require("http");

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
    this.httpServer = null;
    this.clients = [];

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

    // Create HTTP server for MJPEG streaming
    this.httpServer = http.createServer((req, res) => {
      if (req.url === '/' || req.url.startsWith('/?')) {
        // Serve MJPEG stream
        res.writeHead(200, {
          'Content-Type': 'multipart/x-mixed-replace; boundary=--graphicsboundary',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });

        // Add client to list
        this.clients.push(res);
        console.log(`📺 Client connected (${this.clients.length} total)`);

        // Remove client when disconnected
        req.on('close', () => {
          const index = this.clients.indexOf(res);
          if (index > -1) {
            this.clients.splice(index, 1);
            console.log(`📺 Client disconnected (${this.clients.length} remaining)`);
          }
        });
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    this.httpServer.listen(outputPort, '0.0.0.0', () => {
      console.log(`✅ Graphics overlay HTTP server started on port ${outputPort}`);
    });

    // Start generating frames
    this.isRunning = true;
    this.frameCount = 0;
    const frameTime = 1000 / this.fps;

    this.frameInterval = setInterval(() => {
      this.generateFrame();
    }, frameTime);

    console.log(`🚀 Graphics overlay ready at http://0.0.0.0:${outputPort}`);
    this.emit("started");
  }

  /**
   * Generate and send a single frame to all connected clients
   */
  async generateFrame() {
    if (!this.isRunning || this.clients.length === 0) return;

    try {
      const timestamp = Date.now();

      // Call the drawing function
      this.drawFunction(this.ctx, this.frameCount, timestamp);

      // Convert canvas to JPEG buffer
      const jpegBuffer = this.canvas.toBuffer('image/jpeg', { quality: 0.85 });

      // Send to all connected clients
      const disconnected = [];
      for (let i = 0; i < this.clients.length; i++) {
        const client = this.clients[i];
        try {
          if (!client.destroyed) {
            client.write('--graphicsboundary\r\n');
            client.write('Content-Type: image/jpeg\r\n');
            client.write(`Content-Length: ${jpegBuffer.length}\r\n\r\n`);
            client.write(jpegBuffer);
            client.write('\r\n');
          } else {
            disconnected.push(i);
          }
        } catch (err) {
          disconnected.push(i);
        }
      }

      // Remove disconnected clients
      for (let i = disconnected.length - 1; i >= 0; i--) {
        this.clients.splice(disconnected[i], 1);
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

    // Close all client connections
    for (const client of this.clients) {
      try {
        client.end();
      } catch (err) {
        // Ignore errors
      }
    }
    this.clients = [];

    // Close HTTP server
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }

    this.emit("stopped");
    console.log("✅ Graphics overlay stopped");
  }
}

module.exports = GraphicsOverlay;

