require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const { spawn } = require("child_process");
const path = require("path");
const CameraController = require("./cameraController");

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

// Serve static files from public directory
app.use(express.static("public"));
app.use(express.json());

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
    const result = await camera.pan(degrees);
    socket.emit("controlResult", result);
  });

  socket.on("tilt", async (data) => {
    const { degrees } = data;
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

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Camera control server running on port ${PORT}`);
  console.log(`Camera device: ${CAMERA_DEVICE}`);
  console.log(`Access the interface at http://localhost:${PORT}`);
});
