require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const CameraController = require("./cameraController");
const StreamController = require("./streamController");

// Try to load HTML overlay renderer (wkhtmltoimage + ImageMagick)
let PuppeteerOverlay = null;
try {
  PuppeteerOverlay = require("./puppeteerOverlay");
  console.log("✅ HTML overlay module loaded (wkhtmltoimage + ImageMagick)");
} catch (err) {
  console.log("ℹ️  HTML overlay not available:", err.message);
}

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

// Initialize Puppeteer overlay (if available)
let puppeteerOverlay = null;
// Game state for scoreboard (update this from your app)
let gameState = {
  player1Name: "Player 1",
  player2Name: "Player 2",
  player1Score: 0,
  player2Score: 0,
  matchTitle: "Match 53",
  // UI overlay configuration
  overlayFontSize: 32,
  overlayColor: "white",
  overlayBackground: "transparent",
};

// Function to regenerate the PNG overlay with updated game state
async function regenerateOverlay() {
  if (puppeteerOverlay && puppeteerOverlay.isRunning) {
    await puppeteerOverlay.updateState(gameState);
  }
  // Broadcast to all clients
  io.emit("scoreUpdated", gameState);

  // Also write game state to JSON file (for any scripts that need it)
  try {
    const fs = require('fs');
    fs.writeFileSync('/tmp/graphics-overlay-state.json', JSON.stringify(gameState, null, 2));
  } catch (err) {
    console.error('Error writing game state JSON:', err);
  }
}

// Stream controller event handlers
streamController.on("started", () => {
  const status = streamController.getStatus();
  io.emit("streamStatus", { ...status, status: "started" });
});

streamController.on("stopped", (code) => {
  const status = streamController.getStatus();
  io.emit("streamStatus", { ...status, status: "stopped", code });
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

// Helper function to proxy any URL
function proxyUrl(targetUrl, res, req = null) {
  const https = require("https");
  const http = require("http");
  const urlModule = require("url");

  const parsedUrl = urlModule.parse(targetUrl);
  const protocol = parsedUrl.protocol === "https:" ? https : http;

  const requestId = Math.random().toString(36).substring(7);
  console.log(
    `[${requestId}] Proxying URL:`,
    targetUrl,
    req ? `(${req.method})` : "(GET)",
  );

  // For GET requests or when no req object is provided
  if (!req || req.method === "GET") {
    protocol
      .get(targetUrl, (proxyRes) => {
        console.log(
          `[${requestId}] Response status: ${proxyRes.statusCode}, Content-Type: ${proxyRes.headers["content-type"]}`,
        );

        // Remove X-Frame-Options and CSP headers that would block iframe embedding
        const headers = { ...proxyRes.headers };
        delete headers["x-frame-options"];
        delete headers["content-security-policy"];
        delete headers["content-security-policy-report-only"];
        delete headers["content-encoding"]; // Remove encoding header since we're decompressing

        // Set CORS headers to allow embedding
        headers["access-control-allow-origin"] = "*";

        // For HTML or JavaScript content, collect and potentially modify it
        const contentType = headers["content-type"] || "";
        if (
          contentType.includes("text/html") ||
          contentType.includes("javascript")
        ) {
          let body = "";
          proxyRes.setEncoding("utf8");
          proxyRes.on("data", (chunk) => {
            body += chunk;
          });
          proxyRes.on("end", () => {
            if (contentType.includes("text/html")) {
              console.log(`[${requestId}] HTML content length:`, body.length);
              console.log(
                `[${requestId}] HTML preview (first 500 chars):`,
                body.substring(0, 500),
              );
            }

            // Rewrite hardcoded GraphQL URLs to use our proxy
            if (contentType.includes("javascript")) {
              // Look for any GraphQL endpoint URLs and log them
              const graphqlUrlMatch = body.match(
                /https:\/\/[^"'\s]+graphql[^"'\s]*/gi,
              );
              if (graphqlUrlMatch) {
                console.log(
                  `[${requestId}] Found GraphQL URLs in JavaScript:`,
                  graphqlUrlMatch,
                );
              }

              // Replace the actual production API URLs with our local proxy
              const originalLength = body.length;

              // Replace both HTTP and WebSocket URLs
              body = body.replace(
                /https:\/\/api-prod\.digitalpool\.com\/v1\/graphql/g,
                "/graphql",
              );
              body = body.replace(
                /wss:\/\/api-prod\.digitalpool\.com\/v1\/graphql/g,
                "ws://192.168.1.114:3000/graphql",
              );

              // Also replace the old proxy URL if it exists
              body = body.replace(/https:\/\/proxy\.digitalpool\.com/g, "");

              if (body.length !== originalLength) {
                console.log(
                  `[${requestId}] Rewrote GraphQL URLs in JavaScript bundle`,
                );
                headers["content-length"] = Buffer.byteLength(body);
              }
            }

            res.writeHead(proxyRes.statusCode, headers);
            res.end(body);
          });
        } else {
          // Just pipe through - don't modify content
          console.log(
            `[${requestId}] Piping ${contentType} response directly to client`,
          );
          res.writeHead(proxyRes.statusCode, headers);
          proxyRes.pipe(res);
        }
      })
      .on("error", (err) => {
        console.error("Proxy error:", err);
        res.status(500).send("Failed to fetch URL: " + err.message);
      });
  } else {
    // For POST/PUT/etc requests, we need to forward the body
    // Prepare the body first to calculate content-length
    const bodyStr = req.body ? JSON.stringify(req.body) : "";

    // Forward important headers including cookies for authentication
    const headers = {
      "content-type": req.headers["content-type"] || "application/json",
      "content-length": Buffer.byteLength(bodyStr),
      "user-agent": req.headers["user-agent"] || "Mozilla/5.0",
      host: parsedUrl.hostname,
      origin: `${parsedUrl.protocol}//${parsedUrl.hostname}`,
      referer: targetUrl,
    };

    // Forward cookies if present (needed for authentication)
    if (req.headers.cookie) {
      headers.cookie = req.headers.cookie;
    }

    // Forward authorization header if present
    if (req.headers.authorization) {
      headers.authorization = req.headers.authorization;
    }

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.path,
      method: req.method,
      headers: headers,
    };

    console.log(
      `[${requestId}] Making ${req.method} request with body (${bodyStr.length} bytes):`,
      bodyStr.substring(0, 200),
    );
    console.log(
      `[${requestId}] Request headers:`,
      JSON.stringify(headers, null, 2),
    );

    const proxyReq = protocol.request(options, (proxyRes) => {
      const responseContentType = proxyRes.headers["content-type"] || "";
      console.log(
        `[${requestId}] Response status: ${proxyRes.statusCode}, Content-Type: ${responseContentType}`,
      );

      // Remove X-Frame-Options and CSP headers
      const headers = { ...proxyRes.headers };
      delete headers["x-frame-options"];
      delete headers["content-security-policy"];
      delete headers["content-security-policy-report-only"];
      delete headers["content-encoding"]; // Remove encoding header since we're decompressing

      // Set CORS headers
      headers["access-control-allow-origin"] = "*";

      // Collect response body for logging
      let body = "";
      proxyRes.setEncoding("utf8");
      proxyRes.on("data", (chunk) => {
        body += chunk;
        console.log(`[${requestId}] Received ${chunk.length} bytes`);
      });
      proxyRes.on("end", () => {
        console.log(
          `[${requestId}] Response complete, total body length: ${body.length}`,
        );
        if (responseContentType.includes("application/json")) {
          console.log(
            `[${requestId}] ✅ GraphQL Response (JSON):`,
            body.substring(0, 500),
          );
        } else {
          console.log(
            `[${requestId}] ❌ GraphQL Response (HTML - ERROR):`,
            body.substring(0, 200),
          );
        }
        res.writeHead(proxyRes.statusCode, headers);
        res.end(body);
      });
      proxyRes.on("error", (err) => {
        console.error(`[${requestId}] Response stream error:`, err);
      });
    });

    proxyReq.on("error", (err) => {
      console.error(`[${requestId}] Proxy error:`, err);
      if (!res.headersSent) {
        res.status(500).send("Failed to fetch URL: " + err.message);
      }
    });

    // Set a timeout for the request (30 seconds)
    proxyReq.setTimeout(30000, () => {
      console.error(`[${requestId}] Request timeout after 30 seconds`);
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).send("Gateway timeout");
      }
    });

    // Forward the request body
    if (bodyStr) {
      console.log(
        `[${requestId}] Writing ${bodyStr.length} bytes to proxy request`,
      );
      proxyReq.write(bodyStr);
    }
    proxyReq.end();
    console.log(`[${requestId}] Request sent, waiting for response...`);
  }
}

// Proxy endpoint for loading external URLs (bypasses X-Frame-Options)
app.get("/proxy", async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).send("Missing 'url' query parameter");
  }

  try {
    proxyUrl(targetUrl, res);
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

// API endpoint to get device IP addresses
app.get("/api/network", (req, res) => {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const [name, nets] of Object.entries(interfaces)) {
    for (const net of nets) {
      // Skip loopback and internal addresses
      if (!net.internal && net.family === "IPv4") {
        addresses.push({ interface: name, address: net.address });
      }
    }
  }
  res.json({ success: true, addresses });
});

// API endpoint to get current scoreboard
app.get("/api/scoreboard", (req, res) => {
  res.json({
    success: true,
    gameState,
  });
});

// API endpoint to update scoreboard
app.post("/api/scoreboard", express.json(), (req, res) => {
  console.log(`📊 REST API: Updating scoreboard:`, req.body);

  // Update game state
  if (req.body.player1Name !== undefined) gameState.player1Name = req.body.player1Name;
  if (req.body.player2Name !== undefined) gameState.player2Name = req.body.player2Name;
  if (req.body.player1Score !== undefined) gameState.player1Score = req.body.player1Score;
  if (req.body.player2Score !== undefined) gameState.player2Score = req.body.player2Score;
  if (req.body.matchTitle !== undefined) gameState.matchTitle = req.body.matchTitle;

  // Regenerate the PNG overlay
  regenerateOverlay();

  // Broadcast to all Socket.IO clients
  io.emit("scoreUpdated", gameState);

  res.json({
    success: true,
    gameState,
  });
});

// API endpoint to set/change the overlay URL (for remote JS-based overlays)
app.post("/api/overlay-url", express.json(), async (req, res) => {
  const { url, refreshInterval, jsDelay } = req.body;
  console.log(`🌍 REST API: Setting overlay URL:`, url || "(disabled)");

  if (puppeteerOverlay) {
    puppeteerOverlay.setOverlayUrl(url, { refreshInterval, jsDelay });
    if (url && url.trim()) {
      puppeteerOverlay.startPeriodicRefresh();
    } else {
      // Switching back to local mode — regenerate the local scoreboard overlay
      await puppeteerOverlay.updateState(gameState);
    }
  }

  // Also save to stream config so it persists
  streamController.streamConfig.overlayUrl = url || "";
  streamController.saveConfig();

  res.json({ success: true, overlayUrl: url || "" });
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

// API endpoint to get stream configuration
app.get("/api/stream/config", (req, res) => {
  res.json({ success: true, config: streamController.streamConfig });
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

  // Also update gameState with overlay configuration for node-graphics-stream.js
  if (overlayConfig.overlayFontSize !== undefined) {
    gameState.overlayFontSize = overlayConfig.overlayFontSize;
  }
  if (overlayConfig.overlayColor !== undefined) {
    gameState.overlayColor = overlayConfig.overlayColor;
  }
  if (overlayConfig.overlayBackground !== undefined) {
    gameState.overlayBackground = overlayConfig.overlayBackground;
  }

  // Write updated state to JSON file
  regenerateOverlay();

  res.json(result);
});

// ============ END STREAMING API ============

// Test endpoint to check TCP connection
app.get("/video/test", (req, res) => {
  const net = require("net");
  const client = net.connect({ port: 8555, host: "localhost" });

  let received = 0;
  const timeout = setTimeout(() => {
    client.destroy();
    res.json({
      success: received > 0,
      bytesReceived: received,
      message:
        received > 0
          ? "TCP stream is working"
          : "No data received from TCP stream",
    });
  }, 2000);

  client.on("data", (data) => {
    received += data.length;
  });

  client.on("error", (err) => {
    clearTimeout(timeout);
    res.json({ success: false, error: err.message });
  });
});

// Serve HLS playlist and segments for preview when streaming
app.get("/video/hls/playlist.m3u8", (req, res) => {
  const fs = require("fs");

  console.log("📺 HLS playlist requested");

  if (!streamController.isStreaming) {
    console.log("⚠️  Stream not active");
    return res.status(404).send("Stream not active");
  }

  // Generate playlist dynamically from available segments
  try {
    const streamDir = "/tmp/stream";

    if (!fs.existsSync(streamDir)) {
      console.log("❌ /tmp/stream directory doesn't exist");
      return res.status(404).send("Stream directory not found");
    }

    // Get all .ts files and sort them numerically
    const files = fs.readdirSync(streamDir)
      .filter(f => f.endsWith('.ts'))
      .map(f => {
        const match = f.match(/segment(\d+)\.ts/);
        return match ? { name: f, num: parseInt(match[1]) } : null;
      })
      .filter(f => f !== null)
      .sort((a, b) => a.num - b.num);

    if (files.length === 0) {
      console.log("⚠️  No segments available yet");
      return res.status(404).send("No segments available yet");
    }

    // Get the sequence number from the oldest segment
    const mediaSequence = files[0].num;

    // Generate HLS playlist
    let playlist = "#EXTM3U\n";
    playlist += "#EXT-X-VERSION:3\n";
    playlist += "#EXT-X-TARGETDURATION:3\n";
    playlist += `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}\n`;

    // Add each segment
    for (const file of files) {
      playlist += "#EXTINF:2.0,\n";
      playlist += file.name + "\n";
    }

    // Only log occasionally to reduce spam (every 10th request)
    if (Math.random() < 0.1) {
      console.log("✅ Serving HLS playlist: segments", mediaSequence, "to", files[files.length - 1].num);
    }

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(playlist);
  } catch (error) {
    console.error("❌ Error generating playlist:", error);
    res.status(500).send("Error generating playlist");
  }
});

app.get("/video/hls/:segment", (req, res) => {
  const fs = require("fs");
  const segmentPath = `/tmp/stream/${req.params.segment}`;

  if (!fs.existsSync(segmentPath)) {
    console.log("⚠️  Segment not found:", req.params.segment);
    return res.status(404).send("Segment not found");
  }

  // Only log occasionally to reduce spam
  if (Math.random() < 0.05) {
    console.log("✅ Serving segment:", req.params.segment);
  }

  res.setHeader("Content-Type", "video/mp2t");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Access-Control-Allow-Origin", "*");
  fs.createReadStream(segmentPath).pipe(res);
});

// TCP preview endpoint - proxies the GStreamer TCP server
app.get("/video/tcp-preview", (req, res) => {
  console.log("📺 TCP preview connection requested");

  if (!streamController.isStreaming) {
    console.log("⚠️  Stream not active, redirecting to regular preview");
    return res.redirect("/video/stream");
  }

  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=--jpgboundary",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const net = require("net");
  const client = net.connect({ port: 8555, host: "localhost" });

  let bytesReceived = 0;
  let firstDataReceived = false;

  client.on("connect", () => {
    console.log("✅ Connected to GStreamer TCP server on port 8555");
  });

  client.on("data", (data) => {
    bytesReceived += data.length;

    if (!firstDataReceived) {
      firstDataReceived = true;
      console.log("📦 First data chunk received:", data.length, "bytes");
      console.log("📝 First 100 bytes:", data.slice(0, 100).toString('hex'));
    }

    try {
      res.write(data);
    } catch (e) {
      console.log("Client disconnected from TCP preview");
      console.log("📊 Total bytes sent:", bytesReceived);
      client.destroy();
    }
  });

  client.on("error", (err) => {
    console.error("❌ TCP preview error:", err.message);
    res.end();
  });

  client.on("end", () => {
    console.log("TCP preview stream ended");
    res.end();
  });

  req.on("close", () => {
    console.log("Client disconnected from TCP preview");
    client.destroy();
  });
});

// Track active idle preview process (only one at a time)
let currentIdlePreviewProcess = null;

// Video stream endpoint using MJPEG
app.get("/video/stream", async (req, res) => {
  console.log("New video stream connection requested");

  // If streaming is active, don't try to access camera for idle preview
  if (streamController.isStreaming) {
    console.log(
      "⚠️  Stream is active - preview should use HLS at /video/hls/playlist.m3u8",
    );
    res.status(503).send("Stream active - use HLS preview");
    return;
  }

  // Kill the previous idle preview process if it exists
  if (currentIdlePreviewProcess && !currentIdlePreviewProcess.killed) {
    console.log("🔄 Killing previous idle preview to start new one with updated settings");
    currentIdlePreviewProcess.kill();
    currentIdlePreviewProcess = null;
    // Wait a moment for the process to die and release the camera
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Check if camera is busy and try to clean up
  const { execSync } = require("child_process");
  try {
    const fuserOutput = execSync(`fuser ${CAMERA_DEVICE} 2>&1`, {
      encoding: "utf-8",
      timeout: 1000,
    });

    if (fuserOutput.includes(":")) {
      console.log("⚠️  Camera is busy, attempting cleanup...");
      const pids = fuserOutput
        .split(":")[1]
        .trim()
        .split(/\s+/)
        .map((p) => p.replace(/\D/g, ""))
        .filter((p) => p);

      for (const pid of pids) {
        console.log(`Killing process ${pid} using camera...`);
        try {
          execSync(`kill -9 ${pid}`);
        } catch (e) {
          // Process might already be dead
        }
      }

      // Wait for device to be released
      await new Promise((resolve) => setTimeout(resolve, 500));
      console.log("✅ Camera cleanup complete");
    }
  } catch (e) {
    // Camera is free or fuser command failed
  }

  // Use GStreamer for idle preview with overlay settings from streamController
  const config = streamController.streamConfig;

  // Helper function to convert color name to GStreamer integer format
  const colorToInt = (colorName) => {
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
    return colors[colorName?.toLowerCase()] || colors.white;
  };

  const gstArgs = [
    "v4l2src",
    `device=${CAMERA_DEVICE}`,
    "do-timestamp=true",
    "!",
    // Use same resolution as streaming (1920x1080) so overlays look identical
    `image/jpeg,width=${config.width || 1920},height=${config.height || 1080},framerate=${config.framerate || 30}/1`,
    "!",
    "jpegparse",
    "!",
    "mppjpegdec",
    "!",
    "videoconvert",
  ];

  // Always need a ! after videoconvert
  gstArgs.push("!");

  // Add overlays if any individual overlay is enabled (using EXACT same structure as streaming pipeline)
  const hasAnyOverlay = config.overlayEnabled || config.showTimestamp;
  if (hasAnyOverlay) {

    // Add timestamp overlay if enabled (matches streamController.js exactly)
    if (config.showTimestamp) {
      const tsPosition = config.timestampPosition || "bottom-right";
      const [vpos, hpos] = tsPosition.split("-");
      const valign = vpos === "bottom" ? "bottom" : vpos === "center" ? "center" : "top";
      const halign = hpos === "left" ? "left" : hpos === "right" ? "right" : "center";

      // Use EXACT same font size as streaming (scaled by 1.5x for 1920x1080)
      const scaledFontSize = Math.round((config.overlayFontSize || 32) * 1.5);

      const timestampArgs = [
        "clockoverlay",
        `valignment=${valign}`,
        `halignment=${halign}`,
        `font-desc=Sans Bold ${scaledFontSize}`,
        `color=${colorToInt(config.overlayColor)}`,
        `time-format="${config.timestampFormat || '%Y-%m-%d %H:%M:%S'}"`,
      ];

      // Add shaded background based on background setting
      // Note: GStreamer's clockoverlay doesn't support custom opacity, only on/off
      const bgSetting = config.overlayBackground || "transparent";
      if (bgSetting !== "transparent") {
        timestampArgs.push("shaded-background=true");
      }

      timestampArgs.push("xpad=20", "ypad=20", "!");
      gstArgs.push(...timestampArgs);
    }

    // Add custom text overlay 1 (main title) - only if Title checkbox is enabled
    if (config.overlayEnabled && config.overlayText) {
      const position = config.titlePosition || config.overlayPosition || "bottom-left";
      const [vpos, hpos] = position.split("-");
      const valign = vpos === "bottom" ? "bottom" : vpos === "center" ? "center" : "top";
      const halign = hpos === "left" ? "left" : hpos === "right" ? "right" : "center";

      // Use EXACT same font size as streaming (scaled by 1.5x for 1920x1080)
      const scaledFontSize = Math.round((config.overlayFontSize || 32) * 1.5);

      const textArgs = [
        "textoverlay",
        `text="${config.overlayText}"`,
        `valignment=${valign}`,
        `halignment=${halign}`,
        `font-desc=Sans Bold ${scaledFontSize}`,
        `color=${colorToInt(config.overlayColor)}`,
      ];

      // Add shaded background based on background setting
      // Note: GStreamer's textoverlay doesn't support custom opacity, only on/off
      const bgSetting = config.overlayBackground || "transparent";
      if (bgSetting !== "transparent") {
        textArgs.push("shaded-background=true");
      }

      textArgs.push("xpad=20", "ypad=20", "!");
      gstArgs.push(...textArgs);
    }

    // Add custom text overlay 2 (subtitle/secondary text) if provided
    if (config.customText2) {
      const valign = config.overlayPosition === "bottom" ? "bottom" : "center";
      const scaledFontSize = Math.floor((config.overlayFontSize || 32) * 1.5 * 0.75);

      gstArgs.push(
        "textoverlay",
        `text="${config.customText2}"`,
        `valignment=${valign}`,
        "halignment=center",
        `font-desc=Sans ${scaledFontSize}`,
        `color=${colorToInt(config.overlayColor)}`,
        "shaded-background=true",
        "!"
      );
    }

    // Add logo overlay if path provided
    if (config.logoPath) {
      gstArgs.push(
        "gdkpixbufoverlay",
        `location=${config.logoPath}`,
        "offset-x=20",
        "offset-y=20",
        "!"
      );
    }
  }

  // Scale down to 720p, limit to 10fps, and JPEG encode for preview
  gstArgs.push(
    "videorate",
    "!",
    "video/x-raw,framerate=10/1",
    "!",
    "videoscale",
    "!",
    "video/x-raw,width=1280,height=720",
    "!",
    "jpegenc",
    "quality=85",
    "!",
    "multipartmux",
    "boundary=frame",
    "!",
    "fdsink",
    "fd=1"
  );

  console.log(`Starting GStreamer idle preview ${config.overlayEnabled ? "with" : "without"} overlays`);

  const gst = spawn("gst-launch-1.0", gstArgs);

  // Track this as the current idle preview process
  currentIdlePreviewProcess = gst;
  console.log(`📹 Started new idle preview process PID: ${gst.pid}`);

  gst.stdout.on("data", (data) => {
    try {
      res.write(data);
    } catch (err) {
      console.error("Error writing frame:", err.message);
      gst.kill();
    }
  });

  gst.stderr.on("data", (data) => {
    const msg = data.toString();
    // Only log actual errors, not status messages
    if (msg.includes("ERROR") || msg.includes("WARN")) {
      console.error(`GStreamer idle preview: ${msg}`);
    }
  });

  gst.on("close", (code) => {
    console.log(`GStreamer idle preview exited with code ${code}`);
    // Clear the current process if it's this one
    if (currentIdlePreviewProcess === gst) {
      currentIdlePreviewProcess = null;
    }
    res.end();
  });

  gst.on("error", (err) => {
    console.error("Failed to start GStreamer:", err);
    // Clear the current process if it's this one
    if (currentIdlePreviewProcess === gst) {
      currentIdlePreviewProcess = null;
    }
    res.end();
  });

  req.on("close", () => {
    console.log("Client disconnected, killing GStreamer idle preview");
    gst.kill();
    // Process will be cleared in the 'close' event handler
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

  socket.on("setStartupPosition", () => {
    const result = camera.saveStartupPosition();
    socket.emit("startupPositionSet", result);
  });

  socket.on("getStartupPosition", () => {
    const position = camera.loadStartupPosition();
    socket.emit("startupPosition", { position });
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

    // Notify client to refresh preview
    if (result.success) {
      socket.emit("previewRefreshNeeded", {
        message: "Stream stopped. Refresh the page to restart the preview.",
      });
    }
  });

  socket.on("getStreamStatus", () => {
    const status = streamController.getStatus();
    socket.emit("streamStatus", status);
  });

  socket.on("updateStreamConfig", (config) => {
    const result = streamController.updateConfig(config);
    socket.emit("streamResult", result);
  });

  socket.on("updateOverlay", async (overlayConfig) => {
    const result = streamController.updateOverlay(overlayConfig);

    // Also update gameState with overlay configuration for node-graphics-stream.js
    if (overlayConfig.overlayFontSize !== undefined) {
      gameState.overlayFontSize = overlayConfig.overlayFontSize;
    }
    if (overlayConfig.overlayColor !== undefined) {
      gameState.overlayColor = overlayConfig.overlayColor;
    }
    if (overlayConfig.overlayBackground !== undefined) {
      gameState.overlayBackground = overlayConfig.overlayBackground;
    }

    // Handle remote overlay enable/disable
    if (puppeteerOverlay) {
      const wantsRemote = overlayConfig.remoteOverlayEnabled &&
        overlayConfig.overlayUrl && overlayConfig.overlayUrl.trim();
      if (wantsRemote) {
        // Enable remote overlay
        if (!puppeteerOverlay.isRunning) {
          await puppeteerOverlay.initialize(PORT);
        }
        puppeteerOverlay.setOverlayUrl(overlayConfig.overlayUrl);
        puppeteerOverlay.startPeriodicRefresh();
      } else if (overlayConfig.remoteOverlayEnabled === false) {
        // Remote overlay was explicitly turned off — clear the PNG
        puppeteerOverlay.setOverlayUrl(null);
      }
    }

    // Write updated state to JSON file
    regenerateOverlay();

    socket.emit("overlayResult", result);
  });

  // ============ SCOREBOARD SOCKET EVENTS ============

  socket.on("updateScore", (data) => {
    console.log(`📊 Updating scoreboard:`, data);

    // Update game state
    if (data.player1Name !== undefined) gameState.player1Name = data.player1Name;
    if (data.player2Name !== undefined) gameState.player2Name = data.player2Name;
    if (data.player1Score !== undefined) gameState.player1Score = data.player1Score;
    if (data.player2Score !== undefined) gameState.player2Score = data.player2Score;
    if (data.matchTitle !== undefined) gameState.matchTitle = data.matchTitle;

    // Regenerate the PNG overlay
    regenerateOverlay();

    // Broadcast to all clients
    io.emit("scoreUpdated", gameState);
    socket.emit("scoreResult", { success: true, gameState });
  });

  socket.on("getScore", () => {
    socket.emit("scoreResult", { success: true, gameState });
  });

  // ============ END SCOREBOARD SOCKET EVENTS ============

  // ============ END STREAMING SOCKET EVENTS ============

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

server.listen(PORT, async () => {
  console.log(`Camera control server running on port ${PORT}`);
  console.log(`Camera device: ${CAMERA_DEVICE}`);
  console.log(`Access the interface at http://localhost:${PORT}`);

  // Clean up any processes using the camera before starting
  console.log("\n🧹 Cleaning up camera resources...");
  try {
    const { execSync } = require("child_process");

    // Kill any GStreamer processes first
    try {
      console.log("Checking for GStreamer processes...");
      const gstProcesses = execSync("pgrep -f gst-launch", {
        encoding: "utf-8",
      }).trim();

      if (gstProcesses) {
        const pids = gstProcesses.split("\n").filter((p) => p);
        for (const pid of pids) {
          console.log(`Killing GStreamer process ${pid}...`);
          try {
            execSync(`kill -9 ${pid}`);
          } catch (e) {
            // Process might already be dead
          }
        }
        console.log("✅ GStreamer processes killed");
      }
    } catch (e) {
      // No GStreamer processes found
      console.log("✅ No GStreamer processes found");
    }

    // Kill any FFmpeg processes using the camera
    try {
      console.log("Checking for FFmpeg processes...");
      const ffmpegProcesses = execSync(
        `ps aux | grep ffmpeg | grep ${CAMERA_DEVICE} | grep -v grep | awk '{print $2}'`,
        { encoding: "utf-8" },
      ).trim();

      if (ffmpegProcesses) {
        const pids = ffmpegProcesses.split("\n").filter((p) => p);
        for (const pid of pids) {
          console.log(`Killing FFmpeg process ${pid}...`);
          try {
            execSync(`kill -9 ${pid}`);
          } catch (e) {
            // Process might already be dead
          }
        }
        console.log("✅ FFmpeg processes killed");
      }
    } catch (e) {
      // No FFmpeg processes found
      console.log("✅ No FFmpeg processes found");
    }

    // Final check: kill any remaining processes using the camera device
    try {
      const fuserOutput = execSync(`fuser ${CAMERA_DEVICE} 2>&1`, {
        encoding: "utf-8",
      });
      console.log("fuser output:", fuserOutput);

      if (fuserOutput.includes(":")) {
        const pids = fuserOutput
          .split(":")[1]
          .trim()
          .split(/\s+/)
          .map((p) => p.replace(/\D/g, ""))
          .filter((p) => p);

        for (const pid of pids) {
          console.log(`Killing process ${pid} using camera...`);
          try {
            execSync(`kill -9 ${pid}`);
          } catch (e) {
            // Process might already be dead
          }
        }
      }
    } catch (e) {
      // No processes using camera
    }

    // Wait for device to be released
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log("✅ Camera resources cleaned up");
  } catch (error) {
    console.log("⚠️  Error during cleanup:", error.message);
  }

  // Apply saved camera configuration on startup
  console.log("\n🚀 Initializing camera with saved configuration...");
  try {
    // Activate the camera device first
    await camera.activateCamera();

    // Start a temporary stream to wake up the camera for PTZ commands
    console.log("📹 Starting temporary stream to activate camera PTZ...");
    const { spawn } = require("child_process");
    const tempStream = spawn("gst-launch-1.0", [
      "v4l2src",
      `device=${CAMERA_DEVICE}`,
      "num-buffers=60",
      "!",
      "image/jpeg,width=1280,height=720,framerate=30/1",
      "!",
      "fakesink",
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

    // Apply non-PTZ config settings (brightness, contrast, etc.)
    await camera.applyConfig();

    // Apply startup position for PTZ (if set), overriding last known position
    const usedStartup = await camera.applyStartupPosition();
    if (usedStartup) {
      console.log("📌 Applied startup position (overrides last known PTZ position)");
    } else {
      console.log("📌 No startup position set, using last saved PTZ position from config");
    }

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

    // Stop the temporary stream and wait for it to actually exit
    console.log("🛑 Stopping temporary stream...");
    tempStream.kill("SIGTERM");
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log("⚠️  Temporary stream didn't exit gracefully, sending SIGKILL...");
        tempStream.kill("SIGKILL");
        resolve();
      }, 3000);
      tempStream.on("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    // Extra wait for the kernel to release the device
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log("✅ Temporary stream stopped");

    // Sync pan/tilt position with actual camera position
    console.log("📍 Syncing pan/tilt position...");
    await camera.syncPosition();

    cameraInitialized = true;
    console.log("✅ Camera initialized successfully\n");
  } catch (error) {
    console.error("❌ Error initializing camera:", error.message);
    cameraInitialized = true; // Allow commands even if init failed
  }

  // Initialize stream controller (auto-start if configured)
  try {
    await streamController.initialize();
  } catch (error) {
    console.error("❌ Error initializing stream controller:", error.message);
  }
});

// Proxy routes for digitalpool.com (MUST be last to not interfere with our API routes)

// Add CORS headers to all responses
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

app.use("/fonts", (req, res) => {
  const targetUrl = `https://digitalpool.com${req.originalUrl}`;
  console.log("Proxying /fonts request:", req.originalUrl, "->", targetUrl);
  proxyUrl(targetUrl, res, req);
});

app.use("/static", (req, res) => {
  const targetUrl = `https://digitalpool.com${req.originalUrl}`;
  console.log("Proxying /static request:", req.originalUrl, "->", targetUrl);
  proxyUrl(targetUrl, res, req);
});

app.use("/tournaments", (req, res) => {
  const targetUrl = `https://digitalpool.com${req.originalUrl}`;
  console.log(
    "Proxying /tournaments request:",
    req.originalUrl,
    "->",
    targetUrl,
  );
  proxyUrl(targetUrl, res, req);
});

// Proxy for version.json
app.get("/version.json", (req, res) => {
  const targetUrl = `https://digitalpool.com/version.json`;
  console.log("Proxying /version.json request");
  proxyUrl(targetUrl, res, req);
});

// Proxy for favicon
app.get("/favicon.ico", (req, res) => {
  const targetUrl = `https://digitalpool.com/favicon.ico`;
  console.log("Proxying /favicon.ico request");
  proxyUrl(targetUrl, res, req);
});

// Proxy for GraphQL and other API endpoints
// Use the actual production API endpoint
app.use("/graphql", (req, res) => {
  const targetUrl = `https://api-prod.digitalpool.com/v1/graphql`;
  console.log("Proxying /graphql request:", req.originalUrl, "->", targetUrl);
  proxyUrl(targetUrl, res, req);
});

// ============================================================================
// Graphics Overlay Integration
// ============================================================================

// Start Puppeteer overlay BEFORE GStreamer starts (during "preparing" phase)
// This ensures the PNG file exists when gdkpixbufoverlay tries to load it
streamController.on("preparing", async () => {
  // Kill idle preview process first — it holds the camera device open
  if (currentIdlePreviewProcess && !currentIdlePreviewProcess.killed) {
    console.log("🛑 Killing idle preview before starting stream...");
    currentIdlePreviewProcess.kill("SIGTERM");
    currentIdlePreviewProcess = null;
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log("✅ Idle preview killed");
  }

  const hasUrlOverlay = streamController.streamConfig.remoteOverlayEnabled &&
    streamController.streamConfig.overlayUrl && streamController.streamConfig.overlayUrl.trim();
  const needsGraphicsOverlay = streamController.streamConfig.skiaGraphicsEnabled || hasUrlOverlay;

  if (needsGraphicsOverlay) {
    console.log(`🎨 Preparing overlay (HTML → PNG)...`);

    try {
      // Initialize overlay renderer if not already running
      if (!puppeteerOverlay) {
        puppeteerOverlay = new PuppeteerOverlay();
      }

      if (!puppeteerOverlay.isRunning) {
        await puppeteerOverlay.initialize(PORT);
      }

      // Check if a remote overlay URL is configured
      const overlayUrl = streamController.streamConfig.overlayUrl;
      if (overlayUrl && overlayUrl.trim()) {
        // URL mode: screenshot a remote page that has its own JS to fetch scores
        const overlayZoom = streamController.streamConfig.overlayZoom || 100;
        console.log(`🌍 Using remote overlay URL: ${overlayUrl} (zoom: ${overlayZoom}%)`);
        puppeteerOverlay.setOverlayUrl(overlayUrl, { zoom: overlayZoom });
        puppeteerOverlay.startPeriodicRefresh();
      } else {
        // Local mode: generate HTML with baked-in game state
        puppeteerOverlay.setOverlayUrl(null); // Ensure URL mode is off
        await puppeteerOverlay.updateState(gameState);
      }
      console.log("✅ Overlay PNG ready for GStreamer");
    } catch (err) {
      console.error("❌ Failed to prepare overlay:", err.message);
    }
  }
});

// Stop periodic refresh when stream stops, but keep renderer ready
streamController.on("stopped", async () => {
  if (puppeteerOverlay) {
    puppeteerOverlay._stopPeriodicRefresh();
  }
  console.log("ℹ️  Stream stopped (overlay renderer stays ready for next stream)");
});


// Graceful shutdown - close Puppeteer browser
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down...");
  if (puppeteerOverlay) {
    await puppeteerOverlay.stop();
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 Shutting down...");
  if (puppeteerOverlay) {
    await puppeteerOverlay.stop();
  }
  process.exit(0);
});