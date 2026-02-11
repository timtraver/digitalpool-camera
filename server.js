require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const { spawn } = require("child_process");
const path = require("path");
const CameraController = require("./cameraController");
const StreamController = require("./streamController");

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3000;
const CAMERA_DEVICE = process.env.CAMERA_DEVICE || "/dev/video0";

// Initialize camera controller
const camera = new CameraController(CAMERA_DEVICE);

// Flag to track if camera is fully initialized
let cameraInitialized = false;

// Initialize stream controller
const streamController = new StreamController(CAMERA_DEVICE);

// Stream controller event handlers
streamController.on("started", () => {
  io.emit("streamStatus", { isStreaming: true, status: "started" });
});

streamController.on("stopped", (code) => {
  io.emit("streamStatus", { isStreaming: false, status: "stopped", code });
});

streamController.on("error", (error) => {
  io.emit("streamError", { error });
});

streamController.on("log", (log) => {
  console.log("Stream log:", log);
});

// Serve static files from public directory
app.use(express.static("public"));
app.use(express.json());

// Proxy endpoint for loading external URLs (bypasses X-Frame-Options)
app.get("/proxy", async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).send("Missing 'url' query parameter");
  }

  try {
    const https = require("https");
    const http = require("http");
    const urlModule = require("url");

    const parsedUrl = urlModule.parse(targetUrl);
    const protocol = parsedUrl.protocol === "https:" ? https : http;

    console.log("Proxying URL:", targetUrl);

    protocol
      .get(targetUrl, (proxyRes) => {
        // Remove X-Frame-Options and CSP headers that would block iframe embedding
        const headers = { ...proxyRes.headers };
        delete headers["x-frame-options"];
        delete headers["content-security-policy"];
        delete headers["content-security-policy-report-only"];

        // Set CORS headers to allow embedding
        headers["access-control-allow-origin"] = "*";

        // If it's HTML, we need to rewrite URLs to go through the proxy
        const contentType = headers["content-type"] || "";
        if (contentType.includes("text/html")) {
          let body = "";
          proxyRes.setEncoding("utf8");
          proxyRes.on("data", (chunk) => {
            body += chunk;
          });
          proxyRes.on("end", () => {
            // Get the base URL (origin) of the target
            const targetOrigin = `${parsedUrl.protocol}//${parsedUrl.host}`;

            // Rewrite relative URLs to absolute URLs pointing to the original server
            body = body.replace(
              /href=["']\/([^"']*)["']/g,
              `href="${targetOrigin}/$1"`,
            );
            body = body.replace(
              /src=["']\/([^"']*)["']/g,
              `src="${targetOrigin}/$1"`,
            );

            // Update content-length header
            headers["content-length"] = Buffer.byteLength(body);

            res.writeHead(proxyRes.statusCode, headers);
            res.end(body);
          });
        } else {
          // For non-HTML content, just pipe it through
          res.writeHead(proxyRes.statusCode, headers);
          proxyRes.pipe(res);
        }
      })
      .on("error", (err) => {
        console.error("Proxy error:", err);
        res.status(500).send("Failed to fetch URL: " + err.message);
      });
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).send("Failed to fetch URL: " + err.message);
  }
});

// Main page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Test page
app.get("/test", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "test-stream.html"));
});

// API endpoint to check server status
app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    camera_device: CAMERA_DEVICE,
    timestamp: new Date().toISOString(),
  });
});

// API endpoint to get all controls
app.get("/api/controls", async (req, res) => {
  const result = await camera.getAllControls();
  res.json(result);
});

// API endpoint to get specific control
app.get("/api/control/:name", async (req, res) => {
  const result = await camera.getControl(req.params.name);
  res.json(result);
});

// API endpoint to set control
app.post("/api/control/:name", async (req, res) => {
  const { value } = req.body;
  const result = await camera.setControl(req.params.name, value);
  res.json(result);
});

// API endpoint to get camera configuration
app.get("/api/camera/config", (req, res) => {
  res.json({ success: true, config: camera.config });
});

// API endpoint to reset camera to defaults
app.post("/api/camera/reset", async (req, res) => {
  const result = await camera.resetToDefaults();
  res.json({ success: true, results: result, config: camera.config });
});

// ============ STREAMING API ENDPOINTS ============

// Get stream status
app.get("/api/stream/status", (req, res) => {
  res.json(streamController.getStatus());
});

// Start stream
app.post("/api/stream/start", async (req, res) => {
  const config = req.body;
  const result = await streamController.startStream(config);
  res.json(result);
});

// Stop stream
app.post("/api/stream/stop", async (req, res) => {
  const result = await streamController.stopStream();
  res.json(result);
});

// Update stream configuration
app.post("/api/stream/config", (req, res) => {
  const config = req.body;
  const result = streamController.updateConfig(config);
  res.json(result);
});

// Test GStreamer availability
app.get("/api/stream/test", async (req, res) => {
  const result = await StreamController.testGStreamer();
  res.json(result);
});

// Update overlay configuration
app.post("/api/stream/overlay", (req, res) => {
  const overlayConfig = req.body;
  const result = streamController.updateOverlay(overlayConfig);
  res.json(result);
});

// ============ END STREAMING API ============

// Video stream endpoint using MJPEG
app.get("/video/stream", (req, res) => {
  console.log("New video stream connection requested");

  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Try multiple ffmpeg configurations for better camera compatibility
  // First try: MJPEG format (fastest if supported)
  let ffmpegArgs = [
    "-f",
    "v4l2",
    "-input_format",
    "mjpeg",
    "-video_size",
    "1280x720",
    "-framerate",
    "30",
    "-i",
    CAMERA_DEVICE,
    "-f",
    "mjpeg",
    "-q:v",
    "5",
    "pipe:1",
  ];

  // Check if alternative format is requested
  if (req.query.format === "yuyv") {
    console.log("Using YUYV format");
    ffmpegArgs = [
      "-f",
      "v4l2",
      "-input_format",
      "yuyv422",
      "-video_size",
      "1280x720",
      "-framerate",
      "30",
      "-i",
      CAMERA_DEVICE,
      "-r",
      "5", // Output 5fps for preview (saves CPU/bandwidth)
      "-f",
      "mjpeg",
      "-q:v",
      "5",
      "pipe:1",
    ];
  } else if (req.query.format === "auto") {
    console.log("Using auto format detection");
    ffmpegArgs = [
      "-f",
      "v4l2",
      "-video_size",
      "1280x720",
      "-framerate",
      "30",
      "-i",
      CAMERA_DEVICE,
      "-r",
      "5", // Output 5fps for preview (saves CPU/bandwidth)
      "-f",
      "mjpeg",
      "-q:v",
      "5",
      "pipe:1",
    ];
  }

  console.log("Starting ffmpeg with args:", ffmpegArgs.join(" "));
  const ffmpeg = spawn("ffmpeg", ffmpegArgs);

  let frameBuffer = Buffer.alloc(0);
  let errorOutput = "";

  ffmpeg.stdout.on("data", (data) => {
    frameBuffer = Buffer.concat([frameBuffer, data]);

    // Look for JPEG markers
    let start = frameBuffer.indexOf(Buffer.from([0xff, 0xd8])); // JPEG start
    let end = frameBuffer.indexOf(Buffer.from([0xff, 0xd9])); // JPEG end

    while (start !== -1 && end !== -1 && end > start) {
      const frame = frameBuffer.slice(start, end + 2);
      try {
        res.write(`--frame\r\n`);
        res.write(`Content-Type: image/jpeg\r\n`);
        res.write(`Content-Length: ${frame.length}\r\n\r\n`);
        res.write(frame);
        res.write("\r\n");
      } catch (err) {
        console.error("Error writing frame:", err.message);
        ffmpeg.kill();
        return;
      }

      frameBuffer = frameBuffer.slice(end + 2);
      start = frameBuffer.indexOf(Buffer.from([0xff, 0xd8]));
      end = frameBuffer.indexOf(Buffer.from([0xff, 0xd9]));
    }
  });

  ffmpeg.stderr.on("data", (data) => {
    errorOutput += data.toString();
    // Only log important errors, not info messages
    const msg = data.toString();
    if (
      msg.includes("error") ||
      msg.includes("Error") ||
      msg.includes("failed")
    ) {
      console.error(`FFmpeg error: ${msg}`);
    }
  });

  ffmpeg.on("close", (code) => {
    console.log(`FFmpeg process exited with code ${code}`);
    if (code !== 0 && code !== null) {
      console.error("FFmpeg full error output:", errorOutput);
    }
  });

  ffmpeg.on("error", (err) => {
    console.error("Failed to start ffmpeg:", err);
  });

  req.on("close", () => {
    console.log("Client disconnected, killing ffmpeg");
    ffmpeg.kill();
  });
});

// Socket.IO for real-time camera control
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Handle camera control commands
  socket.on("setControl", async (data) => {
    const { control, value } = data;
    console.log(
      `📡 Client ${socket.id} sent setControl: ${control} = ${value}`,
    );

    // Ignore commands if camera is still initializing
    if (!cameraInitialized) {
      console.log(`⚠️  Ignoring command - camera still initializing`);
      return;
    }

    const result = await camera.setControl(control, value);
    socket.emit("controlResult", result);
  });

  socket.on("getControl", async (data) => {
    const { control } = data;
    const result = await camera.getControl(control);
    socket.emit("controlResult", result);
  });

  socket.on("pan", async (data) => {
    const { degrees } = data;
    console.log(`📡 Client ${socket.id} sent pan: ${degrees} degrees`);
    const result = await camera.pan(degrees);
    socket.emit("controlResult", result);
  });

  socket.on("tilt", async (data) => {
    const { degrees } = data;
    console.log(`📡 Client ${socket.id} sent tilt: ${degrees} degrees`);
    const result = await camera.tilt(degrees);
    socket.emit("controlResult", result);
  });

  socket.on("zoom", async (data) => {
    const { level } = data;
    const result = await camera.zoom(level);
    socket.emit("controlResult", result);
  });

  socket.on("resetPosition", async () => {
    const result = await camera.resetPosition();
    socket.emit("controlResult", result);
  });

  socket.on("getCameraConfig", () => {
    socket.emit("cameraConfig", { success: true, config: camera.config });
  });

  socket.on("resetCameraSettings", async () => {
    const results = await camera.resetToDefaults();
    socket.emit("cameraConfigReset", {
      success: true,
      results: results,
      config: camera.config,
    });
  });

  // ============ STREAMING SOCKET EVENTS ============

  socket.on("startStream", async (config) => {
    const result = await streamController.startStream(config);
    socket.emit("streamResult", result);
  });

  socket.on("stopStream", async () => {
    const result = await streamController.stopStream();
    socket.emit("streamResult", result);
  });

  socket.on("getStreamStatus", () => {
    const status = streamController.getStatus();
    socket.emit("streamStatus", status);
  });

  socket.on("updateStreamConfig", (config) => {
    const result = streamController.updateConfig(config);
    socket.emit("streamResult", result);
  });

  socket.on("updateOverlay", (overlayConfig) => {
    const result = streamController.updateOverlay(overlayConfig);
    socket.emit("overlayResult", result);
  });

  // ============ END STREAMING SOCKET EVENTS ============

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

server.listen(PORT, async () => {
  console.log(`Camera control server running on port ${PORT}`);
  console.log(`Camera device: ${CAMERA_DEVICE}`);
  console.log(`Access the interface at http://localhost:${PORT}`);

  // Apply saved camera configuration on startup
  console.log("\n🚀 Initializing camera with saved configuration...");
  try {
    // Activate the camera device first
    await camera.activateCamera();

    // Start a temporary stream to wake up the camera for PTZ commands
    console.log("📹 Starting temporary stream to activate camera PTZ...");
    const { spawn } = require("child_process");
    const tempStream = spawn("ffmpeg", [
      "-f",
      "v4l2",
      "-input_format",
      "mjpeg",
      "-video_size",
      "1280x720",
      "-framerate",
      "30",
      "-i",
      CAMERA_DEVICE,
      "-f",
      "null",
      "-",
    ]);

    // Wait for stream to start
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log("✅ Temporary stream started");

    // Check current camera position before applying config
    console.log("� Checking current camera position...");
    const currentPan = await camera.getControl("pan_absolute");
    const currentTilt = await camera.getControl("tilt_absolute");
    const currentZoom = await camera.getControl("zoom_absolute");
    console.log(
      `📍 Current position: pan=${currentPan.value}, tilt=${currentTilt.value}, zoom=${currentZoom.value}`,
    );

    await camera.applyConfig();

    // Wait for camera to finish moving
    console.log("⏳ Waiting for camera to finish moving...");
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Verify the position was actually set
    console.log("🔍 Verifying camera position after config...");
    const verifyPan = await camera.getControl("pan_absolute");
    const verifyTilt = await camera.getControl("tilt_absolute");
    const verifyZoom = await camera.getControl("zoom_absolute");
    console.log(
      `📍 Final position: pan=${verifyPan.value}, tilt=${verifyTilt.value}, zoom=${verifyZoom.value}`,
    );

    // Check if position matches config
    const panMatch =
      Math.abs(verifyPan.value - camera.config.pan_absolute) < 3600; // Within 1 degree
    const tiltMatch =
      Math.abs(verifyTilt.value - camera.config.tilt_absolute) < 3600;
    const zoomMatch = verifyZoom.value === camera.config.zoom_absolute;

    if (!panMatch || !tiltMatch || !zoomMatch) {
      console.log("⚠️  Camera position does not match config!");
      console.log(
        `   Expected: pan=${camera.config.pan_absolute}, tilt=${camera.config.tilt_absolute}, zoom=${camera.config.zoom_absolute}`,
      );
      console.log(
        `   Actual:   pan=${verifyPan.value}, tilt=${verifyTilt.value}, zoom=${verifyZoom.value}`,
      );
    } else {
      console.log("✅ Camera position matches config!");
    }

    // Stop the temporary stream
    console.log("🛑 Stopping temporary stream...");
    tempStream.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log("✅ Temporary stream stopped");

    cameraInitialized = true;
    console.log("✅ Camera initialized successfully\n");
  } catch (error) {
    console.error("❌ Error initializing camera:", error.message);
    cameraInitialized = true; // Allow commands even if init failed
  }
});
