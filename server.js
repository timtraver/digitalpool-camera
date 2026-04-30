require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const session = require("express-session");
const { spawn, exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const fsSync = require("fs");
const path = require("path");
const os = require("os");
const CameraController = require("./cameraController");
const StreamController = require("./streamController");
const WifiManager = require("./wifiManager");
const authManager = require("./authManager");

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
const DEFAULT_AP_IP = process.env.AP_IP || "192.168.50.1";
const HOTSPOT_SUBNET = process.env.HOTSPOT_SUBNET || "192.168.50.";

// ── Session middleware ────────────────────────────────────────────────────────
// Use SESSION_SECRET from .env; fall back to a random secret (regenerated each
// restart — existing sessions are invalidated on restart, which is acceptable
// for an embedded device).  Set SESSION_SECRET in .env for persistence.
const sessionMiddleware = session({
  secret:            process.env.SESSION_SECRET || require("crypto").randomBytes(32).toString("hex"),
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge:   24 * 60 * 60 * 1000, // 24 hours
    sameSite: "lax",
  },
});
app.use(sessionMiddleware);

// Share the session with Socket.IO so we can check auth on WS connections
io.use((socket, next) => sessionMiddleware(socket.request, socket.request.res || {}, next));

// ── Auth guard helpers ────────────────────────────────────────────────────────
// File extensions that are always served publicly (CSS, JS, images).
// Protecting them gains nothing because they contain no sensitive data.
const PUBLIC_EXTENSIONS = new Set([".css", ".js", ".png", ".jpg", ".jpeg", ".svg", ".ico", ".woff", ".woff2", ".map"]);

function isHotspotRequest(req) {
  // Requests arriving from the WiFi hotspot subnet skip authentication so that
  // venue staff connecting to the AP can reach the interface without credentials.
  const ip = req.ip || req.connection?.remoteAddress || "";
  return ip.includes(HOTSPOT_SUBNET);
}

function requireAuth(req, res, next) {
  // MediaMTX auth hook — called from localhost by MediaMTX, never needs a session
  if (req.path === "/api/mediamtx/auth") return next();
  // Health-check — used by the update poller to detect when the server is back up
  if (req.path === "/api/status") return next();

  if (isHotspotRequest(req))          return next();   // hotspot bypass
  if (req.session && req.session.user) return next();  // logged-in session

  const ext = path.extname(req.path);
  if (ext && PUBLIC_EXTENSIONS.has(ext)) return next(); // safe static assets

  // Unauthenticated
  if (req.path.startsWith("/api/") || req.path.startsWith("/video/")) {
    return res.status(401).json({ error: "Unauthorized", redirect: "/login" });
  }
  return res.redirect("/login");
}

// Initialize camera controller
const camera = new CameraController(CAMERA_DEVICE);

// Flag to track if camera is fully initialized
let cameraInitialized = false;
// Flag to prevent /video/stream from spawning idle preview during boot
let bootComplete = false;
// Flag to suppress intermediate "stopped" events during an atomic restart
let isRestartInProgress = false;

// Initialize stream controller
const streamController = new StreamController(CAMERA_DEVICE);

// Initialize WiFi Manager — always-on AP hotspot
const wifiManager = new WifiManager();
wifiManager.initialize()
  .then(ok => ok
    ? console.log("✅ WiFi AP hotspot initialised")
    : console.warn("⚠️  WiFi AP not available (no wireless interface or nmcli missing)"))
  .catch(err => console.error("❌ WiFi Manager init error:", err.message));

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
  // Never render local scoreboard HTML when remote overlay is active —
  // the remote URL page handles its own rendering via Puppeteer periodic refresh
  const isRemote = streamController.streamConfig.remoteOverlayEnabled &&
    streamController.streamConfig.overlayUrl && streamController.streamConfig.overlayUrl.trim();
  if (!isRemote && puppeteerOverlay && puppeteerOverlay.isRunning) {
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
streamController.on("preparing", () => {
  const status = streamController.getStatus();
  io.emit("streamStatus", { ...status, status: "preparing" });
});

streamController.on("started", () => {
  const status = streamController.getStatus();
  io.emit("streamStatus", { ...status, status: "started" });
});

streamController.on("stopped", (code) => {
  // During an atomic restart don't tell clients the stream stopped —
  // they will see "restarting" → "preparing" → "started" instead.
  if (isRestartInProgress) return;
  const status = streamController.getStatus();
  io.emit("streamStatus", { ...status, status: "stopped", code });
  io.emit("streamDrift",  { ppm: null }); // clear drift display
});

streamController.on("error", (error) => {
  io.emit("streamError", { error });
});

streamController.on("log", (log) => {
  console.log("Stream log:", log);
});

streamController.on("fps", (fps) => {
  io.emit("streamFps", { fps }); // fps is null when stream stops
});

streamController.on("bitrate", (mbps) => {
  io.emit("streamBitrate", { mbps }); // mbps is null when stream stops
});

streamController.on("drift", (ppm) => {
  io.emit("streamDrift", { ppm });
});

// ── CPU load broadcasting ─────────────────────────────────────────────────────
// Reads /proc/stat every 2 seconds and broadcasts the CPU usage percentage
// to all connected clients via socket.
let _prevCpuIdle = null;
let _prevCpuTotal = null;

function readCpuPercent() {
  try {
    const stat = fsSync.readFileSync("/proc/stat", "utf8");
    const vals = stat.split("\n")[0].split(/\s+/).slice(1).map(Number);
    // Fields: user nice system idle iowait irq softirq steal guest guest_nice
    const idle  = vals[3] + (vals[4] || 0); // idle + iowait
    const total = vals.reduce((a, b) => a + b, 0);
    if (_prevCpuIdle !== null) {
      const idleDelta  = idle  - _prevCpuIdle;
      const totalDelta = total - _prevCpuTotal;
      _prevCpuIdle  = idle;
      _prevCpuTotal = total;
      return totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;
    }
    _prevCpuIdle  = idle;
    _prevCpuTotal = total;
    return null; // first read — no delta yet
  } catch (_) { return null; }
}

setInterval(() => {
  const percent = readCpuPercent();
  if (percent !== null) io.emit("cpuLoad", { percent });
}, 2000);

// ── Captive portal detection ──────────────────────────────────────────────
// When a device connects to the DigitalPool-Camera hotspot it has no
// internet, so the OS fires a connectivity probe to a well-known URL on
// port 80.  iptables PREROUTING redirects that traffic to port 3000 where
// these routes catch it and redirect the device's captive-portal browser
// to the admin UI.  Supported platforms:
//   iOS / macOS  → /hotspot-detect.html  (captive.apple.com)
//   Android      → /generate_204, /gen_204
//   Windows NCSI → /ncsi.txt, /connecttest.txt, /redirect
//   Amazon Fire  → /kindle-wifi/wifistub.html
const CAPTIVE_PORTAL_URL = `http://${DEFAULT_AP_IP}:${PORT}`;

function _sendCaptiveRedirect(req, res, next) {
  // Only intercept when the request arrived via the WiFi AP interface
  // (local socket address is 192.168.50.1).  Requests coming in over
  // Ethernet or any other interface fall through normally so they are
  // never affected by the captive portal logic.
  const localAddr = req.socket.localAddress || '';
  if (!localAddr.includes(DEFAULT_AP_IP)) return next();

  // 302 redirect causes every OS captive-portal browser to follow it and
  // land on the admin UI.  We also set the standard portal header so that
  // RFC 8908-aware clients know a portal is present.
  res
    .set('Cache-Control', 'no-store')
    .set('X-Captive-Portal', CAPTIVE_PORTAL_URL)
    .redirect(302, CAPTIVE_PORTAL_URL);
}

// Apple probes (iOS 6+, macOS)
app.get('/hotspot-detect.html',          _sendCaptiveRedirect);
app.get('/library/test/success.html',    _sendCaptiveRedirect);
app.get('/success.html',                 _sendCaptiveRedirect);
// Android / Chrome probes
app.get('/generate_204',                 _sendCaptiveRedirect);
app.get('/gen_204',                      _sendCaptiveRedirect);
// Windows NCSI probes
app.get('/ncsi.txt',                     _sendCaptiveRedirect);
app.get('/connecttest.txt',              _sendCaptiveRedirect);
app.get('/redirect',                     _sendCaptiveRedirect);
// Amazon Kindle / Fire OS
app.get('/kindle-wifi/wifistub.html',    _sendCaptiveRedirect);
// ─────────────────────────────────────────────────────────────────────────

// ── Public auth routes (no requireAuth guard) ────────────────────────────────
// Login page — serve the standalone HTML file directly
app.get("/login", (req, res) => {
  if (isHotspotRequest(req)) return res.redirect("/"); // hotspot: skip login
  if (req.session?.user)     return res.redirect("/"); // already logged in
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/api/auth/login", express.json(), async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Username and password are required" });
  try {
    const ok = await authManager.verifyPassword(username, password);
    if (!ok) return res.status(401).json({ error: "Invalid username or password" });
    const user = authManager.findUser(username);
    req.session.user = { username: user.username, role: user.role, forcePasswordChange: user.forcePasswordChange };
    req.session.save(() => res.json({ success: true, user: req.session.user }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/api/auth/me", (req, res) => {
  if (isHotspotRequest(req)) return res.json({ user: { username: "hotspot", role: "admin", hotspot: true } });
  if (!req.session?.user)    return res.status(401).json({ error: "Unauthorized" });
  res.json({ user: req.session.user });
});

// ── Apply auth guard to everything below ────────────────────────────────────
app.use(requireAuth);

// ── Static files (guarded — index.html requires auth, assets pass through) ──
app.use(express.static("public"));
app.use(express.json());

// ── User management API (admin only) ─────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (isHotspotRequest(req)) return next(); // hotspot users are implicitly admin
  if (req.session?.user?.role === "admin") return next();
  res.status(403).json({ error: "Admin access required" });
}

app.get("/api/users", requireAdmin, (req, res) => {
  res.json({ users: authManager.listUsers() });
});

app.post("/api/users", requireAdmin, express.json(), async (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    const user = await authManager.addUser(username, password, role);
    res.json({ success: true, user });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/users/:username", requireAdmin, async (req, res) => {
  try {
    const target = req.params.username;
    if (target === req.session?.user?.username)
      return res.status(400).json({ error: "You cannot delete your own account" });
    authManager.deleteUser(target);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put("/api/users/:username/role", requireAdmin, express.json(), async (req, res) => {
  try {
    authManager.updateRole(req.params.username, req.body.role);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Any authenticated user may change their own password; admin may change anyone's
app.put("/api/users/:username/password", express.json(), async (req, res) => {
  const { username } = req.params;
  const { oldPassword, newPassword } = req.body || {};
  const caller = req.session?.user;
  const isAdmin = isHotspotRequest(req) || caller?.role === "admin";
  // Non-admin can only change their own password
  if (!isAdmin && caller?.username !== username)
    return res.status(403).json({ error: "Forbidden" });
  try {
    // Non-admin must supply current password
    await authManager.changePassword(username, newPassword, !isAdmin, oldPassword);
    // Update session if user changed their own password
    if (req.session?.user?.username === username) {
      req.session.user.forcePasswordChange = false;
      req.session.save();
    }
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Remote Access (Tailscale) API ── admin only ─────────────────────────────
const REMOTE_CONFIG_FILE = path.join(__dirname, "remote.json");

function loadRemoteConfig() {
  try {
    if (fsSync.existsSync(REMOTE_CONFIG_FILE))
      return JSON.parse(fsSync.readFileSync(REMOTE_CONFIG_FILE, "utf8"));
  } catch (e) { /* ignore */ }
  return { deviceName: "", enabled: false };
}

function saveRemoteConfig(cfg) {
  fsSync.writeFileSync(REMOTE_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

app.get("/api/remote/status", requireAdmin, async (req, res) => {
  const cfg = loadRemoteConfig();
  try {
    // tailscale status --json gives us everything we need
    const { stdout } = await execAsync("tailscale status --json 2>/dev/null");
    const ts = JSON.parse(stdout);
    const ip  = ts.TailscaleIPs?.[0] || null;
    const up  = ts.BackendState === "Running";
    res.json({ enabled: up, ip, deviceName: cfg.deviceName, backendState: ts.BackendState });
  } catch {
    // tailscale not installed or not running yet
    res.json({ enabled: false, ip: null, deviceName: cfg.deviceName, backendState: "Stopped" });
  }
});

app.post("/api/remote/enable", requireAdmin, express.json(), async (req, res) => {
  const cfg = loadRemoteConfig();
  const name = (req.body?.deviceName || cfg.deviceName || "digitalpool-camera")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  cfg.deviceName = name;
  cfg.enabled    = true;
  saveRemoteConfig(cfg);
  try {
    const loginServer = process.env.HEADSCALE_URL || "";
    const authKey     = process.env.HEADSCALE_AUTHKEY || "";

    // Build the tailscale up command.
    // With a Headscale pre-auth key, registration is fully automatic — no auth URL needed.
    let upCmd = `sudo tailscale up --hostname=${name} --accept-routes --timeout=15s`;
    if (loginServer) upCmd += ` --login-server=${loginServer}`;
    if (authKey)     upCmd += ` --authkey=${authKey}`;

    try {
      await execAsync(upCmd);
    } catch (e) {
      // Non-zero exit is sometimes returned even on success (e.g. "already running")
      // so we fall through and check the IP rather than failing immediately.
      console.warn("tailscale up warning:", e.stderr || e.message);
    }

    // Give tailscale a moment to get an IP
    await new Promise(r => setTimeout(r, 2000));
    const { stdout: ipOut } = await execAsync("tailscale ip --4 2>/dev/null").catch(() => ({ stdout: "" }));
    const ip = ipOut.trim();
    if (ip) {
      res.json({ success: true, ip, deviceName: name });
    } else {
      res.status(500).json({ error: "Tailscale started but could not get IP. Check service logs." });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/remote/disable", requireAdmin, async (req, res) => {
  const cfg = loadRemoteConfig();
  cfg.enabled = false;
  saveRemoteConfig(cfg);
  try {
    await execAsync("sudo tailscale down");
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/remote/name", requireAdmin, express.json(), async (req, res) => {
  const name = (req.body?.deviceName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!name) return res.status(400).json({ error: "Device name is required" });
  const cfg = loadRemoteConfig();
  cfg.deviceName = name;
  saveRemoteConfig(cfg);
  // If tailscale is running, update the hostname live
  try {
    const { stdout } = await execAsync("tailscale status --json 2>/dev/null");
    const ts = JSON.parse(stdout);
    if (ts.BackendState === "Running") {
      await execAsync(`sudo tailscale set --hostname=${name}`);
    }
  } catch { /* tailscale not running — name saved for next enable */ }
  res.json({ success: true, deviceName: name });
});

// Helper function to proxy any URL
function proxyUrl(targetUrl, res, req = null) {
  const https = require("https");
  const http = require("http");

  const parsedUrl = new URL(targetUrl);
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
      path: parsedUrl.pathname + parsedUrl.search,
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


// API endpoint to check server status
app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    camera_device: CAMERA_DEVICE,
    timestamp: new Date().toISOString(),
  });
});

// API endpoint to return software version from package.json
app.get("/api/version", (req, res) => {
  try {
    const pkg = JSON.parse(fsSync.readFileSync(path.join(__dirname, "package.json"), "utf8"));
    res.json({ version: pkg.version || "unknown" });
  } catch {
    res.json({ version: "unknown" });
  }
});

// API endpoint to pull latest code and restart the service (dpadmin only)
// The server calls process.exit(0) after responding; systemd Restart=always brings it back.
app.post("/api/update", requireAdmin, async (req, res) => {
  if (req.session?.user?.username !== "dpadmin")
    return res.status(403).json({ success: false, error: "Access denied" });
  try {
    const { stdout, stderr } = await execAsync("git pull", { cwd: __dirname });
    const output = (stdout || "").trim() || (stderr || "").trim() || "No output";
    res.json({ success: true, output });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
  // Give the response time to flush, then exit — systemd will restart the process
  setTimeout(() => {
    console.log("🔄 Software update requested — restarting service via process.exit");
    process.exit(0);
  }, 800);
});

// ── Timezone API (admin only) ─────────────────────────────────────────────────
// Curated list of common timezones grouped by region.
// Each entry: { value: IANA name, label: human-friendly display }
const COMMON_TIMEZONES = [
  // ── United States ──────────────────────────────────────────────
  { value: "America/New_York",       label: "Eastern Time (New York)" },
  { value: "America/Chicago",        label: "Central Time (Chicago)" },
  { value: "America/Denver",         label: "Mountain Time (Denver)" },
  { value: "America/Phoenix",        label: "Mountain Time – no DST (Phoenix)" },
  { value: "America/Los_Angeles",    label: "Pacific Time (Los Angeles)" },
  { value: "America/Anchorage",      label: "Alaska Time (Anchorage)" },
  { value: "Pacific/Honolulu",       label: "Hawaii Time (Honolulu)" },
  { value: "America/Indiana/Indianapolis", label: "Eastern Time – no DST (Indianapolis)" },
  // ── Canada ─────────────────────────────────────────────────────
  { value: "America/Halifax",        label: "Atlantic Time (Halifax)" },
  { value: "America/Toronto",        label: "Eastern Time (Toronto)" },
  { value: "America/Winnipeg",       label: "Central Time (Winnipeg)" },
  { value: "America/Edmonton",       label: "Mountain Time (Edmonton)" },
  { value: "America/Vancouver",      label: "Pacific Time (Vancouver)" },
  { value: "America/St_Johns",       label: "Newfoundland Time (St. John's)" },
  // ── Mexico / Central America ────────────────────────────────────
  { value: "America/Mexico_City",    label: "Central Time (Mexico City)" },
  { value: "America/Monterrey",      label: "Central Time (Monterrey)" },
  { value: "America/Tijuana",        label: "Pacific Time (Tijuana)" },
  { value: "America/Guatemala",      label: "Central America (Guatemala)" },
  { value: "America/Costa_Rica",     label: "Central America (Costa Rica)" },
  { value: "America/Panama",         label: "Eastern – no DST (Panama)" },
  // ── Caribbean ──────────────────────────────────────────────────
  { value: "America/Puerto_Rico",    label: "Atlantic – no DST (Puerto Rico)" },
  { value: "America/Havana",         label: "Cuba (Havana)" },
  { value: "America/Jamaica",        label: "Eastern – no DST (Jamaica)" },
  // ── South America ───────────────────────────────────────────────
  { value: "America/Bogota",         label: "Colombia (Bogotá)" },
  { value: "America/Lima",           label: "Peru (Lima)" },
  { value: "America/Caracas",        label: "Venezuela (Caracas)" },
  { value: "America/Santiago",       label: "Chile (Santiago)" },
  { value: "America/Argentina/Buenos_Aires", label: "Argentina (Buenos Aires)" },
  { value: "America/Sao_Paulo",      label: "Brazil – East (São Paulo)" },
  { value: "America/Manaus",         label: "Brazil – West (Manaus)" },
  // ── Europe ──────────────────────────────────────────────────────
  { value: "UTC",                    label: "UTC (Coordinated Universal Time)" },
  { value: "Europe/London",          label: "GMT/BST (London)" },
  { value: "Europe/Dublin",          label: "GMT/IST (Dublin)" },
  { value: "Europe/Lisbon",          label: "WET (Lisbon)" },
  { value: "Europe/Paris",           label: "CET (Paris)" },
  { value: "Europe/Berlin",          label: "CET (Berlin)" },
  { value: "Europe/Madrid",          label: "CET (Madrid)" },
  { value: "Europe/Rome",            label: "CET (Rome)" },
  { value: "Europe/Amsterdam",       label: "CET (Amsterdam)" },
  { value: "Europe/Brussels",        label: "CET (Brussels)" },
  { value: "Europe/Zurich",          label: "CET (Zurich)" },
  { value: "Europe/Vienna",          label: "CET (Vienna)" },
  { value: "Europe/Stockholm",       label: "CET (Stockholm)" },
  { value: "Europe/Warsaw",          label: "CET (Warsaw)" },
  { value: "Europe/Prague",          label: "CET (Prague)" },
  { value: "Europe/Budapest",        label: "CET (Budapest)" },
  { value: "Europe/Athens",          label: "EET (Athens)" },
  { value: "Europe/Bucharest",       label: "EET (Bucharest)" },
  { value: "Europe/Helsinki",        label: "EET (Helsinki)" },
  { value: "Europe/Kyiv",            label: "EET (Kyiv)" },
  { value: "Europe/Istanbul",        label: "Turkey Time (Istanbul)" },
  { value: "Europe/Moscow",          label: "Moscow Time (Moscow)" },
  // ── Africa ──────────────────────────────────────────────────────
  { value: "Africa/Casablanca",      label: "WET (Casablanca)" },
  { value: "Africa/Cairo",           label: "EET (Cairo)" },
  { value: "Africa/Lagos",           label: "WAT (Lagos)" },
  { value: "Africa/Nairobi",         label: "EAT (Nairobi)" },
  { value: "Africa/Johannesburg",    label: "SAST (Johannesburg)" },
  // ── Middle East ─────────────────────────────────────────────────
  { value: "Asia/Jerusalem",         label: "Israel Time (Jerusalem)" },
  { value: "Asia/Beirut",            label: "EET (Beirut)" },
  { value: "Asia/Riyadh",            label: "AST (Riyadh)" },
  { value: "Asia/Dubai",             label: "GST (Dubai)" },
  { value: "Asia/Tehran",            label: "IRST (Tehran)" },
  { value: "Asia/Baghdad",           label: "AST (Baghdad)" },
  // ── South & Central Asia ────────────────────────────────────────
  { value: "Asia/Baku",              label: "AZT (Baku)" },
  { value: "Asia/Karachi",           label: "PKT (Karachi)" },
  { value: "Asia/Kolkata",           label: "IST (India – Kolkata)" },
  { value: "Asia/Kathmandu",         label: "NPT (Kathmandu)" },
  { value: "Asia/Dhaka",             label: "BST (Dhaka)" },
  { value: "Asia/Almaty",            label: "ALMT (Almaty)" },
  { value: "Asia/Yangon",            label: "MMT (Yangon)" },
  // ── East & Southeast Asia ───────────────────────────────────────
  { value: "Asia/Bangkok",           label: "ICT (Bangkok)" },
  { value: "Asia/Jakarta",           label: "WIB (Jakarta)" },
  { value: "Asia/Singapore",         label: "SGT (Singapore)" },
  { value: "Asia/Kuala_Lumpur",      label: "MYT (Kuala Lumpur)" },
  { value: "Asia/Hong_Kong",         label: "HKT (Hong Kong)" },
  { value: "Asia/Shanghai",          label: "CST (Shanghai)" },
  { value: "Asia/Taipei",            label: "CST (Taipei)" },
  { value: "Asia/Manila",            label: "PHT (Manila)" },
  { value: "Asia/Seoul",             label: "KST (Seoul)" },
  { value: "Asia/Tokyo",             label: "JST (Tokyo)" },
  // ── Australia & Pacific ─────────────────────────────────────────
  { value: "Australia/Perth",        label: "AWST (Perth)" },
  { value: "Australia/Darwin",       label: "ACST (Darwin)" },
  { value: "Australia/Adelaide",     label: "ACST/ACDT (Adelaide)" },
  { value: "Australia/Brisbane",     label: "AEST – no DST (Brisbane)" },
  { value: "Australia/Sydney",       label: "AEST/AEDT (Sydney)" },
  { value: "Australia/Melbourne",    label: "AEST/AEDT (Melbourne)" },
  { value: "Pacific/Auckland",       label: "NZST/NZDT (Auckland)" },
  { value: "Pacific/Fiji",           label: "FJT (Fiji)" },
  { value: "Pacific/Guam",           label: "ChST (Guam)" },
];

app.get("/api/timezone", requireAdmin, async (req, res) => {
  try {
    const tzRes  = await execAsync("timedatectl show --property=Timezone --value 2>/dev/null");
    const current = tzRes.stdout.trim();
    res.json({ success: true, current, timezones: COMMON_TIMEZONES });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/timezone", requireAdmin, express.json(), async (req, res) => {
  const tz = (req.body?.timezone || "").trim();
  if (!tz) return res.status(400).json({ success: false, error: "Timezone is required" });
  // Allow only safe timezone characters (e.g. America/New_York, UTC+5:30)
  if (!/^[A-Za-z0-9/_+\-:]+$/.test(tz))
    return res.status(400).json({ success: false, error: "Invalid timezone format" });
  try {
    await execAsync(`sudo timedatectl set-timezone "${tz}"`);
    console.log(`🕐 Timezone set to: ${tz}`);
    res.json({ success: true, timezone: tz });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
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

// ============ WIFI / HOTSPOT API ENDPOINTS ============

// Get WiFi + AP status
app.get("/api/wifi/status", async (req, res) => {
  try {
    const status = await wifiManager.getStatus();
    res.json({ success: true, ...status });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Scan for nearby WiFi networks
app.get("/api/wifi/networks", async (req, res) => {
  try {
    const networks = await wifiManager.scanNetworks();
    res.json({ success: true, networks });
  } catch (err) {
    res.json({ success: false, error: err.message, networks: [] });
  }
});

// Connect to a WiFi network (client mode, AP stays running)
app.post("/api/wifi/connect", express.json(), async (req, res) => {
  const { ssid, password } = req.body || {};
  if (!ssid) return res.json({ success: false, error: "ssid is required" });
  try {
    const result = await wifiManager.connectToNetwork(ssid, password);
    res.json(result);
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Disconnect from current client WiFi network
app.post("/api/wifi/disconnect", async (req, res) => {
  try {
    const result = await wifiManager.disconnectFromNetwork();
    res.json(result);
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Update AP SSID / password (and restart the hotspot)
app.post("/api/wifi/ap/config", express.json(), async (req, res) => {
  const { ssid, password } = req.body || {};
  if (!ssid && !password)
    return res.json({ success: false, error: "Provide ssid and/or password" });
  if (password && password.length < 8)
    return res.json({ success: false, error: "Password must be at least 8 characters" });
  try {
    await wifiManager.updateAPConfig({ ssid, password });
    const status = await wifiManager.getStatus();
    res.json({ success: true, ...status });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ============ ETHERNET / IP CONFIG API ============
// Ubuntu 24.04 manages wired ethernet via netplan → systemd-networkd, not
// NetworkManager. The ethernet interface (end1) shows as "unmanaged" in nmcli.
// We write a dedicated netplan override file and run `netplan apply` instead.

const NETPLAN_ETH_FILE = '/etc/netplan/99-digitalpool-ethernet.yaml';
const ETH_CONFIG_FILE  = path.join(__dirname, 'ethernet-config.json');

/**
 * Find the ethernet interface name.
 * Tries nmcli device status first (type == 'ethernet'), then falls back to
 * os.networkInterfaces() matching common ethernet name patterns.
 */
async function _findEthernetIface() {
  try {
    const { stdout } = await execAsync("nmcli -t -f DEVICE,TYPE device status 2>/dev/null");
    for (const line of stdout.trim().split('\n')) {
      const parts = line.split(':');
      // device type here is 'ethernet' (not '802-3-ethernet')
      if (parts[1] === 'ethernet' && parts[0] && parts[0] !== 'lo') return parts[0];
    }
  } catch (_) { /* nmcli unavailable */ }
  // Fallback: check os.networkInterfaces() for known ethernet name patterns
  const ifaces = os.networkInterfaces();
  const ethName = Object.keys(ifaces).find(n => /^(eth|end|enp|ens|eno)/.test(n));
  return ethName || null;
}

// GET /api/ethernet/config — return current ethernet IP mode and saved settings
app.get("/api/ethernet/config", async (req, res) => {
  try {
    const iface = await _findEthernetIface();

    // Load our persisted config (written whenever the user saves).
    // Defaults to DHCP if no config file exists yet.
    let saved = { method: 'dhcp', ip: '', prefix: '24', gateway: '', dns: '' };
    try {
      saved = { ...saved, ...JSON.parse(fsSync.readFileSync(ETH_CONFIG_FILE, 'utf8')) };
    } catch (_) { /* first run — no saved config yet */ }

    // Get the live IP that the OS currently has on the interface
    let currentIp = '', connected = false;
    if (iface) {
      try {
        const { stdout } = await execAsync(`ip -4 addr show dev ${iface} 2>/dev/null`);
        const m = stdout.match(/inet\s+([0-9.]+)/);
        if (m) { currentIp = m[1]; connected = true; }
      } catch (_) {}
    }

    res.json({ success: true, iface: iface || null, connected, currentIp, ...saved });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// POST /api/ethernet/config — write a netplan override file and apply it
app.post("/api/ethernet/config", express.json(), async (req, res) => {
  const { method, ip, prefix, gateway, dns } = req.body || {};

  if (!['dhcp', 'static'].includes(method))
    return res.json({ success: false, error: "method must be 'dhcp' or 'static'" });
  if (method === 'static' && !ip)
    return res.json({ success: false, error: "ip is required for static mode" });

  try {
    const iface = await _findEthernetIface();
    if (!iface) return res.json({ success: false, error: 'No ethernet interface found' });

    // Build netplan YAML
    let yaml;
    if (method === 'dhcp') {
      yaml = [
        'network:',
        '  version: 2',
        '  ethernets:',
        `    ${iface}:`,
        '      dhcp4: true',
        '',
      ].join('\n');
    } else {
      const pfx = prefix || '24';
      const lines = [
        'network:',
        '  version: 2',
        '  ethernets:',
        `    ${iface}:`,
        '      dhcp4: false',
        '      addresses:',
        `        - ${ip}/${pfx}`,
      ];
      if (gateway) lines.push('      routes:', '        - to: default', `          via: ${gateway}`);
      if (dns)     lines.push('      nameservers:', '        addresses:', `          - ${dns}`);
      lines.push('');
      yaml = lines.join('\n');
    }

    // Write via `sudo tee` (pipe content directly — no temp file needed)
    // Requires: ubuntu ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/netplan/99-digitalpool-ethernet.yaml
    await new Promise((resolve, reject) => {
      const proc = spawn('sudo', ['tee', NETPLAN_ETH_FILE], { stdio: ['pipe', 'ignore', 'pipe'] });
      let errMsg = '';
      proc.stderr.on('data', d => { errMsg += d.toString(); });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(errMsg || `tee exited ${code}`)));
      proc.stdin.write(yaml);
      proc.stdin.end();
    });

    // Apply the new netplan config
    // Requires: ubuntu ALL=(ALL) NOPASSWD: /usr/sbin/netplan apply
    await execAsync('sudo netplan apply');

    // Persist our config state so GET can read it back without needing root
    const toSave = { method, ip: ip || '', prefix: prefix || '24', gateway: gateway || '', dns: dns || '' };
    fsSync.writeFileSync(ETH_CONFIG_FILE, JSON.stringify(toSave, null, 2));

    const label = method === 'dhcp' ? 'Switched to DHCP' : `Static IP ${ip}/${prefix || 24} applied`;
    console.log(`✅ Ethernet config updated on ${iface}: ${label}`);
    res.json({ success: true, message: label });
  } catch (err) {
    console.error('❌ Ethernet config error:', err.message);
    res.json({ success: false, error: err.message });
  }
});

// ============ END WIFI API ============

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
    }
    // No local scoreboard rendering — remote overlay handles its own content
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

// ── Camera source persistence ─────────────────────────────────────────────────
// The active input source (USB device path or RTSP URL) survives restarts via
// camera-source.json — same pattern as remote.json, ethernet-config.json, etc.
const CAMERA_SOURCE_FILE = path.join(__dirname, "camera-source.json");

function loadCameraSource() {
  try {
    if (fsSync.existsSync(CAMERA_SOURCE_FILE)) {
      const saved = JSON.parse(fsSync.readFileSync(CAMERA_SOURCE_FILE, "utf8"));
      // Validate minimal shape before trusting it
      if (saved && (saved.type === "usb" || saved.type === "rtsp")) {
        console.log(`📷 Loaded camera source from file: ${saved.type}${saved.type === "rtsp" ? " → " + saved.rtspUrl : " → " + saved.device}`);
        return saved;
      }
    }
  } catch (e) {
    console.warn("⚠️  Could not load camera-source.json:", e.message);
  }
  return null;
}

function saveCameraSource(source) {
  try {
    fsSync.writeFileSync(CAMERA_SOURCE_FILE, JSON.stringify(source, null, 2));
  } catch (e) {
    console.error("❌ Could not save camera-source.json:", e.message);
  }
}

// Active camera source — updated at runtime via /api/camera/source.
// Initialised from disk so the chosen source survives restarts.
const _savedSource = loadCameraSource();
let activeCameraSource = _savedSource || { type: "usb", device: CAMERA_DEVICE, rtspUrl: "" };

// List available V4L2 video capture devices
app.get("/api/camera/devices", requireAuth, (req, res) => {
  try {
    const { execSync } = require("child_process");
    const raw = execSync("v4l2-ctl --list-devices 2>/dev/null || true").toString();
    // Output format:
    //   Camera Model (usb-path):
    //       /dev/video0
    //       /dev/video1
    const devices = [];
    let currentName = "";
    for (const line of raw.split("\n")) {
      if (/^\s+/.test(line)) {
        const dev = line.trim();
        if (dev.startsWith("/dev/video")) {
          devices.push({ device: dev, name: currentName });
        }
      } else if (line.trim()) {
        currentName = line.replace(/:$/, "").trim();
      }
    }
    res.json({ success: true, devices, current: activeCameraSource });
  } catch (e) {
    res.json({ success: false, error: e.message, devices: [], current: activeCameraSource });
  }
});

// Poll until TCP port is accepting connections, or timeout.
// Used to verify GStreamer actually started serving before telling the client.
function waitForPort(port, timeoutMs = 8000) {
  const net = require("net");
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const s = net.connect({ port, host: "127.0.0.1" });
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => {
        s.destroy();
        if (Date.now() < deadline) setTimeout(attempt, 300);
        else resolve(false);
      });
    }
    attempt();
  });
}

// Switch the active camera source (USB device or RTSP URL)
app.post("/api/camera/source", requireAuth, async (req, res) => {
  const { type, device, rtspUrl } = req.body;
  const previousSource = { ...activeCameraSource };

  if (type === "usb") {
    const dev = device || CAMERA_DEVICE;
    activeCameraSource = { type: "usb", device: dev, rtspUrl: "" };
    camera.device = dev;
  } else if (type === "rtsp") {
    if (!rtspUrl) return res.status(400).json({ success: false, error: "rtspUrl required" });
    activeCameraSource = { type: "rtsp", device: CAMERA_DEVICE, rtspUrl };
  } else {
    return res.status(400).json({ success: false, error: "Unknown source type" });
  }

  // Keep the stream controller in sync so the NEXT "Start Stream" uses the
  // correct source (v4l2src for USB, rtspsrc for RTSP).
  streamController.setInputSource(activeCameraSource);

  if (!streamController.isStreaming) {
    try {
      await startPersistentIdlePreview();
    } catch (e) {
      console.error("⚠️ Failed to start idle preview after source change:", e.message);
    }

    // For RTSP, give GStreamer up to 12 s to negotiate the session and open the port.
    // For USB, 5 s is plenty.
    const timeoutMs = type === "rtsp" ? 12000 : 5000;
    const ready = await waitForPort(IDLE_PREVIEW_PORT, timeoutMs);

    if (!ready) {
      // Pipeline never came up — revert to previous USB source
      console.error(`⚠️ Camera source (${type}) did not respond in time — reverting`);
      activeCameraSource = { ...previousSource, type: "usb", device: previousSource.device || CAMERA_DEVICE, rtspUrl: "" };
      camera.device = activeCameraSource.device;
      // Also revert the stream controller so the next Start Stream uses USB again
      streamController.setInputSource(activeCameraSource);
      try { await startPersistentIdlePreview(); } catch (_) {}
      io.emit("refreshIdlePreview");
      return res.json({ success: false, error: type === "rtsp"
        ? "RTSP source did not respond. Check the URL is reachable and try again."
        : "USB device did not start. Check the device path." });
    }

    io.emit("refreshIdlePreview");
  }

  // Persist so the chosen source survives a service restart
  saveCameraSource(activeCameraSource);

  res.json({ success: true, source: activeCameraSource });
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

// ── MediaMTX Control API helpers ─────────────────────────────────────────────
// Thin wrappers around http.get / http.request for talking to MediaMTX on
// localhost:9997.  Both return a Promise that resolves to the parsed JSON body.
function mediamtxGet(apiPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port: 9997, path: apiPath, timeout: 2000 },
      (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("MediaMTX timeout")); });
  });
}

function mediamtxPost(apiPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: 9997, path: apiPath, method: "POST", timeout: 2000 },
      (res) => {
        res.resume(); // drain body
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`MediaMTX returned HTTP ${res.statusCode}`));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("MediaMTX timeout")); });
    req.end();
  });
}

// ── Banned-IP persistence ────────────────────────────────────────────────────
// bannedIPs is an array of IP strings (no port).  It survives restarts via
// banned-ips.json.
//
// Enforcement has two layers:
//   1. MediaMTX auth hook (POST /api/mediamtx/auth) — rejects the connection
//      before it is established, requires authMethod: http in mediamtx.yml.
//   2. Auto-kick on each viewer poll — fallback if the auth hook isn't configured.
const BANNED_IPS_FILE = path.join(__dirname, "banned-ips.json");
let bannedIPs = [];

function loadBannedIPs() {
  try {
    if (fsSync.existsSync(BANNED_IPS_FILE))
      bannedIPs = JSON.parse(fsSync.readFileSync(BANNED_IPS_FILE, "utf8"));
  } catch (_) { bannedIPs = []; }
}

function saveBannedIPs() {
  fsSync.writeFileSync(BANNED_IPS_FILE, JSON.stringify(bannedIPs, null, 2));
}

loadBannedIPs();

// Extract just the IP address from a "host:port" remoteAddr string.
// Handles both IPv4 ("1.2.3.4:5678") and IPv6 ("[::1]:5678").
function extractIp(remoteAddr) {
  if (!remoteAddr) return null;
  const ipv6 = remoteAddr.match(/^\[(.+)\]:\d+$/);
  if (ipv6) return ipv6[1];
  const colon = remoteAddr.lastIndexOf(":");
  return colon >= 0 ? remoteAddr.slice(0, colon) : remoteAddr;
}

// Protocol definitions — each entry describes one MediaMTX connection type,
// the list endpoint to query, and the kick endpoint to call.
// All four share the same JSON schema (id, remoteAddr, path, state,
// bytesSent, bytesReceived), so a single code path handles them all.
const MEDIAMTX_PROTOCOLS = [
  { type: "RTSP",   listPath: "/v3/rtspsessions/list", kickBase: "/v3/rtspsessions/kick" },
  { type: "SRT",    listPath: "/v3/srtconns/list",     kickBase: "/v3/srtconns/kick"     },
  { type: "RTMP",   listPath: "/v3/rtmpconns/list",    kickBase: "/v3/rtmpconns/kick"    },
  { type: "WebRTC", listPath: "/v3/webrtcsessions/list", kickBase: "/v3/webrtcsessions/kick" },
];

// Per-client bytesSent tracking for rate calculation.
// Each entry: { bytes, time, mbps, kickBase }
//   bytes / time — last sample used for delta calculation
//   mbps         — last successfully computed rate (returned as-is when the
//                  interval between requests is too short to recalculate)
//   kickBase     — the protocol-specific kick URL prefix (e.g. /v3/srtconns/kick)
const viewerBytesHistory = {};

// GET /api/stream/viewers — list all reading clients on the "live" path across
// every supported protocol, compute per-client data rate, auto-kick banned IPs,
// and return the full bannedIPs list for permanent display in the UI.
app.get("/api/stream/viewers", requireAdmin, async (req, res) => {
  try {
    const now = Date.now();
    const bannedSet = new Set(bannedIPs);

    // Query all protocol endpoints in parallel; tolerate individual failures
    // (e.g. a protocol is disabled in mediamtx.yml) via allSettled.
    const results = await Promise.allSettled(
      MEDIAMTX_PROTOCOLS.map((p) => mediamtxGet(p.listPath).then((d) => ({ ...p, items: d.items || [] })))
    );

    // Flatten all sessions from every protocol into one array, tagged with type.
    // Only include sessions in "read" state — this excludes "publish" (the local
    // GStreamer/ffmpeg source) and "idle" (RTSP sessions that are mid-handshake or
    // lingering after a client disconnect without a proper TEARDOWN).
    const allSessions = results.flatMap((r) =>
      r.status === "fulfilled"
        ? r.value.items
            .filter((s) => s.path === "live" && s.state === "read")
            .map((s) => ({ ...s, _type: r.value.type, _kickBase: r.value.kickBase }))
        : []
    );

    const viewers = [];
    for (const s of allSessions) {
      const ip = extractIp(s.remoteAddr);

      // Auto-kick banned IPs silently — fire-and-forget
      if (ip && bannedSet.has(ip)) {
        mediamtxPost(`${s._kickBase}/${s.id}`).catch(() => {});
        delete viewerBytesHistory[s.id];
        continue;
      }

      const prev = viewerBytesHistory[s.id];
      let mbps = prev ? prev.mbps : null;
      if (prev && s.bytesSent >= prev.bytes && (now - prev.time) >= 800) {
        const elapsed = (now - prev.time) / 1000;
        mbps = parseFloat(((s.bytesSent - prev.bytes) * 8 / elapsed / 1_000_000).toFixed(2));
        viewerBytesHistory[s.id] = { bytes: s.bytesSent, time: now, mbps, kickBase: s._kickBase, ip };
      } else if (!prev) {
        viewerBytesHistory[s.id] = { bytes: s.bytesSent, time: now, mbps: null, kickBase: s._kickBase, ip };
      }

      viewers.push({
        id: s.id, remoteAddr: s.remoteAddr, ip,
        type: s._type, state: s.state, bytesSent: s.bytesSent, mbps,
      });
    }

    // Clean up history for sessions that are no longer active
    const activeIds = new Set(viewers.map((v) => v.id));
    for (const id of Object.keys(viewerBytesHistory)) {
      if (!activeIds.has(id)) delete viewerBytesHistory[id];
    }

    res.json({ success: true, viewers, bannedIPs });
  } catch (_) {
    res.json({ success: true, viewers: [], bannedIPs });
  }
});

// POST /api/stream/kick/:id — disconnect a client.
// Uses the kickBase stored in viewerBytesHistory to pick the right protocol endpoint.
app.post("/api/stream/kick/:id", requireAdmin, async (req, res) => {
  try {
    const kickBase = viewerBytesHistory[req.params.id]?.kickBase || "/v3/rtspsessions/kick";
    await mediamtxPost(`${kickBase}/${req.params.id}`);
    delete viewerBytesHistory[req.params.id];
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/stream/ban/:id — kick the session AND permanently ban the IP.
// Looks the session up across all protocol lists to extract the IP and kickBase.
app.post("/api/stream/ban/:id", requireAdmin, async (req, res) => {
  try {
    // Try to get kickBase + IP from cached history first (fastest path)
    let kickBase = viewerBytesHistory[req.params.id]?.kickBase;
    let ip = viewerBytesHistory[req.params.id]?.ip || null;

    // If not fully cached, search all protocol lists for this session ID
    if (!kickBase || !ip) {
      const results = await Promise.allSettled(
        MEDIAMTX_PROTOCOLS.map((p) => mediamtxGet(p.listPath).then((d) => ({ ...p, items: d.items || [] })))
      );
      for (const r of results) {
        if (r.status !== "fulfilled") continue;
        const found = r.value.items.find((s) => s.id === req.params.id);
        if (found) { kickBase = r.value.kickBase; ip = extractIp(found.remoteAddr); break; }
      }
    }

    if (!ip) ip = req.body?.ip || null; // last resort: caller can supply it
    if (!ip) return res.status(400).json({ success: false, error: "Session not found" });

    if (!bannedIPs.includes(ip)) { bannedIPs.push(ip); saveBannedIPs(); }

    await mediamtxPost(`${kickBase}/${req.params.id}`);
    delete viewerBytesHistory[req.params.id];
    res.json({ success: true, ip });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/stream/unban — remove an IP from the ban list.
// Body: { ip: "1.2.3.4" }
app.post("/api/stream/unban", requireAdmin, express.json(), async (req, res) => {
  const ip = req.body?.ip;
  if (!ip) return res.status(400).json({ success: false, error: "ip required" });
  bannedIPs = bannedIPs.filter((b) => b !== ip);
  saveBannedIPs();
  res.json({ success: true, ip });
});

// ── MediaMTX external authentication hook ────────────────────────────────────
// MediaMTX calls this endpoint BEFORE accepting any connection, giving us the
// opportunity to reject banned IPs before they ever establish a session.
//
// Required additions to /etc/mediamtx.yml:
//   authMethod: http
//   authHTTPAddress: http://127.0.0.1:3000/api/mediamtx/auth
//   authHTTPExclude:
//     - action: publish
//
// MediaMTX POSTs JSON: { ip, user, password, action, path, protocol, id, query }
// Return HTTP 200 → connection allowed.  HTTP 4xx → connection rejected.
//
// This endpoint is intentionally unauthenticated — it is only reachable from
// localhost because MediaMTX is configured with authHTTPAddress: http://127.0.0.1:3000/...
// No IP check is performed here; the bind address is the security boundary.
app.post("/api/mediamtx/auth", express.json(), (req, res) => {
  try {
    const { ip, action, path: streamPath, protocol } = req.body || {};

    // Always allow the local GStreamer publisher and internal MediaMTX processes
    if (!ip || ip === "127.0.0.1" || ip === "::1") {
      console.log(`🔐 Auth hook: allowed local ${protocol} ${action} from ${ip} on "${streamPath}"`);
      return res.sendStatus(200);
    }

    // Block banned IPs — connection is rejected before it is established
    if (Array.isArray(bannedIPs) && bannedIPs.includes(ip)) {
      console.log(`🚫 Auth hook: BLOCKED ${protocol} ${action} from banned IP ${ip} on "${streamPath}"`);
      return res.sendStatus(403);
    }

    console.log(`✅ Auth hook: allowed ${protocol} ${action} from ${ip} on "${streamPath}"`);
    res.sendStatus(200);
  } catch (err) {
    // Never let an unexpected error default to a rejection — log and allow
    console.error("⚠️  Auth hook error:", err.message, "body:", JSON.stringify(req.body));
    res.sendStatus(200);
  }
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

// ── Single-frame JPEG snapshot ────────────────────────────────────────────
// Connects to the GStreamer TCP server, reads until one complete JPEG is found
// (FF D8 … FF D9), then returns it and closes the connection immediately.
// Because every request is independent there is no frame queue — the client
// always gets the most recent frame regardless of network speed.
app.get("/video/snapshot", requireAuth, (req, res) => {
  const net    = require("net");
  const port   = streamController.isStreaming ? 8555 : IDLE_PREVIEW_PORT;

  let buffer    = Buffer.alloc(0);
  let responded = false;
  let client;

  const done = (jpeg) => {
    if (responded) return;
    responded = true;
    clearTimeout(timer);
    if (client) { try { client.destroy(); } catch (_) {} }
    if (jpeg) {
      res.setHeader("Content-Type",  "image/jpeg");
      res.setHeader("Cache-Control", "no-store");
      res.send(jpeg);
    } else {
      res.status(503).end();
    }
  };

  const timer = setTimeout(() => done(null), 5000);

  try {
    client = net.connect({ port, host: "127.0.0.1" });

    client.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Find JPEG start marker FF D8 FF
      let start = -1;
      for (let i = 0; i <= buffer.length - 3; i++) {
        if (buffer[i] === 0xFF && buffer[i + 1] === 0xD8 && buffer[i + 2] === 0xFF) {
          start = i; break;
        }
      }
      if (start < 0) return;

      // Find JPEG end marker FF D9 after the start
      for (let i = start + 2; i < buffer.length - 1; i++) {
        if (buffer[i] === 0xFF && buffer[i + 1] === 0xD9) {
          done(buffer.slice(start, i + 2));
          return;
        }
      }
    });

    client.on("error", () => done(null));
    client.on("close",  () => { if (!responded) done(null); });
    req.on("close",     () => { responded = true; clearTimeout(timer); if (client) client.destroy(); });
  } catch (e) {
    done(null);
  }
});

// ── MediaMTX HLS proxy (live stream preview) ──────────────────────────────
// Proxies MediaMTX's HLS output through the authenticated Express server so
// the browser can fetch the live stream via port 3000.
// MediaMTX serves HLS at http://localhost:8888/<path>/index.m3u8 + *.ts segments.
// Available whenever GStreamer is pushing RTMP to MediaMTX (not SRT-direct mode).
app.get("/video/hls-live/*file", requireAuth, (req, res) => {
  const file = req.params.file; // 'index.m3u8' or a segment like 'seg001.ts'
  const upstreamUrl = `http://127.0.0.1:8888/live/${file}`;

  const proxyReq = http.get(upstreamUrl, { timeout: 4000 }, (upRes) => {
    if (upRes.statusCode !== 200) {
      upRes.resume(); // drain so the socket can be reused
      return res.status(upRes.statusCode).end();
    }
    res.setHeader("Content-Type", upRes.headers["content-type"] || "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Access-Control-Allow-Origin", "*");
    upRes.pipe(res);
  });

  proxyReq.on("error", () => res.status(502).end());
  proxyReq.on("timeout", () => { proxyReq.destroy(); res.status(504).end(); });
  req.on("close", () => proxyReq.destroy()); // client disconnected — stop proxying
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
let idlePreviewRestartTimer = null;
const IDLE_PREVIEW_PORT = 8553; // 8554 is reserved for MediaMTX RTSP

// Helper: convert color name to GStreamer integer format
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

/**
 * Build GStreamer args for the idle preview pipeline.
 * @param {string[]} sinkArgs - Sink element args (e.g., tcpserversink or fdsink)
 * @returns {string[]} Complete gst-launch-1.0 args
 */
function buildIdlePreviewGstArgs(sinkArgs) {
  const config = streamController.streamConfig;
  const fs = require("fs");

  // ── RTSP source: simple passthrough pipeline (no v4l2 / MPP, no overlays) ──
  if (activeCameraSource.type === "rtsp" && activeCameraSource.rtspUrl) {
    console.log(`📡 Building RTSP idle preview pipeline for ${activeCameraSource.rtspUrl}`);
    return [
      "rtspsrc", `location=${activeCameraSource.rtspUrl}`, "latency=200", "protocols=tcp",
      "!", "decodebin",
      // videoconvert immediately after decodebin: decodebin produces dynamic caps
      // (NV12, I420, BGR, etc. depending on codec) and videorate/videoscale require
      // a fixed raw format — videoconvert normalises whatever decodebin emits.
      "!", "videoconvert",
      "!", "videorate",
      "!", "video/x-raw,framerate=1/1",
      "!", "videoscale",
      "!", "video/x-raw,width=1280,height=720",
      "!", "videoconvert",
      "!", "jpegenc", "quality=65",
      "!", "multipartmux", "boundary=frame",
      "!", ...sinkArgs,
    ];
  }

  // ── USB source (default): full MPP pipeline with overlay support ──
  const device = activeCameraSource.device || CAMERA_DEVICE;
  const gstArgs = [
    "v4l2src",
    `device=${device}`,
    "do-timestamp=true",
    "!",
    `image/jpeg,width=${config.width || 1920},height=${config.height || 1080},framerate=${config.framerate || 30}/1`,
    "!",
    "jpegparse",
    "!",
    "mppjpegdec",
    "!",
    "videorate",
    "!",
    "video/x-raw,framerate=1/1",
    "!",
    "videoscale",
    "!",
    "video/x-raw,width=1280,height=720",
    "!",
    "videoconvert",
    "!",
  ];

  // Check if the remote overlay PNG exists and should be shown
  const pngOverlayPath = "/tmp/graphics-overlay.png";
  const hasRemoteOverlay = config.remoteOverlayEnabled && config.overlayUrl && config.overlayUrl.trim();
  let pngExists = false;
  if (hasRemoteOverlay) {
    try {
      const exists = fs.existsSync(pngOverlayPath);
      const size = exists ? fs.statSync(pngOverlayPath).size : 0;
      pngExists = exists && size > 100;
      console.log(`📋 Remote overlay check: exists=${exists}, size=${size}, pngExists=${pngExists}`);
    } catch (e) {
      console.log(`📋 Remote overlay check error: ${e.message}`);
    }
  }

  const hasAnyOverlay = config.overlayEnabled || config.showTimestamp || (hasRemoteOverlay && pngExists);
  console.log(`📋 Idle preview overlay flags: overlayEnabled=${config.overlayEnabled}, showTimestamp=${config.showTimestamp}, hasRemoteOverlay=${hasRemoteOverlay}, pngExists=${pngExists}, hasAnyOverlay=${hasAnyOverlay}`);

  if (hasAnyOverlay) {
    // Remote overlay PNG — rendered FIRST so text/timestamp appear on top of it
    if (hasRemoteOverlay && pngExists) {
      console.log(`📸 Adding remote overlay PNG to idle preview: ${pngOverlayPath}`);
      gstArgs.push(
        "gdkpixbufoverlay",
        `location=${pngOverlayPath}`,
        "overlay-width=1280",
        "overlay-height=720",
        "!"
      );
    }

    // Logo overlay
    if (config.logoPath) {
      gstArgs.push(
        "gdkpixbufoverlay",
        `location=${config.logoPath}`,
        "offset-x=20",
        "offset-y=20",
        "!"
      );
    }

    // Title overlay (renders on top of remote PNG)
    if (config.overlayEnabled && config.overlayText) {
      const position = config.titlePosition || config.overlayPosition || "bottom-left";
      const [vpos, hpos] = position.split("-");
      const valign = vpos === "bottom" ? "bottom" : vpos === "center" ? "center" : "top";
      const halign = hpos === "left" ? "left" : hpos === "right" ? "right" : "center";
      const titleFs = config.titleFontSize || config.overlayFontSize || 32;
      const scaledFontSize = Math.round(titleFs * 1.5);
      const titleClr = config.titleColor || config.overlayColor || "white";
      const textArgs = [
        "textoverlay",
        `text="${config.overlayText}"`,
        `valignment=${valign}`,
        `halignment=${halign}`,
        `font-desc=Sans Bold ${scaledFontSize}`,
        `color=${colorToInt(titleClr)}`,
      ];
      const titleBg = config.titleBackground || config.overlayBackground || "transparent";
      if (titleBg !== "transparent") {
        textArgs.push("shaded-background=true");
      }
      textArgs.push("xpad=20", "ypad=20", "!");
      gstArgs.push(...textArgs);
    }

    // Timestamp overlay (renders on top of remote PNG)
    if (config.showTimestamp) {
      const tsPosition = config.timestampPosition || "bottom-right";
      const [vpos, hpos] = tsPosition.split("-");
      const valign = vpos === "bottom" ? "bottom" : vpos === "center" ? "center" : "top";
      const halign = hpos === "left" ? "left" : hpos === "right" ? "right" : "center";
      const tsFontSize = config.timestampFontSize || Math.round((config.overlayFontSize || 32) * 0.75);
      const scaledFontSize = Math.round(tsFontSize * 1.5);
      const tsColor = config.timestampColor || config.overlayColor || "white";
      const timestampArgs = [
        "clockoverlay",
        `valignment=${valign}`,
        `halignment=${halign}`,
        `font-desc=Sans Bold ${scaledFontSize}`,
        `color=${colorToInt(tsColor)}`,
        `time-format="${config.timestampFormat || '%Y-%m-%d %H:%M:%S'}"`,
      ];
      const tsBg = config.timestampBackground || config.overlayBackground || "transparent";
      if (tsBg !== "transparent") {
        timestampArgs.push("shaded-background=true");
      }
      timestampArgs.push("xpad=20", "ypad=20", "!");
      gstArgs.push(...timestampArgs);
    }

    // Custom text 2
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
  }

  // JPEG encode and output
  gstArgs.push(
    "jpegenc",
    "quality=65",
    "!",
    "multipartmux",
    "boundary=frame",
    "!",
    ...sinkArgs
  );

  return gstArgs;
}

/**
 * Start (or restart) the persistent idle preview GStreamer process.
 * Uses tcpserversink on IDLE_PREVIEW_PORT so clients can connect/disconnect freely.
 * Protected by a mutex to prevent concurrent calls from racing.
 */
let _idlePreviewStarting = false;
let _idlePreviewStartQueue = null; // Promise for callers to wait on

async function startPersistentIdlePreview() {
  // Don't start if streaming is active
  if (streamController.isStreaming) {
    console.log("⚠️  Not starting idle preview — stream is active");
    return;
  }

  // If another call is already in progress, wait for it to finish
  if (_idlePreviewStarting) {
    console.log("⏳ Idle preview start already in progress — waiting...");
    if (_idlePreviewStartQueue) {
      await _idlePreviewStartQueue;
    }
    return;
  }

  _idlePreviewStarting = true;
  let resolveQueue;
  _idlePreviewStartQueue = new Promise((r) => { resolveQueue = r; });

  try {
    // Kill existing idle preview process
    if (currentIdlePreviewProcess && !currentIdlePreviewProcess.killed) {
      console.log("🔄 Killing previous idle preview to restart with updated settings");
      currentIdlePreviewProcess.kill("SIGTERM");
      currentIdlePreviewProcess = null;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    // Kill any process using the idle preview port
    try {
      const { execSync } = require("child_process");
      execSync(`fuser -k ${IDLE_PREVIEW_PORT}/tcp 2>/dev/null || true`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (e) { /* ignore */ }

    // Double-check the port is free
    try {
      const { execSync } = require("child_process");
      const portCheck = execSync(`fuser ${IDLE_PREVIEW_PORT}/tcp 2>/dev/null || true`).toString().trim();
      if (portCheck) {
        console.log(`⚠️  Port ${IDLE_PREVIEW_PORT} still in use: ${portCheck}, force killing...`);
        execSync(`fuser -k ${IDLE_PREVIEW_PORT}/tcp 2>/dev/null || true`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (e) { /* ignore */ }

    const sinkArgs = [
      "tcpserversink",
      "host=0.0.0.0",
      `port=${IDLE_PREVIEW_PORT}`,
      "sync=false",
      "recover-policy=keyframe",
    ];

    const gstArgs = buildIdlePreviewGstArgs(sinkArgs);
    console.log(`📹 Starting persistent idle preview on TCP port ${IDLE_PREVIEW_PORT}`);
    console.log(`📋 GStreamer idle preview args: gst-launch-1.0 ${gstArgs.join(" ")}`);

    const gst = spawn("gst-launch-1.0", gstArgs);
    currentIdlePreviewProcess = gst;
    console.log(`📹 Started idle preview process PID: ${gst.pid}`);

    gst.stdout.on("data", (data) => {
      console.log(`GStreamer idle stdout: ${data.toString().trim()}`);
    });

    gst.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) {
        console.log(`GStreamer idle stderr: ${msg}`);
      }
    });

    gst.on("close", (code) => {
      console.log(`GStreamer idle preview exited with code ${code}`);
      if (currentIdlePreviewProcess === gst) {
        currentIdlePreviewProcess = null;
      }
    });

    gst.on("error", (err) => {
      console.error("Failed to start GStreamer idle preview:", err);
      if (currentIdlePreviewProcess === gst) {
        currentIdlePreviewProcess = null;
      }
    });

    // Wait for the TCP server to start listening
    await new Promise((resolve) => setTimeout(resolve, 800));
  } finally {
    _idlePreviewStarting = false;
    if (resolveQueue) resolveQueue();
    _idlePreviewStartQueue = null;
  }
}

// Video stream endpoint using MJPEG — proxies the persistent idle preview TCP server
app.get("/video/stream", async (req, res) => {
  console.log("New video stream connection requested");

  // If streaming is active, don't try to access camera for idle preview
  if (streamController.isStreaming) {
    console.log("⚠️  Stream is active - preview should use HLS at /video/hls/playlist.m3u8");
    res.status(503).send("Stream active - use HLS preview");
    return;
  }

  // If no idle preview process is running, start one (but not during boot — boot handles it).
  // For RTSP sources: don't auto-restart here — if the RTSP pipeline crashed it means the
  // source is unreachable. The user must explicitly apply the source again via the UI.
  // Auto-restart is safe only for USB (v4l2src) where the device is always present.
  if (!bootComplete) {
    console.log("⏳ Boot still in progress — waiting for idle preview to be started by boot sequence");
  } else if (!currentIdlePreviewProcess || currentIdlePreviewProcess.killed) {
    if (activeCameraSource.type === "rtsp") {
      console.log("⚠️  RTSP idle preview crashed — not auto-restarting (user must re-apply source)");
    } else {
      console.log("📹 No idle preview running — starting persistent idle preview...");
      await startPersistentIdlePreview();
    }
  }

  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Connect to the persistent idle preview TCP server
  // During boot, allow more retries since the preview takes time to start
  const net = require("net");
  let retries = 0;
  // Post-boot: allow up to 15 s for the TCP server to become ready.
  // RTSP idle pipelines need up to 12 s to negotiate the session before
  // tcpserversink starts accepting connections; USB typically takes <1 s.
  const maxRetries = bootComplete ? 15 : 30;

  // Track the current active TCP client so req.on("close") can always destroy it.
  // The listener is registered ONCE here — not inside the retry loop — to avoid
  // the MaxListenersExceededWarning that occurs when a new listener is added on
  // every recursive connectToPreview() call.
  let currentClient = null;
  let reqClosed = false;

  req.on("close", () => {
    console.log("Client disconnected from preview");
    reqClosed = true;
    if (currentClient) {
      currentClient.destroy();
    }
  });

  function connectToPreview() {
    // If the HTTP client already disconnected, stop retrying.
    if (reqClosed) return;

    const client = net.connect({ port: IDLE_PREVIEW_PORT, host: "localhost" });
    currentClient = client;

    let totalBytesReceived = 0;
    let firstDataLogged = false;

    client.on("connect", () => {
      console.log(`✅ Connected to idle preview TCP server on port ${IDLE_PREVIEW_PORT}`);
    });

    client.on("data", (data) => {
      totalBytesReceived += data.length;
      if (!firstDataLogged) {
        firstDataLogged = true;
        console.log(`📦 First data from idle preview: ${data.length} bytes (first 50 hex: ${data.slice(0, 50).toString('hex')})`);
      }
      try {
        res.write(data);
      } catch (err) {
        console.error("Error writing preview frame:", err.message);
        client.destroy();
      }
    });

    client.on("error", (err) => {
      if (reqClosed) return; // HTTP client already gone — stop silently
      if (retries < maxRetries) {
        retries++;
        console.log(`⚠️  Preview TCP connection failed (attempt ${retries}/${maxRetries}): ${err.message}`);
        setTimeout(connectToPreview, 1000);
      } else {
        console.error(`❌ Could not connect to idle preview after ${maxRetries} attempts`);
        try { res.end(); } catch (e) { /* already ended */ }
      }
    });

    client.on("close", () => {
      if (reqClosed) return; // req.on("close") already handled this
      console.log("Preview TCP connection closed");
      try { res.end(); } catch (e) { /* already ended */ }
    });
  }

  connectToPreview();
});

// ── Socket.IO auth guard ──────────────────────────────────────────────────────
// The session middleware was already wired into io.use() at startup so that
// socket.request.session is populated.  Now enforce the auth check.
io.use((socket, next) => {
  const ip = socket.handshake.address || socket.handshake.headers["x-forwarded-for"] || "";
  if (ip.includes(HOTSPOT_SUBNET)) return next();       // hotspot bypass
  if (socket.request.session?.user) return next();     // authenticated session
  next(new Error("Unauthorized"));                     // reject the connection
});

// Socket.IO for real-time camera control
io.on("connection", (socket) => {
  const who = socket.request.session?.user?.username || "hotspot";
  console.log(`Client connected: ${socket.id} (${who})`);

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
    // Immediately broadcast "starting" to all clients
    io.emit("streamStatus", { ...streamController.getStatus(), status: "starting" });
    const result = await streamController.startStream(config);
    socket.emit("streamResult", result);
  });

  socket.on("stopStream", async () => {
    // Immediately broadcast "stopping" to all clients
    io.emit("streamStatus", { ...streamController.getStatus(), status: "stopping" });
    const result = await streamController.stopStream();
    socket.emit("streamResult", result);

    // Notify client to refresh preview
    if (result.success) {
      socket.emit("previewRefreshNeeded", {
        message: "Stream stopped. Refresh the page to restart the preview.",
      });
    }
  });

  // Atomic restart: stop → start without showing the idle preview in between.
  // The "stopped" broadcast and idle-preview restart are suppressed while
  // isRestartInProgress is true, so the browser stays on "Restarting…" the
  // whole time and never opens a redundant MJPEG preview connection.
  socket.on("restartStream", async (config) => {
    console.log("🔄 Restarting stream...");
    isRestartInProgress = true;
    io.emit("streamStatus", { ...streamController.getStatus(), status: "restarting" });

    // Stop the running stream
    if (streamController.isStreaming) {
      io.emit("streamStatus", { ...streamController.getStatus(), status: "stopping" });
      await streamController.stopStream();
    }

    // Start the new stream — clear the flag first so normal "started"/"stopped"
    // events are broadcast correctly going forward.
    isRestartInProgress = false;
    io.emit("streamStatus", { ...streamController.getStatus(), status: "starting" });
    const result = await streamController.startStream(config);
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

    // Handle remote overlay enable/disable (create PuppeteerOverlay if needed)
    const wantsRemote = overlayConfig.remoteOverlayEnabled &&
      overlayConfig.overlayUrl && overlayConfig.overlayUrl.trim();
    if (wantsRemote) {
      // Create PuppeteerOverlay instance if it doesn't exist yet
      if (!puppeteerOverlay && PuppeteerOverlay) {
        puppeteerOverlay = new PuppeteerOverlay();
      }
      if (puppeteerOverlay) {
        if (!puppeteerOverlay.isRunning) {
          await puppeteerOverlay.initialize(PORT);
        }
        puppeteerOverlay.setOverlayUrl(overlayConfig.overlayUrl, {
          zoom: overlayConfig.overlayZoom,
        });
        puppeteerOverlay.startPeriodicRefresh();

        // Wait for the first screenshot before restarting preview,
        // so the overlay is visible immediately (no flash of camera-only feed)
        if (!streamController.isStreaming) {
          clearTimeout(idlePreviewRestartTimer);
          const restartForOverlay = async () => {
            console.log("📸 Remote screenshot ready — restarting idle preview to show overlay");
            await startPersistentIdlePreview();
            io.emit("refreshIdlePreview");
          };
          const onUpdated = () => { clearTimeout(fallback); restartForOverlay(); };
          const fallback = setTimeout(() => {
            puppeteerOverlay.removeListener("updated", onUpdated);
            console.log("⏱️ Timeout waiting for remote screenshot — restarting preview anyway");
            restartForOverlay();
          }, 10000);
          puppeteerOverlay.once("updated", onUpdated);
        }
      }
    } else if (overlayConfig.remoteOverlayEnabled === false && puppeteerOverlay) {
      // Remote overlay was explicitly turned off — fully shut down Puppeteer and delete all overlay files
      console.log("🛑 Remote overlay disabled — shutting down Puppeteer and removing overlay files...");
      await puppeteerOverlay.stop();
      puppeteerOverlay = null;
    }

    // Broadcast state and write JSON (never render local scoreboard HTML)
    io.emit("scoreUpdated", gameState);
    try {
      const fs = require('fs');
      fs.writeFileSync('/tmp/graphics-overlay-state.json', JSON.stringify(gameState, null, 2));
    } catch (err) { /* ignore */ }

    // If NOT streaming and NOT waiting for a remote screenshot, restart the idle preview
    // Debounce to avoid restarting on every keystroke
    if (!streamController.isStreaming && !wantsRemote) {
      clearTimeout(idlePreviewRestartTimer);
      idlePreviewRestartTimer = setTimeout(async () => {
        console.log(`📋 Debounce fired — restarting idle preview with updated overlay settings`);
        await startPersistentIdlePreview();
        console.log("📡 Emitting refreshIdlePreview to clients");
        io.emit("refreshIdlePreview");
      }, 800);
    }

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

    // Also free the idle preview TCP port
    try {
      execSync(`fuser -k ${IDLE_PREVIEW_PORT}/tcp 2>/dev/null || true`);
    } catch (e) { /* ignore */ }

    // Wait for device to be released
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log("✅ Camera resources cleaned up");
  } catch (error) {
    console.log("⚠️  Error during cleanup:", error.message);
  }

  // Restore the camera source that was active before the last restart.
  // This must happen before startPersistentIdlePreview() so that
  // buildIdlePreviewGstArgs() uses the correct source (RTSP or USB).
  if (_savedSource) {
    console.log(`📷 Restoring camera source: ${_savedSource.type}${_savedSource.type === "rtsp" ? " → " + _savedSource.rtspUrl : " → " + _savedSource.device}`);
    streamController.setInputSource(activeCameraSource);
    if (activeCameraSource.type === "usb" && activeCameraSource.device) {
      camera.device = activeCameraSource.device;
    }
  }

  // Initialize stream controller (auto-start if configured)
  try {
    await streamController.initialize();
  } catch (error) {
    console.error("❌ Error initializing stream controller:", error.message);
  }

  // Start idle preview IMMEDIATELY — GStreamer's v4l2src does VIDIOC_STREAMON
  // which warms up the camera. No separate ffmpeg warmup needed.
  // The first few frames may be garbage but jpegparse will skip them gracefully.
  console.log("\n🚀 Starting idle preview as first boot action...");
  try {
    await camera.activateCamera();
    console.log("📹 Starting persistent idle preview...");
    await startPersistentIdlePreview();
    console.log("✅ Idle preview started — camera is active");
  } catch (error) {
    console.error("❌ Error starting idle preview:", error.message);
  }

  // Boot is complete — allow /video/stream to auto-start idle preview if needed
  // Signal clients IMMEDIATELY so they can start showing video
  bootComplete = true;
  console.log("🏁 Boot sequence complete — idle preview is live");
  io.emit("refreshIdlePreview");

  // Apply camera config and PTZ in the background — doesn't block video
  // (v4l2-ctl commands work fine while GStreamer has the camera open)
  try {
    console.log("📸 Applying camera configuration...");
    await camera.applyConfig();

    const usedStartup = await camera.applyStartupPosition();
    if (usedStartup) {
      console.log("📌 Applied startup position (overrides last known PTZ position)");
    } else {
      console.log("📌 No startup position set, using last saved PTZ position from config");
    }

    // Brief wait for camera to finish moving, then sync position
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await camera.syncPosition();

    cameraInitialized = true;
    console.log("✅ Camera initialized successfully\n");
  } catch (error) {
    console.error("❌ Error initializing camera:", error.message);
    cameraInitialized = true; // Allow commands even if init failed
  }

  // Start Puppeteer overlay ASYNCHRONOUSLY — don't block the preview
  // When the first screenshot arrives, restart the preview with the overlay
  const hasRemoteOnBoot = streamController.streamConfig.remoteOverlayEnabled &&
    streamController.streamConfig.overlayUrl && streamController.streamConfig.overlayUrl.trim();
  if (hasRemoteOnBoot && PuppeteerOverlay) {
    // Fire and forget — this runs in the background
    (async () => {
      try {
        console.log("🌍 Remote overlay configured — starting Puppeteer in background...");
        if (!puppeteerOverlay) {
          puppeteerOverlay = new PuppeteerOverlay();
        }
        await puppeteerOverlay.initialize(PORT);
        const overlayZoom = streamController.streamConfig.overlayZoom || 100;
        puppeteerOverlay.setOverlayUrl(streamController.streamConfig.overlayUrl, { zoom: overlayZoom });
        puppeteerOverlay.startPeriodicRefresh();
        console.log("✅ Remote overlay started — will restart preview when first screenshot is ready...");
        // Wait for the first screenshot, then restart preview with overlay
        await new Promise((resolve) => {
          const fallback = setTimeout(() => {
            puppeteerOverlay.removeListener("updated", onReady);
            console.log("⏱️ Timeout waiting for first screenshot — preview continues without overlay");
            resolve();
          }, 30000);
          const onReady = () => {
            clearTimeout(fallback);
            console.log("📸 First screenshot ready — restarting preview with overlay");
            resolve();
          };
          puppeteerOverlay.once("updated", onReady);
        });
        // Only restart if we're not currently streaming
        if (!streamController.isStreaming) {
          await startPersistentIdlePreview();
          io.emit("refreshIdlePreview");
        }
      } catch (err) {
        console.error("⚠️  Failed to start remote overlay on boot:", err.message);
      }
    })();
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
  }
  // Also free the TCP port
  try {
    const { execSync } = require("child_process");
    execSync(`fuser -k ${IDLE_PREVIEW_PORT}/tcp 2>/dev/null || true`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  } catch (e) { /* ignore */ }
  console.log("✅ Idle preview killed");

  const hasUrlOverlay = streamController.streamConfig.remoteOverlayEnabled &&
    streamController.streamConfig.overlayUrl && streamController.streamConfig.overlayUrl.trim();
  const needsGraphicsOverlay = streamController.streamConfig.skiaGraphicsEnabled || hasUrlOverlay;

  if (needsGraphicsOverlay) {
    console.log(`🎨 Preparing overlay (HTML → PNG)...`);

    // Ensure a valid PNG exists BEFORE any async work so GStreamer always has a file
    // to load. Puppeteer initialization can take several seconds; the stream controller
    // only waits 1.5 s after emitting "preparing" before spawning GStreamer. Creating a
    // placeholder here (synchronous, < 50 ms) guarantees gdkpixbufoverlay won't fail
    // with "No such file". Puppeteer will overwrite it with real content asynchronously.
    const pngPath = "/tmp/graphics-overlay.png";
    const pngMissing = !fsSync.existsSync(pngPath) || fsSync.statSync(pngPath).size < 100;
    if (pngMissing) {
      try {
        const { execSync } = require("child_process");
        execSync(`convert -size 1920x1080 xc:transparent "${pngPath}"`, { timeout: 5000 });
        console.log("🖼️  Placeholder transparent PNG created — Puppeteer will update it shortly");
      } catch (e) {
        console.error("⚠️  Could not create placeholder PNG:", e.message);
      }
    }

    try {
      // Initialize overlay renderer if not already running
      if (!puppeteerOverlay) {
        puppeteerOverlay = new PuppeteerOverlay();
      }

      if (!puppeteerOverlay.isRunning) {
        await puppeteerOverlay.initialize(PORT);
      }

      // Remote overlay URL mode only — no local scoreboard rendering
      const overlayUrl = streamController.streamConfig.overlayUrl;
      if (overlayUrl && overlayUrl.trim()) {
        const overlayZoom = streamController.streamConfig.overlayZoom || 100;
        console.log(`🌍 Using remote overlay URL: ${overlayUrl} (zoom: ${overlayZoom}%)`);
        puppeteerOverlay.setOverlayUrl(overlayUrl, { zoom: overlayZoom });
        puppeteerOverlay.startPeriodicRefresh();
      }
      console.log("✅ Overlay PNG ready for GStreamer");
    } catch (err) {
      console.error("❌ Failed to prepare overlay:", err.message);
    }
  }
});

// When stream stops, restart the persistent idle preview and manage Puppeteer refresh
streamController.on("stopped", async () => {
  // During an atomic restart, skip the idle preview restart — the restartStream
  // handler will start a new stream immediately instead.
  if (isRestartInProgress) {
    console.log("🔄 Restart in progress — skipping idle preview restart");
    return;
  }

  const hasRemote = streamController.streamConfig.remoteOverlayEnabled &&
    streamController.streamConfig.overlayUrl && streamController.streamConfig.overlayUrl.trim();
  if (puppeteerOverlay && !hasRemote) {
    puppeteerOverlay._stopPeriodicRefresh();
    console.log("ℹ️  Stream stopped, no remote overlay — pausing refresh");
  } else if (hasRemote) {
    console.log("ℹ️  Stream stopped, remote overlay active — keeping refresh for idle preview");
  }

  // Restart the persistent idle preview so clients see the camera feed again
  console.log("📹 Stream stopped — restarting persistent idle preview...");
  // Brief delay to let the streaming process fully release the camera/RTSP source
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await startPersistentIdlePreview();

  // For RTSP sources, the GStreamer pipeline needs time to negotiate the session
  // before tcpserversink begins accepting connections.  Wait for the port to be
  // ready (up to 12 s) before telling clients to reconnect — otherwise they hit
  // the server before any frames are available and the preview stays blank.
  const idleTimeoutMs = activeCameraSource.type === "rtsp" ? 12000 : 5000;
  const idleReady = await waitForPort(IDLE_PREVIEW_PORT, idleTimeoutMs);
  if (!idleReady) {
    console.warn(`⚠️  Idle preview port not ready after ${idleTimeoutMs / 1000}s — clients will retry on their own`);
  }
  // Tell clients to reconnect to the idle preview
  io.emit("refreshIdlePreview");
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