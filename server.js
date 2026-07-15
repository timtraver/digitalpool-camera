require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const session = require("express-session");
const { spawn, exec, execSync } = require("child_process");
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
const CAMERA_DEVICE   = process.env.CAMERA_DEVICE   || "/dev/video0";
const CAMERA_DEVICE_2 = process.env.CAMERA_DEVICE_2 || "/dev/video2";
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

// ── Camera 1 ─────────────────────────────────────────────────────────────────
const camera = new CameraController(CAMERA_DEVICE, { controllerId: 1 });
let cameraInitialized = false;
let cameraFormat = 'mjpeg'; // 'mjpeg' (OBSBOT etc.) or 'yuyv' (YUYV-only cameras)
const streamController = new StreamController(CAMERA_DEVICE, { streamId: 1 });

// ── Camera 2 ─────────────────────────────────────────────────────────────────
// Camera 2 is optional.  If CAMERA_DEVICE_2 is not connected the controller
// still initialises but commands will fail gracefully until a device appears.
const camera2 = new CameraController(CAMERA_DEVICE_2, { controllerId: 2 });
let cameraInitialized2 = false;
let cameraFormat2 = 'mjpeg';
const streamController2 = new StreamController(CAMERA_DEVICE_2, { streamId: 2 });

// ── Shared boot / restart flags ───────────────────────────────────────────────
// Flag to prevent /video/stream from spawning idle preview during boot
let bootComplete = false;
// Per-camera flag to suppress intermediate "stopped" events during an atomic restart.
// Keyed by camera index (1 or 2) so each camera is independent.
const isRestartInProgress = { 1: false, 2: false };
// Tracks whether the current stream cycle ever reached the "started" event.
// Used by the "stopped" handler to detect a pipeline that died during startup
// (e.g. ALSA "cannot open audio device") so we can clear isRestartInProgress
// and bring the idle preview back instead of leaving it permanently disabled.
const _streamReachedStarted = { 1: false, 2: false };

// ── Per-camera controller helpers ─────────────────────────────────────────────
/** Return the CameraController for index 1 or 2. */
function getCam(idx) { return idx === 2 ? camera2 : camera; }
/** Return the StreamController for index 1 or 2. */
function getSC(idx)  { return idx === 2 ? streamController2 : streamController; }

// WiFi Manager — the hotspot is started by digitalpool-hotspot.service (systemd)
// before this process launches.  Here we only start the interface monitor so
// the /api/wifi/* endpoints and the 30-second AP health-check work correctly.
const wifiManager = new WifiManager();
wifiManager.startMonitor()
  .then(ok => ok
    ? console.log("✅ WiFi Manager: hotspot monitor running")
    : console.warn("⚠️  WiFi Manager: no wireless interface found — hotspot API limited"))
  .catch(err => console.error("❌ WiFi Manager monitor error:", err.message));

// Initialize Puppeteer overlay (if available) — one instance per camera
let puppeteerOverlay = null;   // Camera 1
let puppeteerOverlay2 = null;  // Camera 2
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

// ── Stream controller event handlers (Camera 1) ───────────────────────────────
streamController.on("preparing", () => {
  const status = streamController.getStatus();
  io.emit("streamStatus", { ...status, status: "preparing", cameraIndex: 1 });
});

streamController.on("started", () => {
  _streamReachedStarted[1] = true;
  isRestartInProgress[1] = false;
  const status = streamController.getStatus();
  io.emit("streamStatus", { ...status, status: "started", cameraIndex: 1 });
});

streamController.on("stopped", (code) => {
  // If the pipeline died before reaching "started" (e.g. ALSA device missing,
  // GStreamer plugin error), nothing else will ever clear isRestartInProgress.
  // Clear it here and restore the idle preview so the UI doesn't stay blank.
  const reachedStarted = _streamReachedStarted[1];
  _streamReachedStarted[1] = false;
  if (!reachedStarted && isRestartInProgress[1]) {
    console.warn(`⚠️  [Cam1] Stream exited (code ${code}) before reaching 'started' — clearing restart flag and restoring idle preview`);
    isRestartInProgress[1] = false;
    startPersistentIdlePreview(1)
      .then(() => io.emit("refreshIdlePreview", { cameraIndex: 1 }))
      .catch((err) => console.error("⚠️  [Cam1] idle preview restore failed:", err.message));
  }
  if (isRestartInProgress[1]) return;
  const status = streamController.getStatus();
  io.emit("streamStatus", { ...status, status: "stopped", code, cameraIndex: 1 });
  io.emit("streamDrift",  { ppm: null, cameraIndex: 1 });
});

streamController.on("error", (error) => {
  io.emit("streamError", { error, cameraIndex: 1 });
});

streamController.on("log", (log) => {
  console.log("Stream log [Cam1]:", log);
});

streamController.on("fps", (fps) => {
  io.emit("streamFps", { fps, cameraIndex: 1 });
});

streamController.on("bitrate", (mbps) => {
  io.emit("streamBitrate", { mbps, cameraIndex: 1 });
});

streamController.on("drift", (ppm) => {
  io.emit("streamDrift", { ppm, cameraIndex: 1 });
});

// ── Stream controller event handlers (Camera 2) ───────────────────────────────
streamController2.on("preparing", () => {
  const status = streamController2.getStatus();
  io.emit("streamStatus", { ...status, status: "preparing", cameraIndex: 2 });
});

streamController2.on("started", () => {
  _streamReachedStarted[2] = true;
  isRestartInProgress[2] = false;
  const status = streamController2.getStatus();
  io.emit("streamStatus", { ...status, status: "started", cameraIndex: 2 });
});

streamController2.on("stopped", (code) => {
  // If the pipeline died before reaching "started" (e.g. ALSA device missing,
  // GStreamer plugin error), nothing else will ever clear isRestartInProgress.
  // Clear it here and restore the idle preview so the UI doesn't stay blank.
  const reachedStarted = _streamReachedStarted[2];
  _streamReachedStarted[2] = false;
  if (!reachedStarted && isRestartInProgress[2]) {
    console.warn(`⚠️  [Cam2] Stream exited (code ${code}) before reaching 'started' — clearing restart flag and restoring idle preview`);
    isRestartInProgress[2] = false;
    startPersistentIdlePreview(2)
      .then(() => io.emit("refreshIdlePreview", { cameraIndex: 2 }))
      .catch((err) => console.error("⚠️  [Cam2] idle preview restore failed:", err.message));
  }
  if (isRestartInProgress[2]) return;
  const status = streamController2.getStatus();
  io.emit("streamStatus", { ...status, status: "stopped", code, cameraIndex: 2 });
  io.emit("streamDrift",  { ppm: null, cameraIndex: 2 });
});

streamController2.on("error", (error) => {
  io.emit("streamError", { error, cameraIndex: 2 });
});

streamController2.on("log", (log) => {
  console.log("Stream log [Cam2]:", log);
});

streamController2.on("fps", (fps) => {
  io.emit("streamFps", { fps, cameraIndex: 2 });
});

streamController2.on("bitrate", (mbps) => {
  io.emit("streamBitrate", { mbps, cameraIndex: 2 });
});

streamController2.on("drift", (ppm) => {
  io.emit("streamDrift", { ppm, cameraIndex: 2 });
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
// iOS and Android run two independent checks when joining a WiFi network:
//
//   HTTP probe  (port 80 → 3000):
//     Always return 302 → admin UI.  This opens the OS captive-portal
//     mini-browser on EVERY connection automatically, so the user always
//     lands on the control panel without typing an IP address.
//
//   HTTPS probe (port 443 → 3443, iOS 14+):
//     Always return 200 Success.  This is the internet-connectivity check —
//     iOS uses it to decide whether to stay on the network.  A 200 here
//     keeps the phone on the hotspot even while the HTTP probe returns a
//     redirect.  These two checks are independent.
//
// Net result: portal opens on every connect AND phone never switches away.
// Requires the self-signed cert at /etc/ssl/digitalpool/cert.pem (see README § 7c).
//
// Windows NCSI always gets the literal text it expects; a redirect breaks it.

const _CAPTIVE_SUCCESS_HTML = '<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>';
const _CAPTIVE_PORTAL_URL   = `http://${DEFAULT_AP_IP}:${PORT}`;

function _sendCaptiveResponse(req, res) {
  const isHttps = !!(req.socket && req.socket.encrypted);
  const cleanIp = (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (isHttps) {
    // HTTPS internet-connectivity check → always Success (keeps phone on hotspot)
    console.log(`📶 Captive portal probe (HTTPS✓): ${req.method} ${req.path} from ${cleanIp}`);
    res.set('Content-Type', 'text/html').set('Cache-Control', 'no-store').send(_CAPTIVE_SUCCESS_HTML);
  } else {
    // HTTP captive-portal probe → always redirect → mini-browser opens every time
    console.log(`📶 Captive portal probe (HTTP→portal): ${req.method} ${req.path} from ${cleanIp}`);
    res.set('Cache-Control', 'no-store').redirect(302, _CAPTIVE_PORTAL_URL);
  }
}

function _sendCaptive204(req, res) {
  const isHttps = !!(req.socket && req.socket.encrypted);
  const cleanIp = (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  console.log(`📶 Captive portal probe (${isHttps ? 'HTTPS✓' : 'HTTP→portal'}): ${req.method} ${req.path} from ${cleanIp}`);
  if (isHttps) {
    res.status(204).end();
  } else {
    res.set('Cache-Control', 'no-store').redirect(302, _CAPTIVE_PORTAL_URL);
  }
}

// Apple probes (iOS 6+, macOS)
app.get('/hotspot-detect.html',          _sendCaptiveResponse);
app.get('/library/test/success.html',    _sendCaptiveResponse);
app.get('/success.html',                 _sendCaptiveResponse);
// Android / Chrome probes
app.get('/generate_204',                 _sendCaptive204);
app.get('/gen_204',                      _sendCaptive204);
// Windows NCSI — always return exact expected text (redirect breaks NCSI)
app.get('/ncsi.txt',        (req, res) => { console.log(`📶 Captive NCSI from ${req.ip}`);        res.send('Microsoft NCSI'); });
app.get('/connecttest.txt', (req, res) => { console.log(`📶 Captive connecttest from ${req.ip}`); res.send('Microsoft Connect Test'); });
app.get('/redirect',        (req, res) => { console.log(`📶 Captive redirect from ${req.ip}`);    res.send('Microsoft Connect Test'); });
// Amazon Kindle / Fire OS
app.get('/kindle-wifi/wifistub.html',    _sendCaptiveResponse);
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

// dpadmin-only — used for sensitive system toggles (SSH enable/disable, etc.)
// Hotspot users are NOT implicitly dpadmin: physical-network presence shouldn't
// grant the ability to open SSH on the box.
function requireDpAdmin(req, res, next) {
  if (req.session?.user?.username === "dpadmin") return next();
  res.status(403).json({ error: "dpadmin access required" });
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

// ── Remote Access (NetBird) API ── admin only ───────────────────────────────
const REMOTE_CONFIG_FILE = path.join(__dirname, "remote.json");

function loadRemoteConfig() {
  try {
    if (fsSync.existsSync(REMOTE_CONFIG_FILE))
      return JSON.parse(fsSync.readFileSync(REMOTE_CONFIG_FILE, "utf8"));
  } catch (e) { /* ignore */ }
  return { deviceName: "", enabled: false, registered: false, ownerEmail: "", registeredAt: null };
}

function saveRemoteConfig(cfg) {
  fsSync.writeFileSync(REMOTE_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

/**
 * The device name is NOT user-settable.  It is permanently the system hostname
 * assigned at flash/reset time (dp-stream-<last 4 of MAC>).  The flash script
 * seeds remote.json with it; this returns the authoritative, sanitised value,
 * falling back to the live OS hostname if the config was cleared.
 */
function getDeviceName() {
  const cfg = loadRemoteConfig();
  const raw = cfg.deviceName || os.hostname() || "digitalpool-camera";
  return raw.trim().toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "digitalpool-camera";
}

/**
 * Return this device's primary hardware MAC address (lowercase, colon-separated).
 * Always prefers the wired ethernet NIC (en/eth) and returns its burned-in MAC
 * even when the port has no cable/link — this is the interface the hostname
 * suffix (dp-stream-<last 4>) is derived from, so the two always agree.  Falls
 * back to WiFi (wl) then any other physical NIC only when no wired port exists.
 * Returns "" if none can be read.
 */
function getPrimaryMac() {
  const NET_DIR = "/sys/class/net";
  // Lower rank = higher priority: wired ethernet first, then WiFi, then other.
  const rank = (n) => (/^(en|eth)/.test(n) ? 0 : /^wl/.test(n) ? 1 : 2);
  try {
    // Reading /sys/.../address returns the MAC regardless of carrier/link state,
    // so a wired port with no cable plugged in still wins over WiFi.
    const ordered = fsSync.readdirSync(NET_DIR).sort((a, b) => rank(a) - rank(b));
    for (const iface of ordered) {
      if (iface === "lo") continue;
      // Skip virtual interfaces (no backing device) — matches firstboot.
      if (!fsSync.existsSync(`${NET_DIR}/${iface}/device`)) continue;
      let mac = "";
      try { mac = fsSync.readFileSync(`${NET_DIR}/${iface}/address`, "utf8").trim().toLowerCase(); }
      catch { continue; }
      if (mac && mac !== "00:00:00:00:00:00") return mac;
    }
  } catch { /* not Linux / no sysfs — fall through */ }
  // Fallback: os.networkInterfaces() (skips internal + null MACs).  Note this
  // only lists interfaces that are up, so it's a last resort — the sysfs path
  // above is what covers a wired port with no active link.
  try {
    const nics = os.networkInterfaces();
    for (const name of Object.keys(nics).sort((a, b) => rank(a) - rank(b))) {
      if (name === "lo") continue;
      for (const addr of nics[name] || []) {
        if (addr.internal) continue;
        const mac = (addr.mac || "").toLowerCase();
        if (mac && mac !== "00:00:00:00:00:00") return mac;
      }
    }
  } catch { /* ignore */ }
  return "";
}

/**
 * POST a registration payload to the DigitalPool Firebase Cloud Function.
 * The function authenticates the operator's DigitalPool account server-side,
 * verifies venue ownership, records the device + its NetBird IP, and returns
 * the account's venue(s).  No Firebase API keys or SDK live on the device — the
 * only thing sent is the operator's email + password over HTTPS, and only during
 * registration (never persisted).
 *
 * Resolves to { statusCode, body }.  `body` is the parsed JSON response.
 */
function callDigitalPoolRegister(payload) {
  const base = (process.env.DIGITALPOOL_FUNCTIONS_URL
    || "https://us-central1-digital-pool.cloudfunctions.net").replace(/\/$/, "");
  const fn      = process.env.DIGITALPOOL_REGISTER_FUNCTION || "registerCameraDevice";
  const fullUrl = `${base}/${fn}`;
  const urlObj  = new URL(fullUrl);
  const mod     = fullUrl.startsWith("https") ? require("https") : require("http");
  const reqBody = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: urlObj.hostname,
      port:     urlObj.port || (fullUrl.startsWith("https") ? 443 : 80),
      path:     urlObj.pathname + urlObj.search,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        Accept:           "application/json",
        "Content-Length": Buffer.byteLength(reqBody),
      },
      timeout: 20000,
    };
    const req = mod.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let body = {};
        try { body = data ? JSON.parse(data) : {}; } catch { body = { raw: data }; }
        resolve({ statusCode: res.statusCode, body });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("DigitalPool registration request timed out")); });
    req.write(reqBody);
    req.end();
  });
}

/**
 * Bring NetBird up with this device's hostname and poll until it has an IP.
 * Returns the assigned NetBird IP ("" if none within the deadline).
 */
async function ensureNetbirdUp() {
  const name          = getDeviceName();
  const setupKey      = process.env.NETBIRD_SETUP_KEY || "";
  const managementUrl = (process.env.NETBIRD_MANAGEMENT_URL || "").replace(/\/$/, "");
  if (!setupKey) throw new Error("NETBIRD_SETUP_KEY is not configured on this device");

  const cfg   = loadRemoteConfig();
  let upCmd   = `sudo /usr/bin/netbird up --hostname=${name}`;
  if (managementUrl) upCmd += ` --management-url=${managementUrl}`;
  upCmd += ` --setup-key=${setupKey}`;
  if (cfg.sshEnabled) upCmd += ` --allow-server-ssh --enable-ssh-root`;

  try {
    await execAsync(upCmd, { timeout: 30000 });
  } catch (e) {
    console.warn("netbird up (register) warning:", e.stderr || e.message);
  }

  // netbird up returns quickly (queues in background); IP assignment from the
  // management server typically takes 5–20 s on a fresh registration.
  let ip = "";
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const st = await netbirdGetStatus();
      if (st.connected && st.ip) { ip = st.ip; break; }
      const remaining = Math.round((deadline - Date.now()) / 1000);
      console.log(`⏳ Registration: status=${st.raw?.daemonStatus || "unknown"} ip=${st.ip || "none"} (${remaining}s left)`);
    } catch { /* daemon not ready yet */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  return ip;
}

/**
 * Call the cloud function's `assign` action and, on success, persist the device
 * as registered (venue id/name, device id, NetBird IP).  Sends the HTTP response.
 * The password is used only for this call and never written to disk.
 */
async function finalizeRegistration(res, { email, password, venueId, venueName, venueSlug, deviceName, ip }) {
  const macAddress = getPrimaryMac();
  let assign;
  try {
    assign = await callDigitalPoolRegister({ action: "assign", email, password, venueId, deviceName, macAddress, netbirdIp: ip });
  } catch (e) {
    return res.status(502).json({ error: `Could not reach DigitalPool registration service: ${e.message}` });
  }

  if (assign.statusCode === 401 || assign.body?.ok === false)
    return res.status(401).json({ error: assign.body?.error || "DigitalPool rejected the registration" });
  if (assign.statusCode >= 400)
    return res.status(502).json({ error: assign.body?.error || `Registration service error (HTTP ${assign.statusCode})` });

  const cfg = loadRemoteConfig();
  cfg.deviceName   = deviceName;
  cfg.ownerEmail   = email;
  cfg.netbirdIp    = ip;
  cfg.macAddress   = macAddress;
  cfg.venueId      = assign.body?.venue_id   || assign.body?.venueId   || venueId;
  // Prefer the values the registration response returns; fall back to what we
  // already knew (from the verify venue list / the operator's picker choice).
  cfg.venueName    = assign.body?.venue_name || assign.body?.venueName || venueName || "";
  cfg.venueSlug    = assign.body?.venue_slug || assign.body?.venueSlug || venueSlug || "";
  cfg.deviceId     = assign.body?.device_id  || assign.body?.deviceId  || "";
  cfg.registered   = true;
  cfg.registeredAt = new Date().toISOString();
  saveRemoteConfig(cfg);
  console.log(`✅ Device registered: ${deviceName} / ${email} → venue ${cfg.venueName || cfg.venueId} — NetBird IP ${ip}`);
  return res.json({
    success: true, ip, deviceName, ownerEmail: email,
    venueId: cfg.venueId, venueName: cfg.venueName, venueSlug: cfg.venueSlug, deviceId: cfg.deviceId,
  });
}

// ── NetBird Management API helpers ───────────────────────────────────────────

/**
 * Make a request to the NetBird Management REST API.
 * Requires NETBIRD_API_TOKEN in .env (personal access token from vpn.digitalpool.com).
 */
function netbirdApiRequest(method, apiPath, body = null) {
  const token   = process.env.NETBIRD_API_TOKEN || "";
  if (!token) return Promise.reject(new Error("NETBIRD_API_TOKEN is not configured"));

  const baseUrl = (process.env.NETBIRD_MANAGEMENT_URL || "https://vpn.digitalpool.com").replace(/\/$/, "");
  const fullUrl = `${baseUrl}/api${apiPath}`;
  const urlObj  = new URL(fullUrl);
  const mod     = fullUrl.startsWith("https") ? require("https") : require("http");
  const reqBody = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: urlObj.hostname,
      port:     urlObj.port || (fullUrl.startsWith("https") ? 443 : 80),
      path:     urlObj.pathname + urlObj.search,
      method,
      headers: {
        Authorization: `Token ${token}`,
        Accept:        "application/json",
        ...(reqBody ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(reqBody) } : {}),
      },
      timeout: 10000,
    };
    const req = mod.request(options, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
        } else {
          reject(new Error(`NetBird API ${method} ${apiPath} → HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("NetBird API request timed out")); });
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

/**
 * Find this device's peer record on the NetBird server (by matching the local
 * NetBird IP) and delete it.  Logs a warning and resolves null if the peer
 * cannot be found or the API token is not configured — the local wipe can still
 * proceed in that case.
 */
async function netbirdDeleteCurrentPeer() {
  let localIp;
  try {
    const st = await netbirdGetStatus();
    localIp = st.ip; // e.g. "100.64.0.10"
  } catch {
    console.warn("⚠️ netbirdDeleteCurrentPeer: could not get local status — skipping server-side delete");
    return null;
  }

  if (!localIp) {
    console.warn("⚠️ netbirdDeleteCurrentPeer: NetBird not connected — skipping server-side delete");
    return null;
  }

  const peers = await netbirdApiRequest("GET", "/peers");
  // The API returns IP in CIDR form (e.g. "100.64.0.10/16") — strip the prefix for comparison
  const peer = Array.isArray(peers)
    ? peers.find(p => (p.ip || "").split("/")[0] === localIp)
    : null;

  if (!peer) {
    console.warn(`⚠️ netbirdDeleteCurrentPeer: no peer with IP ${localIp} found on server`);
    return null;
  }

  console.log(`🗑️ Deleting NetBird peer: ${peer.name} (id: ${peer.id}, ip: ${localIp})`);
  await netbirdApiRequest("DELETE", `/peers/${peer.id}`);
  console.log("✅ Peer deleted from NetBird server");
  return peer.id;
}

// ── Registration helpers ─────────────────────────────────────────────────────

/**
 * Returns true when the device has been registered (netbird up succeeded with
 * a name + email stored).  Backwards-compat: devices already deployed that have
 * a deviceName but no `registered` field are treated as registered so existing
 * deployments are not broken.
 */
function isRegistered() {
  const cfg = loadRemoteConfig();
  if (cfg.registered === true) return true;
  if (cfg.registered === undefined && cfg.deviceName) return true;
  return false;
}

/**
 * Probe whether the device has an outbound internet connection by attempting a
 * HEAD request to the NetBird management URL (or vpn.digitalpool.com as the
 * default).  Resolves to true/false within 5 s.
 */
function checkInternet() {
  return new Promise((resolve) => {
    const raw = (process.env.NETBIRD_MANAGEMENT_URL || "https://vpn.digitalpool.com")
      .replace(/\/$/, "");
    const mod = raw.startsWith("https") ? require("https") : require("http");
    try {
      const req = mod.request(raw, { method: "HEAD", timeout: 5000 }, () => {
        resolve(true);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.end();
    } catch { resolve(false); }
  });
}

/**
 * Middleware — rejects stream-start requests when the device has not been
 * registered yet.  dpadmin bypasses the gate for support access.
 */
function requireRegistered(req, res, next) {
  if (req.session?.user?.username === "dpadmin") return next();
  if (isRegistered()) return next();
  return res.status(403).json({
    error: "Device not registered. Complete registration in Admin Settings first.",
    registrationRequired: true,
  });
}

/**
 * Parse `netbird status --json` and return { ip, connected }.
 * netbirdIp is returned in CIDR form (e.g. "100.64.0.10/16"); we strip the prefix.
 * Handles both legacy ("status"/"IP") and current ("daemonStatus"/"netbirdIp") field names.
 */
async function netbirdGetStatus() {
  const { stdout } = await execAsync("netbird status --json 2>/dev/null");
  const nb = JSON.parse(stdout);
  const lp = nb.localPeerState || {};

  // Field name varies across netbird versions — try all known variants
  let rawIp = lp.netbirdIp || lp.IP || lp.ip || null;

  // Fallback: some netbird versions (0.73.x on Linux) return localPeerState: {}
  // even when fully connected.  Parse the human-readable text output instead.
  if (!rawIp) {
    try {
      const { stdout: txt } = await execAsync("netbird status 2>/dev/null");
      const m = txt.match(/NetBird IP:\s*([\d.]+(?:\/\d+)?)/);
      if (m) rawIp = m[1];
    } catch { /* ignore */ }
  }

  const ip = rawIp ? rawIp.split("/")[0] : null;
  const connected = nb.daemonStatus === "Connected" || nb.status === "Connected";
  return { ip, connected, raw: nb };
}

app.get("/api/remote/status", requireAdmin, async (req, res) => {
  try {
    // netbird status --json gives us everything we need
    const { ip, connected, raw } = await netbirdGetStatus();
    const state = raw.daemonStatus || raw.status || "Disconnected";
    res.json({ enabled: connected, ip, deviceName: getDeviceName(), backendState: state });
  } catch {
    // netbird not installed or daemon not running yet
    res.json({ enabled: false, ip: null, deviceName: getDeviceName(), backendState: "Stopped" });
  }
});

// ── Device registration ──────────────────────────────────────────────────────

// GET /api/setup/status — UI polls this to decide what to show
app.get("/api/setup/status", requireAdmin, async (req, res) => {
  const cfg = loadRemoteConfig();
  const registered = isRegistered();
  // Skip slow internet probe when already registered — device clearly has connectivity
  const hasInternet = registered ? true : await checkInternet();
  let netbirdIp = null;
  try {
    const st = await netbirdGetStatus();
    netbirdIp = st.ip || null;
  } catch { /* netbird not running */ }
  res.json({
    registered,
    hasInternet,
    deviceName:   getDeviceName(),
    ownerEmail:   cfg.ownerEmail   || "",
    venueName:    cfg.venueName    || "",
    venueId:      cfg.venueId      || "",
    venueSlug:    cfg.venueSlug    || "",
    registeredAt: cfg.registeredAt || null,
    netbirdIp,
  });
});

// POST /api/setup/register — step 1 of registration.
// Body: { email, password } (DigitalPool account credentials).
// Brings NetBird up to obtain this device's VPN IP, then verifies the account
// and lists its venues via the DigitalPool cloud function.  The cloud-function
// payload also carries deviceName, the device's primary MAC address, and the
// NetBird IP.  Outcomes:
//   • one venue (or one already assigned) → auto-assigns + finalizes (success)
//   • multiple venues → { chooseVenue: true, venues } (client shows a picker)
//   • no venue        → { needVenue: true }
// Per design: NetBird stays up even if verification fails (the peer is kept).
// The password is used only for the cloud-function calls and is never persisted.
app.post("/api/setup/register", requireAdmin, express.json(), async (req, res) => {
  const email    = (req.body?.email || req.body?.ownerEmail || "").trim().toLowerCase();
  const password = req.body?.password || "";
  if (!email || !password)
    return res.status(400).json({ error: "DigitalPool email and password are required" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: "Invalid email address" });

  const deviceName = getDeviceName();
  const macAddress = getPrimaryMac();

  // 1. Join the VPN first so we have an IP to report to DigitalPool.
  let ip;
  try {
    ip = await ensureNetbirdUp();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!ip)
    return res.status(500).json({ error: "NetBird did not receive an IP within 90 s. Check service logs." });

  // Persist name + email + IP + MAC immediately (never the password) so they
  // survive a crash mid-registration.  `registered` stays false until a venue
  // is assigned.
  const cfg = loadRemoteConfig();
  cfg.deviceName = deviceName;
  cfg.ownerEmail = email;
  cfg.netbirdIp  = ip;
  cfg.macAddress = macAddress;
  saveRemoteConfig(cfg);

  // 2. Verify credentials + fetch venues.
  let verify;
  try {
    verify = await callDigitalPoolRegister({ action: "verify", email, password, deviceName, macAddress, netbirdIp: ip });
  } catch (e) {
    return res.status(502).json({ error: `Could not reach DigitalPool registration service: ${e.message}` });
  }

  if (verify.statusCode === 401 || verify.body?.ok === false)
    return res.status(401).json({ error: verify.body?.error || "Invalid DigitalPool credentials" });
  if (verify.statusCode >= 400)
    return res.status(502).json({ error: verify.body?.error || `Registration service error (HTTP ${verify.statusCode})` });

  // Normalise the venue list to { id, name } regardless of the field casing the
  // function returns (venue_id/venue_name or id/name).
  const rawVenues = Array.isArray(verify.body?.venues) ? verify.body.venues : [];
  const venues = rawVenues.map(v => ({
    id:   v.venue_id   || v.id   || "",
    name: v.venue_name || v.name || "",
    slug: v.venue_slug || v.slug || "",
  })).filter(v => v.id);
  const assignedVenueId = verify.body?.assigned_venue_id || verify.body?.assignedVenueId || null;

  if (venues.length === 0)
    return res.json({ needVenue: true, ip });

  // Auto-select when there's exactly one venue, or one already assigned to this device.
  let venueId = null, venueName = "", venueSlug = "";
  const selected = assignedVenueId
    ? venues.find(v => v.id === assignedVenueId)
    : (venues.length === 1 ? venues[0] : null);
  if (selected) {
    venueId   = selected.id;
    venueName = selected.name || "";
    venueSlug = selected.slug || "";
  }

  if (!venueId)
    return res.json({ chooseVenue: true, venues, ip });

  // 3. Assign + finalize.
  return finalizeRegistration(res, { email, password, venueId, venueName, venueSlug, deviceName, ip });
});

// POST /api/setup/register/venue — step 2, called when the operator picks a venue.
// Body: { email, password, venueId }.  NetBird is already up from step 1.
app.post("/api/setup/register/venue", requireAdmin, express.json(), async (req, res) => {
  const email     = (req.body?.email || "").trim().toLowerCase();
  const password  = req.body?.password  || "";
  const venueId   = req.body?.venueId   || "";
  const venueName = req.body?.venueName || "";   // known from the picker; assign response wins
  const venueSlug = req.body?.venueSlug || "";
  if (!email || !password || !venueId)
    return res.status(400).json({ error: "Email, password and venue are required" });

  const deviceName = getDeviceName();

  // NetBird should already be up from step 1 — fetch the current IP; bring it up
  // again only as a fallback (e.g. daemon restarted between steps).
  let ip = "";
  try { const st = await netbirdGetStatus(); ip = st.ip || ""; } catch { /* not running */ }
  if (!ip) {
    try { ip = await ensureNetbirdUp(); } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  if (!ip)
    return res.status(500).json({ error: "NetBird IP unavailable — restart registration." });

  return finalizeRegistration(res, { email, password, venueId, venueName, venueSlug, deviceName, ip });
});

app.post("/api/remote/enable", requireAdmin, express.json(), async (req, res) => {
  const cfg = loadRemoteConfig();
  // Device name is not user-settable — always the system hostname.
  const name = getDeviceName();
  // force:true = cloned-device / re-registration path — wipes node identity so
  // NetBird assigns a completely fresh peer and IP.
  const force = !!req.body?.force;

  cfg.deviceName = name;
  cfg.enabled    = true;
  saveRemoteConfig(cfg);
  try {
    const managementUrl = process.env.NETBIRD_MANAGEMENT_URL || "";
    const setupKey      = process.env.NETBIRD_SETUP_KEY || "";

    if (force) {
      // Re-register as a brand-new device (cloned SD card path).
      //
      // Sequence:
      //   1. Stop netbird daemon
      //   2. Clear /var/lib/netbird/ (destroys node private key on disk)
      //   3. Start daemon fresh (NeedsLogin state — will not auto-connect)
      //   4. netbird up --setup-key=... → fresh peer registration in NetBird

      console.log("🔄 Force re-register: stopping netbird daemon…");
      await execAsync("sudo /usr/bin/systemctl stop netbird").catch(() => {});
      await new Promise(r => setTimeout(r, 1000));

      console.log("🔄 Force re-register: clearing node state…");
      await execAsync("sudo rm -rf /var/lib/netbird/").catch(() => {});

      console.log("🔄 Force re-register: starting fresh netbird daemon…");
      await execAsync("sudo /usr/bin/systemctl start netbird").catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      console.log("🔄 Force re-register: daemon ready — running netbird up…");
    }

    // Build the netbird up command.
    // --hostname sets the display name in the NetBird dashboard.
    // Omit --timeout so the command doesn't exit early on a fresh state wipe —
    // the daemon will keep trying in the background and we poll for Connected below.
    const latestCfg2 = loadRemoteConfig();
    let upCmd = `sudo /usr/bin/netbird up --hostname=${name}`;
    if (managementUrl)       upCmd += ` --management-url=${managementUrl}`;
    if (setupKey)            upCmd += ` --setup-key=${setupKey}`;
    if (latestCfg2.sshEnabled) upCmd += ` --allow-server-ssh --enable-ssh-root`;

    try {
      await execAsync(upCmd, { timeout: 30000 });
    } catch (e) {
      // Non-zero exit is sometimes returned even on success (e.g. "already connected")
      // so we fall through and poll for Connected state below.
      console.warn("netbird up warning:", e.stderr || e.message);
    }

    // Poll netbird status until daemonStatus === "Connected" + IP assigned (up to 90 s).
    let ip = "";
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      try {
        const st = await netbirdGetStatus();
        if (st.connected && st.ip) {
          ip = st.ip;
          break;
        }
        const remaining = Math.round((deadline - Date.now()) / 1000);
        console.log(`⏳ NetBird status: ${st.raw?.daemonStatus || st.raw?.status || "unknown"} ip=${st.ip || "none"} (${remaining}s left)`);
      } catch { /* status not ready yet */ }
      await new Promise(r => setTimeout(r, 3000));
    }

    if (ip) {
      // NOTE: enabling the VPN does NOT mark the device registered.  Registration
      // is a separate step that must go through the DigitalPool cloud function
      // (/api/setup/register) so the account is verified and a venue is assigned.
      const latestCfg = loadRemoteConfig();
      latestCfg.netbirdIp = ip;
      saveRemoteConfig(latestCfg);
      res.json({ success: true, ip, deviceName: name, reregistered: force });
    } else {
      res.status(500).json({ error: "NetBird registered but did not reach Connected state within 30 s. Check service logs." });
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
    await execAsync("sudo netbird down");
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/remote/wipe — delete this peer from the NetBird server AND wipe
// local identity, but do NOT run netbird up.  The UI then shows the registration
// form so the user can submit fresh details via /api/setup/register.
app.post("/api/remote/wipe", requireAdmin, async (req, res) => {
  const log = [];
  try {
    // 0. Stop any active stream(s) first — a deregistered device must not keep
    //    streaming, and requireRegistered only blocks NEW streams (an already-
    //    running one would otherwise continue after the wipe).
    if (streamController.isStreaming || streamController2.isStreaming) {
      log.push("🔄 Stopping active stream(s) before deregister…");
      try { await streamController.stopStream(); }  catch { /* not streaming */ }
      try { await streamController2.stopStream(); } catch { /* not streaming */ }
      log.push("✅ Stream(s) stopped");
    }

    // 1. Remove the device record from DigitalPool via the cloud function
    //    (identity-based deregister — no password).  Best-effort: a failure here
    //    must not block the local + NetBird de-registration.  Done first, while
    //    the stored identifiers are still available.
    const cfg0 = loadRemoteConfig();
    if (cfg0.deviceId || cfg0.macAddress || cfg0.netbirdIp) {
      try {
        const dereg = await callDigitalPoolRegister({
          action:     "deregister",
          email:      cfg0.ownerEmail || "",
          deviceName: getDeviceName(),
          macAddress: cfg0.macAddress || getPrimaryMac(),
          netbirdIp:  cfg0.netbirdIp  || "",
          venueId:    cfg0.venueId    || "",
          deviceId:   cfg0.deviceId   || "",
        });
        if (dereg.statusCode >= 400 || dereg.body?.ok === false) {
          log.push(`⚠️ DigitalPool deregister returned HTTP ${dereg.statusCode}: ${dereg.body?.error || "error"} — continuing local wipe`);
        } else {
          log.push("✅ Device removed from DigitalPool");
        }
      } catch (e) {
        log.push(`⚠️ DigitalPool deregister failed: ${e.message} — continuing local wipe`);
        console.warn("DigitalPool deregister:", e.message);
      }
    }

    // 2. Delete from NetBird server (best-effort — needs NETBIRD_API_TOKEN)
    try {
      const deleted = await netbirdDeleteCurrentPeer();
      log.push(deleted
        ? `✅ Peer deleted from NetBird server (id: ${deleted})`
        : "⚠️ Peer not found on server — may already be gone");
    } catch (e) {
      // Missing token or API error — warn but continue with local wipe
      log.push(`⚠️ Server-side delete skipped: ${e.message}`);
      console.warn("netbirdDeleteCurrentPeer:", e.message);
    }

    // 3. Stop daemon, clear local identity
    log.push("🔄 Stopping netbird daemon…");
    await execAsync("sudo /usr/bin/systemctl stop netbird").catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    log.push("🔄 Clearing local node state…");
    await execAsync("sudo rm -rf /var/lib/netbird/").catch(e => {
      throw new Error(`rm -rf /var/lib/netbird/ failed: ${e.stderr || e.message}`);
    });

    log.push("🔄 Starting fresh daemon…");
    await execAsync("sudo /usr/bin/systemctl start netbird").catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    // 4. Clear registered state + venue association (the device no longer exists
    //    on DigitalPool).  Keep name/email/MAC for pre-fill and identity.
    const cfg = loadRemoteConfig();
    cfg.registered   = false;
    cfg.registeredAt = null;
    cfg.venueId      = "";
    cfg.venueName    = "";
    cfg.venueSlug    = "";
    cfg.deviceId     = "";
    saveRemoteConfig(cfg);

    log.push("✅ Wipe complete — ready for re-registration");
    console.log(log.join("\n"));
    res.json({ success: true, deviceName: cfg.deviceName, ownerEmail: cfg.ownerEmail, log });
  } catch (e) {
    console.error("❌ /api/remote/wipe error:", e.message);
    res.status(500).json({ error: e.message, log });
  }
});

// ── SSH (openssh-server) ── dpadmin only ─────────────────────────────────────
// Toggles ssh.socket AND ssh.service.  Modern Ubuntu uses socket activation, so
// stopping ssh.service alone leaves ssh.socket listening on :22 and the
// service is respawned on the next connection — both must be toggled.
// Requires NOPASSWD sudoers entries:
//   ubuntu ALL=(ALL) NOPASSWD: /usr/bin/systemctl enable --now ssh
//   ubuntu ALL=(ALL) NOPASSWD: /usr/bin/systemctl disable --now ssh
//   ubuntu ALL=(ALL) NOPASSWD: /usr/bin/systemctl enable --now ssh.socket
//   ubuntu ALL=(ALL) NOPASSWD: /usr/bin/systemctl disable --now ssh.socket
// SSH is a sensitive system toggle, so it is restricted to the dpadmin support
// account — venue admins/operators and hotspot users cannot open SSH on the box.
app.get("/api/remote/ssh/status", requireDpAdmin, async (req, res) => {
  const cfg = loadRemoteConfig();
  // systemctl returns non-zero when inactive/disabled/missing, so swallow the
  // rejection and read the stdout that execAsync attaches to the error object.
  const probe = async (cmd) => {
    try { return (await execAsync(cmd)).stdout.trim(); }
    catch (e) { return (e.stdout || "").trim(); }
  };
  const [svcActive, svcEnabled, sockActive, sockEnabled] = await Promise.all([
    probe("systemctl is-active ssh"),
    probe("systemctl is-enabled ssh"),
    probe("systemctl is-active ssh.socket"),
    probe("systemctl is-enabled ssh.socket"),
  ]);
  // Either unit being up means SSH is reachable; either being enabled means
  // it'll come back on reboot.
  const active  = svcActive  === "active"  || sockActive  === "active";
  const enabled = svcEnabled === "enabled" || sockEnabled === "enabled";
  let ip = null;
  try {
    const st = await netbirdGetStatus();
    ip = st.ip || null;
  } catch { /* netbird not running */ }
  // Only dpadmin reaches this handler (requireDpAdmin), so toggling is allowed.
  res.json({ active, enabled, ip, persisted: !!cfg.sshEnabled, isDpAdmin: true, canToggleSsh: true });
});

// Helper: run a sudo command and tolerate "unit not found" / "no such file"
// errors so a box without ssh.socket (or without ssh.service) doesn't fail
// the whole toggle — we only need at least one of the two to succeed.
async function tryUnitCmd(cmd) {
  try { await execAsync(cmd); return { ok: true }; }
  catch (e) {
    const err = ((e.stderr || e.message || "") + "").toLowerCase();
    if (err.includes("not found") || err.includes("no such")) return { ok: false, missing: true };
    return { ok: false, error: (e.stderr || e.message || "").trim() };
  }
}

app.post("/api/remote/ssh/enable", requireDpAdmin, async (req, res) => {
  // 1. Enable the SSH daemon (socket activation + service fallback)
  const sock = await tryUnitCmd("sudo /usr/bin/systemctl enable --now ssh.socket");
  const svc  = await tryUnitCmd("sudo /usr/bin/systemctl enable --now ssh");
  if (!sock.ok && !svc.ok) {
    return res.status(500).json({ error: sock.error || svc.error || "Failed to enable SSH" });
  }

  // 2. Restart NetBird with --allow-server-ssh --enable-ssh-root so the VPN
  //    daemon opens its SSH listener and configures the firewall to allow it.
  //    The device is already registered so no setup-key is needed — the daemon
  //    reads its identity from /var/lib/netbird/.
  try {
    await execAsync("sudo /usr/bin/netbird down").catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
    await execAsync(
      "sudo /usr/bin/netbird up --allow-server-ssh --enable-ssh-root",
      { timeout: 30000 }
    ).catch(e => console.warn("netbird up (ssh-enable) warning:", e.stderr || e.message));
  } catch (e) {
    console.warn("NetBird restart (ssh-enable) failed:", e.message);
    // Non-fatal — SSH daemon is up; VPN SSH access may not work until restarted
  }

  const cfg = loadRemoteConfig();
  cfg.sshEnabled = true;
  saveRemoteConfig(cfg);
  res.json({ success: true, active: true });
});

app.post("/api/remote/ssh/disable", requireDpAdmin, async (req, res) => {
  // 1. Disable the SSH daemon — socket first to close the listener immediately,
  //    then service.  Existing sessions stay open by design.
  const sock = await tryUnitCmd("sudo /usr/bin/systemctl disable --now ssh.socket");
  const svc  = await tryUnitCmd("sudo /usr/bin/systemctl disable --now ssh");
  if (!sock.ok && !svc.ok) {
    return res.status(500).json({ error: sock.error || svc.error || "Failed to disable SSH" });
  }

  // 2. Restart NetBird without the SSH flags so it removes its internal SSH
  //    listener and reverts the firewall rules.
  try {
    await execAsync("sudo /usr/bin/netbird down").catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
    await execAsync(
      "sudo /usr/bin/netbird up",
      { timeout: 30000 }
    ).catch(e => console.warn("netbird up (ssh-disable) warning:", e.stderr || e.message));
  } catch (e) {
    console.warn("NetBird restart (ssh-disable) failed:", e.message);
  }

  const cfg = loadRemoteConfig();
  cfg.sshEnabled = false;
  saveRemoteConfig(cfg);
  res.json({ success: true, active: false });
});

// NOTE: the device name is NOT user-settable — it is permanently the system
// hostname (dp-stream-<last 4 of MAC>) assigned at flash/reset time.  The former
// PUT /api/remote/name rename endpoint has been removed; use getDeviceName().

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

// API endpoint to restart the service without updating code (any logged-in user)
// process.exit(0) causes systemd (Restart=always) to bring it straight back up.
app.post("/api/restart", requireAuth, async (req, res) => {
  res.json({ success: true });
  setTimeout(() => {
    console.log("🔄 Restart requested via admin panel — restarting service via process.exit");
    process.exit(0);
  }, 800);
});

// API endpoint to reboot the entire device (any logged-in user)
app.post("/api/reboot", requireAuth, async (req, res) => {
  res.json({ success: true });
  setTimeout(() => {
    console.log("⚡ Device reboot requested via admin panel — running sudo reboot");
    execAsync("sudo reboot").catch(() => {});
  }, 800);
});

// API endpoint to power down the entire device (any logged-in user)
app.post("/api/shutdown", requireAuth, async (req, res) => {
  res.json({ success: true });
  setTimeout(() => {
    console.log("⚡ Device power down requested via admin panel — running sudo poweroff");
    execAsync("sudo poweroff").catch(() => {});
  }, 800);
});

// ── System image (golden clone) API — dpadmin only ────────────────────────────
// Captures a filesystem-level image of this device to a FILE on disk (see
// dp-create-image.sh), which is then downloaded (resumable) and managed from the
// UI. Flash onto a new device from a recovery USB with dp-restore.sh; sanitised
// on first boot by dp-firstboot.sh. See SYSTEM_IMAGE.md.
//
// Requires NOPASSWD sudoers (see SYSTEM_IMAGE.md):
//   dp ALL=(root) NOPASSWD: /usr/bin/bash /home/dp/digitalpool-camera/dp-create-image.sh *
const IMAGE_SCRIPT = path.join(__dirname, "dp-create-image.sh");
// MUST match the --exclude in dp-create-image.sh so captures don't tar in old images.
const IMAGES_DIR   = "/home/dp/system-images";

// In-memory state of the current/last capture job (only one runs at a time).
let imageJob = null; // { filename, path, startedAt, running, error, exitCode }

function isDpAdmin(req, res) {
  if (req.session?.user?.username !== "dpadmin") { res.status(403).json({ success: false, error: "Access denied" }); return false; }
  return true;
}
// Guard against path traversal: only our own image / recovery-ISO filenames are
// addressable (dp-image-*.tar.zst captures, dp-recovery-*.iso recovery media).
function safeImageName(name) {
  return typeof name === "string" && !name.includes("..") &&
    /^dp-(image|recovery)-[A-Za-z0-9._-]+\.(tar\.zst|iso)$/.test(name);
}
function imageFileSize(p) { try { return fsSync.statSync(p).size; } catch { return 0; } }
// Local-time YYYYMMDD-HHMM for filenames (uses the device's configured timezone,
// not UTC, so the stamp matches the operator's wall clock).
function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// Non-destructive: arch/disk/used/free so the UI can preview + gate.
app.get("/api/system/image/info", requireAdmin, async (req, res) => {
  if (!isDpAdmin(req, res)) return;
  try {
    const val = async (cmd) => (await execAsync(cmd).catch(() => ({ stdout: "" }))).stdout.trim();
    const arch     = await val("uname -m");
    const rootSrc  = await val("findmnt -no SOURCE / | head -n1");
    // Walk the block-device stack to the whole disk. Works for plain partitions
    // (nvme0n1p2→nvme0n1) AND device-mapper/LVM roots (ubuntu--vg-ubuntu--lv→sda),
    // where PKNAME returns nothing.
    const base     = rootSrc ? await val("lsblk -rnso NAME " + rootSrc + " | tail -n1") : "";
    const disk     = base ? "/dev/" + base : "";
    const usedB    = parseInt(await val("df -B1 --output=used / | tail -n1"), 10) || 0;
    const diskB    = disk ? parseInt(await val("blockdev --getsize64 " + disk), 10) || 0 : 0;
    const freeB    = parseInt(await val("df -B1 --output=avail / | tail -n1"), 10) || 0;
    const hasTools = !!(await val("command -v zstd")) && !!(await val("command -v sfdisk"));
    const scriptOk = fsSync.existsSync(IMAGE_SCRIPT);
    res.json({
      success: true, arch, disk, diskBytes: diskB, usedBytes: usedB, freeBytes: freeB,
      ready: hasTools && scriptOk && !!disk,
      missing: [ !hasTools && "zstd/sfdisk", !scriptOk && "dp-create-image.sh", !disk && "root disk" ].filter(Boolean),
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// List saved images + the state of any in-progress capture.
app.get("/api/system/image/list", requireAdmin, (req, res) => {
  if (!isDpAdmin(req, res)) return;
  let images = [];
  try {
    if (fsSync.existsSync(IMAGES_DIR)) {
      images = fsSync.readdirSync(IMAGES_DIR)
        // Only our own captures + recovery ISOs (hides the cached Ubuntu base ISO).
        .filter((f) => safeImageName(f))
        .map((f) => ({
          name: f,
          kind: f.endsWith(".iso") ? "iso" : "image",
          bytes: imageFileSize(path.join(IMAGES_DIR, f)),
          mtime: fsSync.statSync(path.join(IMAGES_DIR, f)).mtimeMs,
          partial: !!(imageJob && imageJob.running && imageJob.filename === f),
        }))
        .sort((a, b) => b.mtime - a.mtime);
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
  res.json({
    success: true, images,
    job: imageJob ? {
      kind: imageJob.kind || "capture", filename: imageJob.filename, running: imageJob.running,
      startedAt: imageJob.startedAt, error: imageJob.error || null, phase: imageJob.phase || null,
      bytes: imageFileSize(imageJob.progressPath || imageJob.path),
    } : null,
  });
});

// Start a capture to a file (async job). Returns immediately; poll /list for progress.
app.post("/api/system/image/create", requireAdmin, async (req, res) => {
  if (!isDpAdmin(req, res)) return;
  if (imageJob && imageJob.running)
    return res.status(409).json({ success: false, error: "A capture is already running" });
  if (!fsSync.existsSync(IMAGE_SCRIPT))
    return res.status(500).json({ success: false, error: "dp-create-image.sh not found" });
  try { fsSync.mkdirSync(IMAGES_DIR, { recursive: true }); }
  catch (e) { return res.status(500).json({ success: false, error: "cannot create " + IMAGES_DIR + ": " + e.message }); }
  // Rough free-space guard.
  try {
    const avail = parseInt((await execAsync("df -B1 --output=avail / | tail -n1")).stdout.trim(), 10) || 0;
    if (avail < 4e9) return res.status(400).json({ success: false, error: "Not enough free space (need >4 GB free on /)" });
  } catch { /* ignore */ }

  // Quiesce active streams so tar sees a settled filesystem.
  try { await streamController.stopStream(); }  catch { /* not streaming */ }
  try { await streamController2.stopStream(); } catch { /* not streaming */ }
  await execAsync("sync").catch(() => {});

  let appVersion = "unknown";
  try { appVersion = JSON.parse(fsSync.readFileSync(path.join(__dirname, "package.json"), "utf8")).version || "unknown"; } catch { /* ignore */ }
  const created = new Date().toISOString();          // manifest metadata (UTC, unambiguous)
  const arch = (await execAsync("uname -m").catch(() => ({ stdout: "unknown" }))).stdout.trim() || "unknown";
  const host = os.hostname().replace(/[^a-zA-Z0-9_-]/g, "");
  const filename = `dp-image-${host}-${arch}-${localStamp()}.tar.zst`; // local-time stamp
  const outPath = path.join(IMAGES_DIR, filename);

  const out = fsSync.createWriteStream(outPath);
  console.log(`💾 System image capture started → ${outPath}`);
  const child = spawn("sudo", ["/usr/bin/bash", IMAGE_SCRIPT,
    "--created", created, "--app-version", appVersion], { stdio: ["ignore", "pipe", "pipe"] });
  imageJob = { kind: "capture", filename, path: outPath, progressPath: outPath, startedAt: Date.now(), running: true, error: null, exitCode: null };
  child.stdout.pipe(out);
  child.stderr.on("data", (d) => process.stderr.write(`[dp-create-image] ${d}`));
  child.on("error", (err) => {
    console.error("💾 capture spawn error:", err.message);
    imageJob.running = false; imageJob.error = err.message;
    out.destroy(); try { fsSync.unlinkSync(outPath); } catch { /* ignore */ }
    io.emit("systemImageJob", { running: false, filename, error: err.message });
  });
  child.on("close", (code) => {
    out.end(() => {
      imageJob.running = false; imageJob.exitCode = code;
      // tar exits 1 when files changed during the live read — archive is still valid.
      if (code !== 0 && code !== 1) {
        imageJob.error = `capture failed (exit ${code})`;
        try { fsSync.unlinkSync(outPath); } catch { /* ignore */ }
        console.error(`💾 capture failed (exit ${code}) — removed partial ${filename}`);
      } else {
        console.log(`💾 System image capture finished (exit ${code}) → ${outPath} (${imageFileSize(outPath)} bytes)`);
      }
      io.emit("systemImageJob", { running: false, filename, error: imageJob.error || null });
    });
  });
  res.json({ success: true, filename });
});

// Download a saved image. res.download() sets Content-Length + supports Range, so
// the browser shows real progress and can RESUME an interrupted download.
app.get("/api/system/image/file/:name", requireAdmin, (req, res) => {
  if (!isDpAdmin(req, res)) return;
  const name = req.params.name;
  if (!safeImageName(name)) return res.status(400).json({ success: false, error: "bad image name" });
  const p = path.join(IMAGES_DIR, name);
  if (!fsSync.existsSync(p)) return res.status(404).json({ success: false, error: "not found" });
  if (imageJob && imageJob.running && imageJob.filename === name)
    return res.status(409).json({ success: false, error: "image is still being captured" });
  res.download(p, name);
});

// Delete a saved image.
app.delete("/api/system/image/file/:name", requireAdmin, (req, res) => {
  if (!isDpAdmin(req, res)) return;
  const name = req.params.name;
  if (!safeImageName(name)) return res.status(400).json({ success: false, error: "bad image name" });
  if (imageJob && imageJob.running && imageJob.filename === name)
    return res.status(409).json({ success: false, error: "cannot delete an image while it is being captured" });
  try { fsSync.unlinkSync(path.join(IMAGES_DIR, name)); }
  catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  res.json({ success: true });
});

// Build an all-in-one bootable recovery ISO from a captured image (async job).
// Automates: ensure Ubuntu base ISO (auto-download + cache), then run
// dp-build-recovery-iso.sh. xorriso must be installed once: sudo apt install -y xorriso.
const ISO_BUILDER = path.join(__dirname, "dp-build-recovery-iso.sh");
app.post("/api/system/image/build-iso", requireAdmin, async (req, res) => {
  if (!isDpAdmin(req, res)) return;
  if (imageJob && imageJob.running)
    return res.status(409).json({ success: false, error: "A job is already running" });
  const name = (req.body && req.body.image) || "";
  if (!safeImageName(name) || !name.endsWith(".tar.zst"))
    return res.status(400).json({ success: false, error: "pick a captured image (.tar.zst)" });
  if (!fsSync.existsSync(path.join(IMAGES_DIR, name)))
    return res.status(404).json({ success: false, error: "image not found" });
  if (!fsSync.existsSync(ISO_BUILDER))
    return res.status(500).json({ success: false, error: "dp-build-recovery-iso.sh not found" });
  runIsoBuild(name);  // fire-and-forget; progress via /list
  res.json({ success: true });
});

// Background worker for the ISO build (updates imageJob for /list progress).
async function runIsoBuild(imageName) {
  const arch = (await execAsync("uname -m").catch(() => ({ stdout: "" }))).stdout.trim();
  const isoArch = arch === "x86_64" ? "amd64" : (arch === "aarch64" ? "arm64" : arch);
  const imgPath = path.join(IMAGES_DIR, imageName);
  const outName = `dp-recovery-${localStamp()}.iso`;
  const outPath = path.join(IMAGES_DIR, outName);
  const baseIso = path.join(IMAGES_DIR, `ubuntu-base-${isoArch}.iso`);
  imageJob = { kind: "iso", filename: outName, path: outPath, progressPath: null,
    startedAt: Date.now(), running: true, error: null, phase: "preparing" };
  console.log(`💿 Recovery ISO build started → ${outName} (from ${imageName})`);

  const run = (cmd, args) => new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => process.stderr.write(`[build-iso] ${d}`));
    c.stderr.on("data", (d) => process.stderr.write(`[build-iso] ${d}`));
    c.on("error", reject);
    c.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });

  try {
    if (!(await execAsync("command -v xorriso").catch(() => ({ stdout: "" }))).stdout.trim())
      throw new Error("xorriso not installed — run once on the device: sudo apt install -y xorriso");

    // Ensure the cached Ubuntu base ISO (auto-download amd64; other arches must be pre-placed).
    if (!fsSync.existsSync(baseIso) || imageFileSize(baseIso) < 1e9) {
      if (isoArch !== "amd64") throw new Error(`No Ubuntu base ISO for ${isoArch} — place one at ${baseIso}`);
      imageJob.phase = "finding Ubuntu ISO";
      const listing = (await execAsync("curl -fsSL https://releases.ubuntu.com/24.04/").catch(() => ({ stdout: "" }))).stdout;
      // Live-server ISO (~2.6 GB) — much smaller than desktop; the flash flow is CLI-only.
      const matches = listing.match(/ubuntu-24\.04[0-9.]*-live-server-amd64\.iso/g);
      if (!matches) throw new Error("could not locate an Ubuntu 24.04 live-server amd64 ISO to download");
      const iso = [...new Set(matches)].sort().pop();
      imageJob.phase = "downloading Ubuntu ISO";
      imageJob.progressPath = baseIso + ".part";
      await run("wget", ["-q", "-O", baseIso + ".part", `https://releases.ubuntu.com/24.04/${iso}`]);
      fsSync.renameSync(baseIso + ".part", baseIso);
    }

    imageJob.phase = "building ISO";
    imageJob.progressPath = outPath;
    await run("bash", [ISO_BUILDER, baseIso, imgPath, outPath]);

    imageJob.running = false; imageJob.phase = "done";
    console.log(`💿 Recovery ISO built → ${outPath} (${imageFileSize(outPath)} bytes)`);
    io.emit("systemImageJob", { running: false, filename: outName, error: null });
  } catch (e) {
    imageJob.running = false; imageJob.error = e.message; imageJob.phase = "error";
    try { if (fsSync.existsSync(outPath) && imageFileSize(outPath) === 0) fsSync.unlinkSync(outPath); } catch { /* ignore */ }
    console.error("💿 ISO build failed:", e.message);
    io.emit("systemImageJob", { running: false, filename: outName, error: e.message });
  }
}

// API endpoint to list recent commits from origin (dpadmin only).
// Fetches from origin first so the list always includes commits not yet on the device.
app.get("/api/commits", requireAdmin, async (req, res) => {
  if (req.session?.user?.username !== "dpadmin")
    return res.status(403).json({ success: false, error: "Access denied" });
  try {
    // Fetch latest refs so we can see commits ahead of the local checkout.
    await execAsync("git fetch origin", { cwd: __dirname });
    // Format: <hash>|<date>|<subject>
    const { stdout } = await execAsync(
      'git log origin/main --oneline --format="%H|%cd|%s" --date=format:"%Y-%m-%d %H:%M" -n 30',
      { cwd: __dirname }
    );
    // Also get the currently checked-out commit so the UI can highlight it.
    const { stdout: headOut } = await execAsync("git rev-parse HEAD", { cwd: __dirname });
    const currentHash = headOut.trim();
    const commits = stdout.trim().split("\n").filter(Boolean).map((line) => {
      const [hash, date, ...subjectParts] = line.split("|");
      return { hash: hash.trim(), date: date.trim(), subject: subjectParts.join("|").trim() };
    });
    res.json({ success: true, commits, current: currentHash });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API endpoint to deploy a specific commit or pull latest (dpadmin only).
// Body: { commit: "<full-hash>" }  — omit or pass "latest" to update to origin/main HEAD.
// Uses git reset --hard so the working tree always matches the target exactly.
app.post("/api/update", requireAdmin, async (req, res) => {
  if (req.session?.user?.username !== "dpadmin")
    return res.status(403).json({ success: false, error: "Access denied" });

  const requestedCommit = (req.body?.commit || "latest").trim();
  // Validate: must be "latest" or a hex git hash (7–40 chars)
  if (requestedCommit !== "latest" && !/^[0-9a-f]{7,40}$/i.test(requestedCommit))
    return res.status(400).json({ success: false, error: "Invalid commit hash" });

  try {
    // Always fetch first so we have all remote refs/objects.
    await execAsync("git fetch origin", { cwd: __dirname });
    const target = requestedCommit === "latest" ? "origin/main" : requestedCommit;
    const { stdout, stderr } = await execAsync(`git reset --hard ${target}`, { cwd: __dirname });
    const output = (stdout || "").trim() || (stderr || "").trim() || "No output";
    console.log(`🔄 Deploying ${target}: ${output}`);

    // Apply any host-config migrations that arrived with this update (packages,
    // systemd units, /etc changes — things git alone can't do because we run as
    // the unprivileged `dp` user).  The migration service is a root oneshot that
    // blocks until finished; `systemctl start` returns non-zero if it failed.
    // See migrations/README.md.  Tolerates boxes not yet bootstrapped (the sudo
    // call just errors, the update still succeeds and restarts).
    let migrations = "";
    try {
      await execAsync("sudo /usr/bin/systemctl start digitalpool-migrations.service",
                      { cwd: __dirname, timeout: 600000 });
      migrations = "Migrations applied.";
    } catch (mErr) {
      migrations = `Migration run reported an error: ${mErr.message}`;
      console.error("⚠️  Migration run failed:", mErr.message);
    }
    // Surface the tail of the migration log so the admin sees what happened
    // without needing to SSH in.  (Log is world-readable; created by the runner.)
    try {
      // last-run.log is truncated at the start of every migration run, so this
      // shows ONLY what this update executed — not the cumulative history.
      const { stdout: runLog } = await execAsync("cat /var/lib/digitalpool-camera/last-run.log");
      if (runLog && runLog.trim()) migrations += "\n\n" + runLog.trim();
    } catch { /* file may not exist yet on un-bootstrapped boxes */ }

    res.json({ success: true, output, migrations });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
  // Give the response time to flush, then exit — systemd will restart the process
  setTimeout(() => {
    console.log("🔄 Software update requested — restarting service via process.exit");
    process.exit(0);
  }, 800);
});

// ── System stats API ─────────────────────────────────────────────────────────
// GET /api/system/stats — CPU temperature, RAM usage, and Intel RAPL power draw.
// Any authenticated user may read these (no sensitive data).
app.get("/api/system/stats", requireAuth, (req, res) => {
  // _readSystemStats is initialised by the polling block near the bottom of server.js.
  const fn = global._readSystemStats;
  res.json(fn ? { success: true, ...fn() } : { success: false, error: "stats not ready" });
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
app.get("/api/network", async (req, res) => {
  const addresses = [];
  try {
    // Use `ip -4 -o addr show scope global` and exclude secondary addresses.
    // os.networkInterfaces() returns both primary and secondary DHCP leases
    // with no flag to distinguish them — `ip addr` marks secondary addresses
    // explicitly so we can filter them out.
    const { stdout } = await execAsync("ip -4 -o addr show scope global 2>/dev/null");
    for (const line of stdout.split("\n")) {
      if (!line.trim() || line.includes(" secondary ")) continue;
      // line format: "3: enp2s0    inet 192.168.1.170/24 brd ... scope global ..."
      const m = line.match(/^\d+:\s+(\S+)\s+inet\s+([0-9.]+)/);
      if (!m) continue;
      const [, iface, address] = m;
      if (address.startsWith("169.254.")) continue; // skip link-local
      addresses.push({ interface: iface, address });
    }
  } catch (_) {
    // Fallback to os.networkInterfaces() if ip command unavailable
    for (const [name, nets] of Object.entries(os.networkInterfaces())) {
      for (const net of nets) {
        if (!net.internal && net.family === "IPv4" && !net.address.startsWith("169.254.")) {
          addresses.push({ interface: name, address: net.address });
        }
      }
    }
  }

  // Determine which interface holds the default route
  let defaultIface = null;
  try {
    const { stdout } = await execAsync("ip route show default 2>/dev/null");
    const m = stdout.match(/dev\s+(\S+)/);
    if (m) defaultIface = m[1];
  } catch (_) {}

  const tagged = addresses.map(a => ({ ...a, primary: a.interface === defaultIface }));
  res.json({ success: true, addresses: tagged, defaultIface });
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

// Get client WiFi (USB dongle) status only
app.get("/api/wifi/client/status", requireAdmin, async (req, res) => {
  try {
    const status = await wifiManager.getClientWifiStatus();
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

  // Also save to stream config so it persists (applies to camera 1 overlay URL)
  const _scForOverlay = getSC(1);
  _scForOverlay.streamConfig.overlayUrl = url || "";
  _scForOverlay.saveConfig();

  res.json({ success: true, overlayUrl: url || "" });
});

// API endpoint to list the overlays available to this device's DigitalPool
// account — the owner's own custom overlays plus public overlays for the venue.
// Identity-based (no password), keyed on the identifiers stored in remote.json
// during registration; same cloud function + client as register/deregister.
let _overlayListCache = { at: 0, overlays: null };
const OVERLAY_LIST_TTL_MS = 60000;
app.get("/api/overlays", async (req, res) => {
  const cfg = loadRemoteConfig();
  if (!cfg.registered) {
    return res.json({ ok: false, error: "device not registered", overlays: [] });
  }

  // Serve a recent cached list so re-opening the panel doesn't re-hit the function.
  if (req.query.refresh !== "1"
      && _overlayListCache.overlays
      && Date.now() - _overlayListCache.at < OVERLAY_LIST_TTL_MS) {
    return res.json({ ok: true, overlays: _overlayListCache.overlays, cached: true });
  }

  let result;
  try {
    result = await callDigitalPoolRegister({
      action:     "listOverlays",
      ownerEmail: cfg.ownerEmail || "",
      venueId:    cfg.venueId    || "",
      deviceId:   cfg.deviceId   || "",
      macAddress: cfg.macAddress || getPrimaryMac(),
    });
  } catch (e) {
    console.warn("listOverlays failed:", e.message);
    return res.status(502).json({ ok: false, error: `Could not reach DigitalPool overlay service: ${e.message}`, overlays: [] });
  }

  if (result.statusCode >= 400 || result.body?.ok === false) {
    return res.status(502).json({ ok: false, error: result.body?.error || `Overlay service error (HTTP ${result.statusCode})`, overlays: [] });
  }

  // Normalize: keep only entries with a usable URL; default missing scope to public.
  const overlays = (Array.isArray(result.body?.overlays) ? result.body.overlays : [])
    .map((o) => ({
      id:    o.id ?? o.url ?? "",
      name:  o.name || o.title || o.url || "Overlay",
      url:   typeof o.url === "string" ? o.url.trim() : "",
      scope: o.scope === "mine" ? "mine" : "public",
    }))
    .filter((o) => o.url);

  _overlayListCache = { at: Date.now(), overlays };
  res.json({ ok: true, overlays });
});

// API endpoint to get all controls
app.get("/api/controls", async (req, res) => {
  const camIdx = parseInt(req.query.cam) === 2 ? 2 : 1;
  const result = await getCam(camIdx).getAllControls();
  res.json(result);
});

// API endpoint to get specific control
app.get("/api/control/:name", async (req, res) => {
  const camIdx = parseInt(req.query.cam) === 2 ? 2 : 1;
  const result = await getCam(camIdx).getControl(req.params.name);
  res.json(result);
});

// API endpoint to set control
app.post("/api/control/:name", async (req, res) => {
  const camIdx = parseInt(req.query.cam) === 2 ? 2 : 1;
  const { value } = req.body;
  const result = await getCam(camIdx).setControl(req.params.name, value);
  res.json(result);
});

// API endpoint to get camera configuration
app.get("/api/camera/config", (req, res) => {
  const camIdx = parseInt(req.query.cam) === 2 ? 2 : 1;
  res.json({ success: true, config: getCam(camIdx).config });
});

// ── Camera source persistence ─────────────────────────────────────────────────
// The active input source (USB device path or RTSP URL) survives restarts via
// camera-source.json — same pattern as remote.json, ethernet-config.json, etc.
const CAMERA_SOURCE_FILE   = path.join(__dirname, "camera-source.json");
const CAMERA_SOURCE_FILE_2 = path.join(__dirname, "camera-source-2.json");

function loadCameraSource(idx = 1) {
  const file = idx === 2 ? CAMERA_SOURCE_FILE_2 : CAMERA_SOURCE_FILE;
  try {
    if (fsSync.existsSync(file)) {
      const saved = JSON.parse(fsSync.readFileSync(file, "utf8"));
      // Validate minimal shape before trusting it
      if (saved && (saved.type === "usb" || saved.type === "rtsp" || saved.type === "rtmp" || saved.type === "ndi")) {
        let detail = "";
        if (saved.type === "rtsp") detail = " → " + saved.rtspUrl;
        else if (saved.type === "rtmp") detail = " → " + saved.rtmpUrl;
        else if (saved.type === "ndi") detail = " → " + (saved.ndiName || "(no name)");
        else detail = " → " + saved.device;
        console.log(`📷 Cam${idx}: Loaded camera source from file: ${saved.type}${detail}`);
        return saved;
      }
    }
  } catch (e) {
    console.warn(`⚠️  Could not load ${path.basename(file)}:`, e.message);
  }
  return null;
}

function saveCameraSource(source, idx = 1) {
  const file = idx === 2 ? CAMERA_SOURCE_FILE_2 : CAMERA_SOURCE_FILE;
  try {
    fsSync.writeFileSync(file, JSON.stringify(source, null, 2));
  } catch (e) {
    console.error(`❌ Could not save ${path.basename(file)}:`, e.message);
  }
}

// Active camera sources — updated at runtime via /api/camera/source.
// Initialised from disk so the chosen source survives restarts.
const _savedSource  = loadCameraSource(1);
const _savedSource2 = loadCameraSource(2);
let activeCameraSource  = _savedSource  || { type: "usb", device: CAMERA_DEVICE,   rtspUrl: "", rtmpUrl: "", ndiName: "" };
let activeCameraSource2 = _savedSource2 || { type: "usb", device: CAMERA_DEVICE_2, rtspUrl: "", rtmpUrl: "", ndiName: "" };

/** Return the active source object for camera index 1 or 2. */
function getActiveSource(idx) { return idx === 2 ? activeCameraSource2 : activeCameraSource; }

// List available V4L2 video capture devices
app.get("/api/camera/devices", requireAuth, (req, res) => {
  const camIdx = parseInt(req.query.cam) === 2 ? 2 : 1;
  const current = getActiveSource(camIdx);
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
    res.json({ success: true, devices, current });
  } catch (e) {
    res.json({ success: false, error: e.message, devices: [], current });
  }
});

// Report which encode resolutions the active camera source supports.
// For USB sources, parses `v4l2-ctl --list-formats-ext` to see whether the
// device can deliver 720p / 1080p / 4K. For RTSP (or any non-USB source),
// no V4L2 capability check applies, so all resolutions are reported as
// available — the user can transcode to whatever the encoder will allow.
app.get("/api/camera/capabilities", requireAuth, async (req, res) => {
  const camIdx = parseInt(req.query.cam) === 2 ? 2 : 1;
  const activeSource = getActiveSource(camIdx);
  const defaultDevice = camIdx === 2 ? CAMERA_DEVICE_2 : CAMERA_DEVICE;
  // RTSP and NDI sources are network streams — no V4L2 capability check applies.
  // All resolutions are reported as available; the transcoder will handle whatever
  // the source delivers.
  if (activeSource.type !== "usb") {
    return res.json({
      success: true,
      source: activeSource.type,
      supports720p: true,
      supports1080p: true,
      supports4K: true,
      maxWidth: 0,
      maxHeight: 0,
    });
  }
  const dev = activeSource.device || defaultDevice;
  try {
    const { stdout } = await execAsync(
      `sudo v4l2-ctl -d ${dev} --list-formats-ext 2>/dev/null || true`,
      { timeout: 4000 },
    );
    let maxW = 0, maxH = 0;
    let supports720p = false, supports1080p = false, supports4K = false;
    const re = /Size: Discrete (\d+)x(\d+)/g;
    let m;
    while ((m = re.exec(stdout)) !== null) {
      const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
      if (w >= 1280 && h >= 720)  supports720p  = true;
      if (w >= 1920 && h >= 1080) supports1080p = true;
      if (w >= 3840 && h >= 2160) supports4K    = true;
      if (w * h > maxW * maxH) { maxW = w; maxH = h; }
    }
    res.json({ success: true, source: "usb", device: dev, supports720p, supports1080p, supports4K, maxWidth: maxW, maxHeight: maxH });
  } catch (e) {
    // On parse / exec failure, fall back to the safe set (no 4K) so the UI
    // doesn't accidentally enable an option the camera can't satisfy.
    res.json({ success: false, error: e.message, supports720p: true, supports1080p: true, supports4K: false, maxWidth: 0, maxHeight: 0 });
  }
});

// List available ALSA capture devices (microphones / audio inputs).
// Uses execAsync (non-blocking) with a hard 3 s timeout so a hung ALSA
// subsystem never stalls the Node.js event loop.
app.get("/api/audio/devices", requireAuth, async (req, res) => {
  const camIdx = parseInt(req.query.cam) === 2 ? 2 : 1;
  try {
    // arecord -l output format:
    //   card 3: SE [OBSBOT Tiny SE], device 0: USB Audio [USB Audio]
    //
    // The device-type field before the bracketed name can be multiple words
    // (e.g. "USB Audio", "dailink-multicodecs ES8323 HiFi-0"), so we use
    // [^\[]+ (anything up to the opening bracket) instead of \S+\s+ which
    // only matches a single word.
    const { stdout } = await execAsync("arecord -l 2>/dev/null || true", { timeout: 3000 });
    const devices = [];
    const re = /^card\s+(\d+):\s+\S+\s+\[([^\]]+)\],\s+device\s+(\d+):\s+[^\[]*\[([^\]]*)\]/;
    for (const line of stdout.split("\n")) {
      const m = re.exec(line.trim());
      if (!m) continue;
      const [, card, cardName, device, devName] = m;
      // Use plughw: instead of hw: so the ALSA plug layer handles rate/format
      // conversion automatically.  This is essential for USB mics (e.g. OBSBOT
      // Tiny SE) that only support 32000 Hz natively while ffmpeg requests 48000 Hz.
      const hw = `plughw:${card},${device}`;
      const label = devName ? `${cardName} — ${devName} (${hw})` : `${cardName} (${hw})`;
      devices.push({ device: hw, name: label });
    }
    const current = getSC(camIdx).streamConfig.audioDevice || "";
    res.json({ success: true, devices, current });
  } catch (e) {
    res.json({ success: false, error: e.message, devices: [] });
  }
});

// Discover NDI sources on the local network.
// Spawns ndi-discover.py which uses the NDI SDK via ctypes to enumerate
// mDNS/UDP announcements.  The optional ?timeout query param controls how
// long the script waits (ms); default 5000.  The process itself is given
// an extra 3 s on top of that for startup overhead.
app.get("/api/ndi/sources", requireAuth, async (req, res) => {
  const timeoutMs = Math.min(Math.max(parseInt(req.query.timeout, 10) || 5000, 1000), 15000);
  const scriptPath = path.join(__dirname, "ndi-discover.py");
  try {
    const { stdout } = await execAsync(
      `python3 "${scriptPath}" ${timeoutMs}`,
      { timeout: timeoutMs + 4000 }
    );
    let sources;
    try {
      sources = JSON.parse(stdout.trim() || "[]");
    } catch {
      sources = [];
    }
    // Separate real sources from error objects the script may emit
    const errors  = sources.filter(s => s.error);
    const results = sources.filter(s => s.name);
    if (errors.length && !results.length) {
      return res.json({ success: false, error: errors[0].error, sources: [] });
    }
    res.json({ success: true, sources: results });
  } catch (e) {
    console.error("❌ NDI discovery error:", e.message);
    res.json({ success: false, error: e.message, sources: [] });
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

// Poll until MediaMTX reports an active publisher on the given path name, or timeout.
// Used to verify the idle preview (or live) RTMP push is live before telling clients.
function waitForRtmpPublisher(pathName, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const req = http.get(
        { hostname: "127.0.0.1", port: 9997, path: `/v3/paths/get/${pathName}`, timeout: 1500 },
        (res) => {
          let body = "";
          res.on("data", (d) => { body += d; });
          res.on("end", () => {
            try {
              const data = JSON.parse(body);
              // readyTime is set when a publisher is actively pushing frames
              if (data.readyTime) { resolve(true); return; }
            } catch (_) { /* ignore parse errors */ }
            if (Date.now() < deadline) setTimeout(attempt, 500);
            else resolve(false);
          });
        }
      );
      req.on("error", () => {
        if (Date.now() < deadline) setTimeout(attempt, 500);
        else resolve(false);
      });
      req.on("timeout", () => { req.destroy(); });
    }
    attempt();
  });
}

// Switch the active camera source (USB device or RTSP URL).
// If a live stream is running, it is stopped first, the new source is validated
// via the idle preview, and then the stream is restarted automatically.
app.post("/api/camera/source", requireAuth, async (req, res) => {
  const camIdx = parseInt(req.query.cam) === 2 ? 2 : 1;
  const cam = getCam(camIdx);
  const sc  = getSC(camIdx);
  const defaultDevice = camIdx === 2 ? CAMERA_DEVICE_2 : CAMERA_DEVICE;
  const { type, device, rtspUrl, rtmpUrl, ndiName } = req.body;

  // ── Validate inputs before touching any state ────────────────────────────
  if (type === "rtsp" && !rtspUrl) {
    return res.status(400).json({ success: false, error: "rtspUrl required" });
  }
  if (type === "rtmp" && !rtmpUrl) {
    return res.status(400).json({ success: false, error: "rtmpUrl required" });
  }
  if (type === "ndi" && !ndiName) {
    return res.status(400).json({ success: false, error: "ndiName required" });
  }
  if (type !== "usb" && type !== "rtsp" && type !== "rtmp" && type !== "ndi" && type !== "none") {
    return res.status(400).json({ success: false, error: "Unknown source type" });
  }

  const activeSource      = getActiveSource(camIdx);
  const previousSource    = { ...activeSource };
  const wasStreaming      = sc.isStreaming;
  const savedStreamConfig = wasStreaming ? { ...sc.streamConfig } : null;

  // ── "No Camera" — clear this slot entirely ───────────────────────────────
  // Stops any running stream, tears down the idle preview so the physical
  // device's V4L2 fd is released, and clears discovered PTZ controls.  This
  // frees the device so it can be re-assigned to the other camera slot (the
  // whole point: swapping which physical camera drives camera 1 vs camera 2).
  // Unlike the connect-and-verify flow below there is nothing to bring up or
  // wait for, so we persist and return immediately.
  if (type === "none") {
    const newSource = { type: "none", device: "", rtspUrl: "", rtmpUrl: "", ndiName: "" };
    // Flip the active source to "none" FIRST so any in-flight idle-preview
    // auto-restart (fired by the stop below) hits the "none" guard in
    // startPersistentIdlePreview() and bails instead of re-opening the device.
    if (camIdx === 2) activeCameraSource2 = newSource; else activeCameraSource = newSource;
    sc.setInputSource(newSource);

    isRestartInProgress[camIdx] = true;
    if (wasStreaming) {
      io.emit("streamStatus", { ...sc.getStatus(), status: "stopping", cameraIndex: camIdx });
      console.log(`📷 [Cam${camIdx}] Camera source cleared: stopping active stream…`);
      await sc.stopStream();
    }
    // Kill the tracked idle preview process so its V4L2 fd is released.
    await _killIdlePreviewForCamera(camIdx);
    // _killIdlePreviewForCamera only fuser -k's a "usb" source, and we've
    // already switched to "none" — so release the PREVIOUS device explicitly to
    // clear any orphan holders, freeing it for the other camera slot.
    if (previousSource.type === "usb") {
      const prevDev = previousSource.device || defaultDevice;
      try {
        execSync(`fuser -k "${prevDev}" 2>/dev/null || true`);
        console.log(`🔓 [Cam${camIdx}] fuser -k ${prevDev} — device released for reassignment`);
        await new Promise((r) => setTimeout(r, 500));
      } catch (_) { /* fuser not installed or device already free — ignore */ }
    }
    isRestartInProgress[camIdx] = false;

    // Drop all stale camera state so no PTZ ranges leak from the removed camera.
    cam.currentPan = 0;
    cam.currentTilt = 0;
    cam.discoveredControls = null;
    cam._ptzQueue = Promise.resolve();

    saveCameraSource(newSource, camIdx);
    io.emit("refreshIdlePreview", { cameraIndex: camIdx });
    io.emit("cameraConfig", { cameraIndex: camIdx, success: true, config: cam.config, supportedControls: [], ptzRanges: {} });
    io.emit("streamStatus", { ...sc.getStatus(), cameraIndex: camIdx });
    console.log(`📷 [Cam${camIdx}] Camera source set to "No Camera" — device released`);
    return res.json({ success: true, source: newSource, wasStreaming, streamRestarted: false });
  }

  // ── Step 1: Stop the live stream if running ──────────────────────────────
  // isRestartInProgress suppresses the automatic idle-preview restart that the
  // "stopped" event handler would otherwise trigger — we handle that ourselves.
  if (wasStreaming) {
    isRestartInProgress[camIdx] = true;
    io.emit("streamStatus", { ...sc.getStatus(), status: "stopping", cameraIndex: camIdx });
    console.log(`📷 [Cam${camIdx}] Camera source switch: stopping active stream…`);
    await sc.stopStream();
    // Allow extra time for the old device/RTSP/RTMP/NDI session to fully release.
    const stopDelay = (previousSource.type === "rtsp" || previousSource.type === "rtmp" || previousSource.type === "ndi") ? 2500 : 1000;
    await new Promise((r) => setTimeout(r, stopDelay));
  }

  // ── Step 2: Switch to the new source ────────────────────────────────────
  if (type === "usb") {
    const dev = device || defaultDevice;
    const newSource = { type: "usb", device: dev, rtspUrl: "", ndiName: "" };
    if (camIdx === 2) activeCameraSource2 = newSource; else activeCameraSource = newSource;
    cam.device = dev;

    // Reset all stale state from the previous camera so nothing leaks into
    // the new camera's session: tracked positions, discovered control ranges,
    // and the PTZ command queue (reset to a resolved promise).
    cam.currentPan = 0;
    cam.currentTilt = 0;
    cam.discoveredControls = null;
    cam._ptzQueue = Promise.resolve();

    // Re-discover controls and format for the new device.
    await cam.discoverControls(dev);
    const fmt = await cam.detectCaptureFormat(dev);
    if (camIdx === 2) cameraFormat2 = fmt; else cameraFormat = fmt;
    sc.captureFormat = fmt;
    console.log(`📹 [Cam${camIdx}] New USB camera: format=${fmt.toUpperCase()}, controls=${Object.keys(cam.discoveredControls || {}).join(", ")}`);
  } else if (type === "rtmp") {
    const newSource = { type: "rtmp", device: defaultDevice, rtspUrl: "", rtmpUrl, ndiName: "" };
    if (camIdx === 2) activeCameraSource2 = newSource; else activeCameraSource = newSource;
  } else if (type === "ndi") {
    const newSource = { type: "ndi", device: defaultDevice, rtspUrl: "", rtmpUrl: "", ndiName };
    if (camIdx === 2) activeCameraSource2 = newSource; else activeCameraSource = newSource;
  } else {
    const newSource = { type: "rtsp", device: defaultDevice, rtspUrl, rtmpUrl: "", ndiName: "" };
    if (camIdx === 2) activeCameraSource2 = newSource; else activeCameraSource = newSource;
  }
  sc.setInputSource(getActiveSource(camIdx));

  // Ensure this controller's encoder matches the actual hardware before we build
  // any pipeline.  A controller whose camera was absent at boot — e.g. camera 2
  // defaulting to a non-existent /dev/video2 — skips initialize()/_autoDetectEncoder(),
  // so its encoder is still the Rockchip default "mpph264enc".  On an Intel box that
  // makes the idle preview select the nonexistent mpph264enc / mppjpegdec elements and
  // fail to launch ("no element mppjpegdec"), which loops into backoff and reverts the
  // source.  Re-detecting here (gst-inspect only, no camera needed) corrects the encoder
  // — and the JPEG decoder derived from it — and persists the fix.
  try {
    await sc._autoDetectEncoder();
  } catch (e) {
    console.warn(`⚠️ [Cam${camIdx}] Encoder auto-detect failed:`, e.message);
  }

  // The stop in Step 1 set isRestartInProgress to suppress the "stopped" event's
  // automatic idle-preview restart mid-switch.  Clear it now — the stop is done
  // and the new source is set — so the validation preview below can actually
  // start.  Without this, changing the source of a *streaming* camera always
  // fails: startPersistentIdlePreview() bails on "restart in progress", the
  // waitForRtmpPublisher() times out, and the source reverts every time.
  isRestartInProgress[camIdx] = false;
  // Also clear any idle-preview failure backoff so the validation preview starts
  // immediately — a stale backoff (e.g. streak from earlier failures) would eat
  // the waitForRtmpPublisher window and cause a spurious revert.
  if (camIdx === 2) _idlePreviewFailStreak2 = 0; else _idlePreviewFailStreak = 0;

  // ── Step 3: Bring up idle preview on the new source ─────────────────────
  try {
    await startPersistentIdlePreview(camIdx);
  } catch (e) {
    console.error(`⚠️ [Cam${camIdx}] Failed to start idle preview after source change:`, e.message);
  }

  // Give GStreamer time to negotiate: RTSP, RTMP, and NDI need up to 12 s; USB is fast.
  const previewPath = sc.previewPath.replace(/^\//, ""); // strip leading /
  const timeoutMs = (type === "rtsp" || type === "rtmp" || type === "ndi") ? 12000 : 5000;
  const ready = await waitForRtmpPublisher(previewPath, timeoutMs);

  if (!ready) {
    // ── Revert on failure ────────────────────────────────────────────────
    console.error(`⚠️ [Cam${camIdx}] Camera source (${type}) did not respond in time — reverting`);
    if (camIdx === 2) activeCameraSource2 = { ...previousSource }; else activeCameraSource = { ...previousSource };
    if (previousSource.type === "usb") {
      const prevDev = previousSource.device || defaultDevice;
      cam.device = prevDev;
      cam.currentPan = 0;
      cam.currentTilt = 0;
      cam.discoveredControls = null;
      cam._ptzQueue = Promise.resolve();
      await cam.discoverControls(prevDev);
      const fmt = await cam.detectCaptureFormat(prevDev);
      if (camIdx === 2) cameraFormat2 = fmt; else cameraFormat = fmt;
      sc.captureFormat = fmt;
      console.log(`📹 [Cam${camIdx}] Reverted USB camera: format=${fmt.toUpperCase()}`);
    }
    sc.setInputSource(getActiveSource(camIdx));
    try { await startPersistentIdlePreview(camIdx); } catch (_) {}
    io.emit("refreshIdlePreview", { cameraIndex: camIdx });

    // Broadcast reverted camera capabilities to all clients.
    {
      const hwControls = cam.discoveredControls || cam.controls;
      const ptzRanges = {};
      if (hwControls.pan_absolute)  ptzRanges.pan_absolute  = { min: hwControls.pan_absolute.min,  max: hwControls.pan_absolute.max,  step: hwControls.pan_absolute.step  };
      if (hwControls.tilt_absolute) ptzRanges.tilt_absolute = { min: hwControls.tilt_absolute.min, max: hwControls.tilt_absolute.max, step: hwControls.tilt_absolute.step };
      io.emit("cameraConfig", { cameraIndex: camIdx, success: true, config: cam.config, supportedControls: Object.keys(hwControls), ptzRanges });
    }

    // Restart the stream on the reverted source if it was running before.
    if (wasStreaming) {
      isRestartInProgress[camIdx] = false;
      io.emit("streamStatus", { ...sc.getStatus(), status: "starting", cameraIndex: camIdx });
      const revertRestart = await sc.startStream(savedStreamConfig);
      io.emit("streamStatus", { ...sc.getStatus(), cameraIndex: camIdx });
      if (!revertRestart.success) {
        console.error(`⚠️ [Cam${camIdx}] Failed to restart stream after source revert:`, revertRestart.error);
      }
    }

    return res.json({
      success: false,
      error: type === "rtsp"
        ? "RTSP source did not respond. Check the URL is reachable and try again."
        : type === "rtmp"
        ? "RTMP source did not respond. Check the URL is correct and the stream is live."
        : type === "ndi"
        ? "NDI source did not respond. Check the source name is correct and the NDI sender is active on the network."
        : "USB device did not start. Check the device path.",
    });
  }

  // ── Step 4: Persist and notify clients ──────────────────────────────────
  saveCameraSource(getActiveSource(camIdx), camIdx);
  io.emit("refreshIdlePreview", { cameraIndex: camIdx });

  // Broadcast updated camera capabilities (controls, PTZ ranges, format) so
  // every connected browser immediately reflects the new camera without a
  // page reload.  This mirrors what getCameraConfig emits on demand.
  {
    const hwControls = cam.discoveredControls || cam.controls;
    const ptzRanges = {};
    if (hwControls.pan_absolute)  ptzRanges.pan_absolute  = { min: hwControls.pan_absolute.min,  max: hwControls.pan_absolute.max,  step: hwControls.pan_absolute.step  };
    if (hwControls.tilt_absolute) ptzRanges.tilt_absolute = { min: hwControls.tilt_absolute.min, max: hwControls.tilt_absolute.max, step: hwControls.tilt_absolute.step };
    io.emit("cameraConfig", { cameraIndex: camIdx, success: true, config: cam.config, supportedControls: Object.keys(hwControls), ptzRanges });
  }

  // ── Step 5: Restart the stream on the new source (if it was running) ────
  if (wasStreaming) {
    isRestartInProgress[camIdx] = false;
    console.log(`📷 [Cam${camIdx}] Camera source switch: restarting stream on new source…`);
    io.emit("streamStatus", { ...sc.getStatus(), status: "starting", cameraIndex: camIdx });
    const restartResult = await sc.startStream(savedStreamConfig);
    io.emit("streamStatus", { ...sc.getStatus(), cameraIndex: camIdx });
    if (!restartResult.success) {
      console.error(`⚠️ [Cam${camIdx}] Failed to restart stream after source change:`, restartResult.error);
      return res.json({
        success: true,
        source: getActiveSource(camIdx),
        wasStreaming,
        streamRestarted: false,
        streamError: restartResult.error,
      });
    }
  }

  res.json({ success: true, source: getActiveSource(camIdx), wasStreaming, streamRestarted: wasStreaming });
});

// API endpoint to get stream configuration
app.get("/api/stream/config", (req, res) => {
  const camIdx = parseInt(req.query.cam) === 2 ? 2 : 1;
  res.json({ success: true, config: getSC(camIdx).streamConfig });
});

// Returns the MediaMTX WHEP base URL the browser should use for WebRTC preview.
// The browser connects directly to MediaMTX on port 8889 (CORS is open there).
// Using req.socket.localAddress instead of window.location.hostname ensures the
// URL matches the interface this connection arrived on, which is guaranteed to
// be one of MediaMTX's ICE candidates (it's a live local interface).
// This fixes NetBird, hotspot, and any other non-LAN interface automatically.
app.get("/api/stream/whep-base", requireAuth, (req, res) => {
  let host = req.socket.localAddress || "127.0.0.1";
  // Strip IPv6-mapped IPv4 prefix (e.g. ::ffff:192.168.1.81 → 192.168.1.81)
  if (host.startsWith("::ffff:")) host = host.slice(7);
  // Wrap bare IPv6 in brackets for a valid URL
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  res.json({ whepBase: `http://${urlHost}:8889` });
});

// API endpoint to reset camera to defaults.  Also re-discovers hardware
// capabilities (resetToDefaults clears and re-queries the control map) and
// returns the fresh supportedControls/ptzRanges so the UI can refresh its
// dim state without a separate getCameraConfig round-trip.
app.post("/api/camera/reset", async (req, res) => {
  const camIdx = parseInt(req.query.cam) === 2 ? 2 : 1;
  const cam = getCam(camIdx);
  const result = await cam.resetToDefaults();
  const hwControls = cam.discoveredControls || cam.controls;
  const ptzRanges = {};
  if (hwControls.pan_absolute)  ptzRanges.pan_absolute  = { min: hwControls.pan_absolute.min,  max: hwControls.pan_absolute.max,  step: hwControls.pan_absolute.step  };
  if (hwControls.tilt_absolute) ptzRanges.tilt_absolute = { min: hwControls.tilt_absolute.min, max: hwControls.tilt_absolute.max, step: hwControls.tilt_absolute.step };
  res.json({
    success: true,
    results: result,
    config: cam.config,
    supportedControls: Object.keys(hwControls),
    ptzRanges,
  });
});

// ============ STREAMING API ENDPOINTS ============

// Get stream status
app.get("/api/stream/status", (req, res) => {
  const camIdx = parseInt(req.query.cam) === 2 ? 2 : 1;
  res.json(getSC(camIdx).getStatus());
});

// Start stream — blocked until device is registered
app.post("/api/stream/start", requireRegistered, async (req, res) => {
  const camIdx = parseInt(req.query.cam) === 2 ? 2 : 1;
  const config = req.body;
  const result = await getSC(camIdx).startStream(config);
  res.json(result);
});

// Stop stream
app.post("/api/stream/stop", async (req, res) => {
  const camIdx = parseInt(req.query.cam) === 2 ? 2 : 1;
  const result = await getSC(camIdx).stopStream();
  res.json(result);
});

// Update stream configuration
app.post("/api/stream/config", async (req, res) => {
  const camIdx = parseInt(req.query.cam) === 2 ? 2 : 1;
  const sc = getSC(camIdx);
  const config = req.body;
  // Capture flip state before update to detect changes
  const prevFlipH = sc.streamConfig.flipHorizontal;
  const prevFlipV = sc.streamConfig.flipVertical;
  const result = sc.updateConfig(config);
  // Restart idle preview immediately when flip orientation changes
  const flipChanged =
    (config.flipHorizontal !== undefined && config.flipHorizontal !== prevFlipH) ||
    (config.flipVertical   !== undefined && config.flipVertical   !== prevFlipV);
  if (flipChanged) {
    if (sc.isStreaming) {
      console.log(`🔄 [Cam${camIdx}] Flip setting changed while streaming — client will restart stream`);
    } else {
      console.log(`🔄 [Cam${camIdx}] Flip setting changed — restarting idle preview`);
      try {
        await startPersistentIdlePreview(camIdx);
        io.emit("refreshIdlePreview", { cameraIndex: camIdx });
      } catch (err) {
        console.error(`⚠️  [Cam${camIdx}] Failed to restart idle preview after flip change:`, err.message);
      }
    }
  }
  // Tell the client whether it needs to restart the active stream itself.
  res.json({ ...result, restartStreamNeeded: flipChanged && sc.isStreaming });
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

// ── Viewer connection persistence ─────────────────────────────────────────────
// Tracks when each client IP first connected, keyed by IP address.
// Survives page reloads and server restarts so the "Connected for" duration
// in the UI is accurate even after refreshing the browser.
//
// Schema (one entry per IP):
//   connectedAt {number}  — epoch ms when the continuous connection started
//   lastSeen    {number}  — epoch ms of the most recent poll that saw this IP
//
// Grace window: if the same IP reappears within VIEWER_RECONNECT_GRACE_MS of
// its lastSeen timestamp we treat it as still-connected (handles brief TCP
// reconnects / RTSP keepalive blips that change the session ID).
const VIEWER_CONN_FILE          = path.join(__dirname, "viewer-connections.json");
const VIEWER_RECONNECT_GRACE_MS = 90_000;   // 90 s — blips shorter than this keep the original connectedAt
let   viewerConnectedAt         = {};        // IP → { connectedAt, lastSeen }

function loadViewerConnections() {
  try {
    if (fsSync.existsSync(VIEWER_CONN_FILE))
      viewerConnectedAt = JSON.parse(fsSync.readFileSync(VIEWER_CONN_FILE, "utf8"));
  } catch (_) { viewerConnectedAt = {}; }
}

function saveViewerConnections() {
  try {
    fsSync.writeFileSync(VIEWER_CONN_FILE, JSON.stringify(viewerConnectedAt, null, 2));
  } catch (e) {
    console.error("⚠️  Could not save viewer-connections.json:", e.message);
  }
}

loadViewerConnections();

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

      // ── Resolve connectedAt (persistent, keyed by IP) ──────────────────────
      // Priority:
      //   1. viewerBytesHistory already has it for this session ID (same session, normal poll)
      //   2. viewerConnectedAt[ip] exists and lastSeen is within the grace window
      //      → same client, brief blip / session-ID change — keep original time
      //   3. Otherwise → new continuous connection; record now
      let connectedAt;
      const prev = viewerBytesHistory[s.id];
      if (prev) {
        connectedAt = prev.connectedAt;
      } else if (ip && viewerConnectedAt[ip] &&
                 (now - viewerConnectedAt[ip].lastSeen) <= VIEWER_RECONNECT_GRACE_MS) {
        connectedAt = viewerConnectedAt[ip].connectedAt;
      } else {
        connectedAt = now;
      }

      // Always update the persistent IP record so lastSeen stays current
      if (ip) {
        viewerConnectedAt[ip] = { connectedAt, lastSeen: now };
      }

      // Per-session bytes/rate history (session-ID scoped, shorter lifetime)
      let mbps = prev ? prev.mbps : null;
      if (prev && s.bytesSent >= prev.bytes && (now - prev.time) >= 800) {
        const elapsed = (now - prev.time) / 1000;
        mbps = parseFloat(((s.bytesSent - prev.bytes) * 8 / elapsed / 1_000_000).toFixed(2));
        viewerBytesHistory[s.id] = { bytes: s.bytesSent, time: now, mbps, kickBase: s._kickBase, ip, connectedAt };
      } else if (!prev) {
        viewerBytesHistory[s.id] = { bytes: s.bytesSent, time: now, mbps: null, kickBase: s._kickBase, ip, connectedAt };
      }

      viewers.push({
        id: s.id, remoteAddr: s.remoteAddr, ip,
        type: s._type, state: s.state, bytesSent: s.bytesSent, mbps,
        connectedAt,
      });
    }

    // Clean up session history for sessions that are no longer active.
    // For IPs that fully disconnected (not in activeIds), update lastSeen in the
    // persistent map so the grace window is measured from their actual disconnect time.
    const activeIds  = new Set(viewers.map((v) => v.id));
    const activeIPs  = new Set(viewers.map((v) => v.ip).filter(Boolean));
    let   connChanged = false;
    for (const id of Object.keys(viewerBytesHistory)) {
      if (!activeIds.has(id)) {
        const deadIp = viewerBytesHistory[id].ip;
        // If the IP is no longer active at all, stamp lastSeen = now so the
        // grace-window clock starts from the moment of disconnect.
        if (deadIp && !activeIPs.has(deadIp) && viewerConnectedAt[deadIp]) {
          viewerConnectedAt[deadIp].lastSeen = now;
          connChanged = true;
        }
        delete viewerBytesHistory[id];
      }
    }
    if (connChanged || viewers.length > 0) saveViewerConnections();

    res.json({ success: true, viewers, bannedIPs });
  } catch (_) {
    res.json({ success: true, viewers: [], bannedIPs });
  }
});

// POST /api/stream/kick/:id — disconnect a client.
// Uses the kickBase stored in viewerBytesHistory to pick the right protocol endpoint.
app.post("/api/stream/kick/:id", requireAdmin, async (req, res) => {
  try {
    const entry   = viewerBytesHistory[req.params.id];
    const kickBase = entry?.kickBase || "/v3/rtspsessions/kick";
    await mediamtxPost(`${kickBase}/${req.params.id}`);
    // Clear both session and persistent IP records so the connection timer
    // resets if this client reconnects.
    if (entry?.ip) {
      delete viewerConnectedAt[entry.ip];
      saveViewerConnections();
    }
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
    // Clear connection timestamp so the timer resets if they somehow reconnect
    delete viewerConnectedAt[ip];
    saveViewerConnections();
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

    // Always allow the local GStreamer publisher and internal MediaMTX processes.
    // Do NOT log these — MediaMTX calls the hook for every internal API operation
    // (HLS segment fetches, viewer list polls, etc.), flooding the journal.
    if (!ip || ip === "127.0.0.1" || ip === "::1") {
      return res.sendStatus(200);
    }

    // Block banned IPs — connection is rejected before it is established
    if (Array.isArray(bannedIPs) && bannedIPs.includes(ip)) {
      console.log(`🚫 Auth hook: BLOCKED ${protocol} ${action} from banned IP ${ip} on "${streamPath}"`);
      return res.sendStatus(403);
    }

    res.sendStatus(200);
  } catch (err) {
    // Never let an unexpected error default to a rejection — log and allow
    console.error("⚠️  Auth hook error:", err.message, "body:", JSON.stringify(req.body));
    res.sendStatus(200);
  }
});

// Update overlay configuration
app.post("/api/stream/overlay", (req, res) => {
  const camIdx = parseInt(req.query.cam) === 2 ? 2 : 1;
  const overlayConfig = req.body;
  const result = getSC(camIdx).updateOverlay(overlayConfig);

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
  const camIdx = parseInt(req.query.cam) === 2 ? 2 : 1;
  const net    = require("net");
  // Camera 2 uses port 8556 when streaming via SRT; camera 1 uses 8555.
  // For idle preview, route to the per-camera preview port.
  const port   = getSC(camIdx).isStreaming
    ? (camIdx === 2 ? 8556 : 8555)
    : (camIdx === 2 ? IDLE_PREVIEW_PORT_2 : IDLE_PREVIEW_PORT);

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

// ── MediaMTX WHEP proxy helpers ──────────────────────────────────────────────

/**
 * Strip m=audio sections from an SDP buffer before forwarding to MediaMTX.
 *
 * The preview path carries H264 video only — no audio track.  When a browser
 * (especially iOS Safari/WebKit) includes an m=audio section in its WHEP offer,
 * MediaMTX cannot satisfy the audio requirement and immediately RST's the TCP
 * connection without returning any HTTP response.  Stripping audio here makes
 * every client (desktop Chrome, iOS Safari, Firefox) work uniformly.
 *
 * The function also removes stripped audio MIDs from the session-level
 * a=group:BUNDLE line so the resulting SDP remains well-formed.
 *
 * @param {Buffer} buf  Raw SDP body buffer
 * @returns {Buffer}    Buffer with audio sections removed (unchanged if none)
 */
function stripAudioFromSdp(buf) {
  const sdp = buf.toString("utf8");

  // Detect line ending style used in this SDP (RFC 4566 mandates CRLF but
  // browsers often send bare LF).
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(/\r?\n/);

  // First pass — collect MIDs of audio m-sections so we can scrub them from
  // the session-level a=group:BUNDLE attribute.
  const audioMids = [];
  let inAudio = false;
  for (const line of lines) {
    if (line.startsWith("m=audio")) { inAudio = true;  continue; }
    if (line.startsWith("m="))      { inAudio = false; }
    if (inAudio && line.startsWith("a=mid:")) audioMids.push(line.slice(6).trim());
  }

  if (audioMids.length === 0) return buf; // nothing to strip

  // Second pass — rebuild SDP without audio sections; patch BUNDLE group.
  const out = [];
  inAudio = false;
  for (const line of lines) {
    if (line.startsWith("m=audio")) { inAudio = true;  continue; }
    if (line.startsWith("m="))      { inAudio = false; }
    if (inAudio) continue;

    if (line.startsWith("a=group:BUNDLE")) {
      // Remove audio MIDs: "a=group:BUNDLE 0 1" → "a=group:BUNDLE 1"
      const parts = line.split(" ");
      out.push(parts.filter(p => !audioMids.includes(p)).join(" "));
    } else {
      out.push(line);
    }
  }

  return Buffer.from(out.join(eol), "utf8");
}

// ── MediaMTX WHEP proxy (WebRTC preview) ─────────────────────────────────────
// Proxies WebRTC-HTTP Egress Protocol (WHEP) requests to MediaMTX on port 8889.
//
// Used when the browser cannot reach MediaMTX port 8889 directly — specifically
// when the admin UI is accessed via a reverse proxy
// (e.g. cameras.digitalpool.com/camera/home-1). In that case the page is served
// from an HTTPS origin different from the device IP, so direct cross-origin /
// mixed-content requests to the NetBird IP are blocked by the browser.
// The proxy routes signaling through the same authenticated Express connection
// the browser already has open. The actual media UDP still flows directly over
// NetBird using the ICE candidates advertised in the SDP answer.
//
// POST /api/whep/preview  →  POST http://127.0.0.1:8889/preview/whep
// PATCH/DELETE /api/whep/preview/<sessionId>  →  PATCH/DELETE http://127.0.0.1:8889/preview/whep/<sessionId>
//
// The Location header from MediaMTX is rewritten from the internal address
// (http://127.0.0.1:8889/…) to a path rooted at /api/whep so the browser's
// follow-up PATCH/DELETE requests stay on port 3000.
//
// X-Forwarded-For carries the real client IP so MediaMTX's auth hook and
// connection logging see the actual viewer, not the proxy's localhost address.
//
// express.raw({ type: '*/*' }) MUST be used here instead of req.on("data").
// The global express.json() middleware (and keep-alive connection reuse) can
// leave the readable stream in a state where req.on("data") never fires, so
// the proxy would forward an empty POST body and MediaMTX would hang up.
// express.raw() buffers the entire body into req.body before this handler runs.
app.all("/api/whep/*path", requireAuth, express.raw({ type: "*/*" }), (req, res) => {
  const subpath = req.params.path; // e.g. "preview" or "preview/abc123"
  const reqBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  // POST /api/whep/preview → upstream POST http://127.0.0.1:8889/preview/whep
  // PATCH/DELETE /api/whep/preview/abc123 → upstream http://127.0.0.1:8889/preview/whep/abc123
  const upstreamPath = req.method === "POST"
    ? `/${subpath}/whep`
    : `/${subpath}`;

  // Real client IP — forwarded so MediaMTX sees the viewer, not localhost.
  // req.ip already respects any upstream X-Forwarded-For via Express trust proxy.
  const clientIp = req.ip || req.socket.remoteAddress || "unknown";

  // For WHEP POST offers, strip any m=audio sections before forwarding.
  // iOS Safari/WebKit adds audio transceivers automatically even when only
  // video is requested; MediaMTX ECONNRESET's offers that include audio on
  // a video-only path (no logged error — it just closes the TCP connection).
  const upstreamBody = (req.method === "POST" && reqBody.length > 0)
    ? stripAudioFromSdp(reqBody)
    : reqBody;
  if (upstreamBody.length !== reqBody.length) {
    console.log(`🔇 WHEP proxy: stripped audio from SDP (${reqBody.length} → ${upstreamBody.length} bytes)`);
  }

  console.log(`🔀 WHEP proxy: ${req.method} ${upstreamPath} bodyLen=${upstreamBody.length} clientIp=${clientIp}`);

  const options = {
    hostname: "127.0.0.1",
    port: 8889,
    path: upstreamPath,
    method: req.method,
    headers: {
      "content-type": req.headers["content-type"] || "application/sdp",
    },
    timeout: 10000,
    agent: false,   // no keep-alive pooling — always a fresh TCP connection to MediaMTX
  };
  if (upstreamBody.length > 0) options.headers["content-length"] = upstreamBody.length;

  let proxyDone = false; // set true once mediamtx responds — prevents spurious destroy

  const proxyReq = http.request(options, (upRes) => {
    proxyDone = true;
    console.log(`✅ WHEP upstream response: HTTP ${upRes.statusCode} for ${upstreamPath}`);
    res.status(upRes.statusCode);

    // Forward headers, rewriting Location so the browser stays on port 3000
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (k.toLowerCase() === "location") {
        const rewritten = v.replace(/^https?:\/\/[^/]+/, "/api/whep");
        res.setHeader("Location", rewritten);
      } else if (!["transfer-encoding", "connection"].includes(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    }

    upRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    console.error(`❌ WHEP proxy error (${upstreamPath}): ${err.message} [code=${err.code}] bodyLen=${reqBody.length}`);
    if (!res.headersSent) res.status(502).json({ error: "WHEP proxy failed" });
  });
  proxyReq.on("timeout", () => {
    console.error(`⏱️  WHEP proxy timeout for ${upstreamPath}`);
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).end();
  });

  // Only abort the upstream request if the browser disconnects BEFORE mediamtx
  // has responded.  If mediamtx already replied (proxyDone=true) the pipe handles
  // cleanup; calling destroy() again would log a spurious ECONNRESET.
  req.on("close", () => {
    if (!proxyDone) {
      console.warn(`⚠️  WHEP proxy: browser closed connection early for ${upstreamPath} (mediamtx had not yet responded)`);
      try { proxyReq.destroy(); } catch (_) {}
    }
  });

  if (upstreamBody.length > 0) proxyReq.write(upstreamBody);
  proxyReq.end();
});

// Serve HLS playlist and segments for preview when streaming
app.get("/video/hls/playlist.m3u8", (req, res) => {
  const fs = require("fs");

  if (!streamController.isStreaming) {
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
    return res.status(404).send("Segment not found");
  }


  res.setHeader("Content-Type", "video/mp2t");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Access-Control-Allow-Origin", "*");
  fs.createReadStream(segmentPath).pipe(res);
});

// TCP preview endpoint - proxies the GStreamer TCP server
app.get("/video/tcp-preview", (req, res) => {
  if (!streamController.isStreaming) {
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

  client.on("connect", () => { /* connected */ });

  client.on("data", (data) => {
    bytesReceived += data.length;
    try {
      res.write(data);
    } catch (e) {
      client.destroy();
    }
  });

  client.on("error", (err) => {
    console.error("❌ TCP preview error:", err.message);
    res.end();
  });

  client.on("end", () => { res.end(); });

  req.on("close", () => { client.destroy(); });
});

// Track active idle preview processes — one per camera
let currentIdlePreviewProcess  = null;  // Camera 1
let currentIdlePreviewProcess2 = null;  // Camera 2
let idlePreviewRestartTimer  = null;
let idlePreviewRestartTimer2 = null;
// Cancels the previous overlay-switch's pending "updated" listener + timers when
// a newer switch supersedes it, so a superseded switch doesn't fire a spurious
// settle/fallback rebuild. Keyed by camera index.
const _overlaySettleCleanup = { 1: null, 2: null };
// Whether the currently-running idle preview pipeline contains the named
// "overlay" element. When true, the gst-idle-preview.py runner hot-reloads the
// overlay PNG in place, so switching overlays needs NO pipeline rebuild.
const _idlePreviewHasOverlay = { 1: false, 2: false };
// 8554 is reserved for MediaMTX RTSP; 8553 & 8552 used for camera 1 & 2 idle preview
const IDLE_PREVIEW_PORT   = 8553;
const IDLE_PREVIEW_PORT_2 = 8552;

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
 * Encodes at 15 fps H.264 and pushes to rtmp://localhost:1935/preview[2] so MediaMTX
 * can serve it as WebRTC via WHEP at /api/whep/preview[2].
 * @param {number} [camIdx=1] Camera index (1 or 2)
 * @returns {string[]} Complete gst-launch-1.0 args
 */
function buildIdlePreviewGstArgs(camIdx = 1) {
  const sc = getSC(camIdx);
  const config = sc.streamConfig;
  const activeSource = getActiveSource(camIdx);
  const fs = require("fs");

  // ── Source-specific front-end of the pipeline ──
  // All paths produce normalised raw video (1280×720, 15 fps, any raw format)
  // after this block so the shared overlay section works identically for all sources.
  let gstArgs;

  if (activeSource.type === "ndi" && activeSource.ndiName) {
    console.log(`📡 [Cam${camIdx}] Building NDI idle preview pipeline for "${activeSource.ndiName}"`);
    gstArgs = [
      "ndisrc",
      `ndi-name="${activeSource.ndiName}"`,
      "connect-timeout=5000",
      // do-timestamp=true: GStreamer base class stamps each frame with the
      // pipeline's own running time the moment it is pushed out of ndisrc.
      // This avoids any clock skew between the NDI source's timecodes and the
      // gst-launch pipeline clock, which was causing videorate to stall frames
      // for 3+ seconds while waiting for timestamps to align.
      "do-timestamp=true",
      "!", "ndisrcdemux", "name=ndi_demux",
      "ndi_demux.video",
      "!",
      // 2-buffer leaky queue: just enough to decouple the demuxer thread from
      // videoconvert without accumulating latency.  leaky=downstream drops the
      // oldest buffer (head) when full, keeping the freshest frame in play.
      "queue", "max-size-buffers=2", "max-size-time=0", "max-size-bytes=0", "leaky=downstream",
      "!",
      "videoconvert",
      "!",
      // Downscale to the shared 1280×720 preview size. NDI sources arrive at
      // their native resolution (typically 1920×1080), and without this scale
      // the frame stays full-size while the overlay is composited at a fixed
      // 1280×720 — so the overlay only covers ~2/3 of the frame. Matching the
      // other sources here keeps the overlay filling the preview.
      "videoscale",
      "!",
      "video/x-raw,width=1280,height=720",
      "!",
      // 15 fps gives a smooth preview; drop-only=true means videorate only ever
      // discards excess frames from the 30-60 fps NDI source — it never duplicates.
      "videorate", "drop-only=true",
      "!",
      "video/x-raw,framerate=15/1",
      "!",
      "videoconvert",
      "!",
    ];
  } else if (activeSource.type === "rtsp" && activeSource.rtspUrl) {
    console.log(`📡 [Cam${camIdx}] Building RTSP idle preview pipeline for ${activeSource.rtspUrl}`);
    gstArgs = [
      // uridecodebin handles RTSP multi-stream (video+audio) gracefully:
      // the caps filter limits output pads to decoded video only, so no
      // dangling audio pad causes a NOT_LINKED fatal error.
      "uridecodebin", `uri=${activeSource.rtspUrl}`,
      "caps=video/x-raw",
      // videoconvert normalises the decoded caps (NV12, I420, BGR, etc.) to a
      // fixed raw format before videoscale and videorate.
      "!", "videoconvert",
      "!", "videoscale",
      "!", "video/x-raw,width=1280,height=720",
      "!", "videorate",
      "!", "video/x-raw,framerate=15/1",
      "!", "videoconvert",
      "!",
    ];
  } else if (activeSource.type === "rtmp" && activeSource.rtmpUrl) {
    console.log(`📡 [Cam${camIdx}] Building RTMP idle preview pipeline for ${activeSource.rtmpUrl}`);
    gstArgs = [
      // rtmpsrc pulls the RTMP/FLV stream; decodebin caps=video/x-raw restricts
      // its src pads to video-only so the unlinked audio decoded pad never causes
      // a NOT_LINKED fatal error.
      "rtmpsrc", `location=${activeSource.rtmpUrl}`,
      "!", "decodebin",
      "caps=video/x-raw",
      "!", "videoconvert",
      "!", "videoscale",
      "!", "video/x-raw,width=1280,height=720",
      "!", "videorate",
      "!", "video/x-raw,framerate=15/1",
      "!", "videoconvert",
      "!",
    ];
  } else {
    // ── USB source (default) ──
    const device = activeSource.device || (camIdx === 2 ? CAMERA_DEVICE_2 : CAMERA_DEVICE);
    const fmt    = camIdx === 2 ? cameraFormat2 : cameraFormat;
    if (fmt === 'yuyv') {
      // YUYV-only camera: omit format=YUYV from caps — Rockchip's RGA-backed
      // videoconvert doesn't list YUYV in its static sink pad template, so an
      // explicit format=YUYV constraint fails at parse time.  Without it,
      // GStreamer negotiates the format at runtime and the link succeeds.
      // Capture at native 720p directly from the camera — no videoscale needed.
      // Many YUYV-only cameras (e.g. Minrray) have a true 720p sensor that is
      // upscaled to 1080p inside the camera firmware.  Requesting 1920×1080 and
      // then scaling back down in the pipeline causes double-scaling artifacts
      // and blurring.  Capturing at 1280×720 gives the cleanest possible output
      // from the sensor and matches the overlay/preview target resolution exactly.
      gstArgs = [
        "v4l2src",
        `device=${device}`,
        "do-timestamp=true",
        "!",
        // No framerate in the v4l2src caps — some YUYV cameras (e.g. Minrray10)
        // only deliver 1280x720 at 15 fps and a 30/1 request fails with
        // "not-negotiated (-4)".  Negotiate whatever rate the device offers
        // here; videorate below normalises to the 15 fps preview target.
        "video/x-raw,width=1280,height=720",
        "!",
        "videoconvert",        // YUYV → NV12
        "!",
        "video/x-raw,format=NV12",
        "!",
        "videorate",           // any camera rate → 15fps
        "!",
        "video/x-raw,framerate=15/1",
        "!",
        // No trailing videoconvert — tail's videoconvert→NV12 is a no-op here
        // since we're already NV12, which is what mpph264enc needs.
      ];
    } else {
      // MJPEG camera (default): JPEG decode → scale to 720p.
      // Use _getJpegDecoder() to select the right decoder:
      //   mppjpegdec  — Rockchip MPP hardware; requires jpegparse upstream
      //   vajpegdec   — Intel VA-API hardware (vah264enc systems); no jpegparse needed
      //   jpegdec     — software fallback
      // jpegparse is added only for mppjpegdec — jpegparse is too strict and rejects
      // JPEG streams with minor header quirks (e.g. "Duplicated or bad SOF marker") that
      // jpegdec/vajpegdec handle gracefully without it.
      const jpegDec = sc._getJpegDecoder(config.encoder);
      const jpegParseArgs = jpegDec === "mppjpegdec" ? ["jpegparse", "!"] : [];
      gstArgs = [
        "v4l2src",
        `device=${device}`,
        "do-timestamp=true",
        "!",
        // Cap capture framerate to 15fps at the source so the camera driver
        // delivers 15fps JPEG frames over USB.  Without this, v4l2src requests
        // the camera's highest framerate (e.g. 60fps), jpegdec decodes every
        // frame at full 1080p resolution, and videorate discards 45 of 60 frames
        // — paying full CPU cost for frames we immediately throw away.
        // Requesting 15/1 here cuts jpegdec work by 4x before any data enters
        // the pipeline.
        `image/jpeg,width=${config.width || 1920},height=${config.height || 1080},framerate=15/1`,
        "!",
        ...jpegParseArgs,
        jpegDec,               // Hardware (mppjpegdec) or software (jpegdec) JPEG decode
        "!",
        "videoscale",          // Decode resolution → 1280×720
        "!",
        "video/x-raw,width=1280,height=720",
        "!",
        "videorate",           // normalise to exactly 15fps (no-op if source already 15fps)
        "!",
        "video/x-raw,framerate=15/1",
        "!",
        "videoconvert",
        "!",
      ];
    }
  }

  // Insert videoflip element when camera is mounted in a non-standard orientation.
  // videoflip runs before overlays so text is always right-side-up regardless of flip.
  // GStreamer flip methods: 0=none, 2=rotate-180 (H+V), 4=horizontal-flip, 5=vertical-flip
  const flipH = config.flipHorizontal || false;
  const flipV = config.flipVertical   || false;
  let flipMethod = 0;
  if (flipH && flipV) flipMethod = 2;
  else if (flipH)     flipMethod = 4;
  else if (flipV)     flipMethod = 5;
  if (flipMethod !== 0) {
    gstArgs.push("videoflip", `method=${flipMethod}`, "!");
  }

  // Check if the remote overlay PNG exists and should be shown.
  // Each camera uses its own PNG so overlays don't overwrite each other.
  const pngOverlayPath = sc.pngOverlayPath;
  const hasRemoteOverlay = config.remoteOverlayEnabled && config.overlayUrl && config.overlayUrl.trim();
  let pngExists = false;
  if (hasRemoteOverlay) {
    try {
      const exists = fs.existsSync(pngOverlayPath);
      const size = exists ? fs.statSync(pngOverlayPath).size : 0;
      pngExists = exists && size > 100;
    } catch (e) {
      console.error(`❌ Remote overlay check error: ${e.message}`);
    }
  }

  const hasAnyOverlay = config.overlayEnabled || config.showTimestamp || (hasRemoteOverlay && pngExists);

  if (hasAnyOverlay) {
    // Remote overlay PNG — rendered FIRST so text/timestamp appear on top of it
    if (hasRemoteOverlay && pngExists) {
      gstArgs.push(
        "gdkpixbufoverlay",
        "name=overlay",   // named so gst-idle-preview.py can hot-reload its PNG
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

  // H.264 encode and push to MediaMTX for WebRTC delivery.
  // Encoder is selected dynamically to match the hardware on this machine:
  //   Rockchip (mpph264enc): needs NV12 input, bitrate in bps
  //   Intel VA-API (vaapih264enc): accepts any raw format, bitrate in kbps
  //   Software / other (x264enc): needs I420 input, bitrate in kbps
  // config-interval=-1 on h264parse embeds SPS/PPS before every IDR so MediaMTX can
  // start a new WebRTC session mid-stream without waiting for the next keyframe.
  // async=false on rtmpsink lets the pipeline reach PLAYING before RTMP connects.
  const idleEncoder = config.encoder || "mpph264enc";
  // Idle preview runs alone (no main stream competing for VA-API), so hardware encoders
  // are safe here without contention.
  // omxh264videoenc (Allwinner OMX) has a multi-second cold-start delay that causes
  // librtmp to drop the RTMP connection before the first frame arrives — fall back to x264enc.
  // VA-API (vah264enc / vaapih264enc): use x264enc for idle previews.
  // Both cameras run idle previews concurrently. The N97 cannot sustain two
  // simultaneous vah264enc sessions — the second session's VA-API pool negotiation
  // kills the first process. x264enc at ultrafast/720p/15fps uses ~5% CPU and
  // lets both previews coexist without VA-API contention.
  // Rockchip mpph264enc and Allwinner omxh264videoenc use x264enc for their own reasons
  // (MPP is fine with two sessions but idle is low-priority; OMX has cold-start delays).
  const idleEncArgs = idleEncoder === "mpph264enc"
    ? ["videoconvert", "!", "video/x-raw,format=NV12", "!", "mpph264enc", "bps=2000000", "header-mode=each-idr", "gop=15", "!"]
    : ["videoconvert", "!", "video/x-raw,format=I420", "!", "x264enc", "bitrate=2000", "speed-preset=ultrafast", "tune=zerolatency", "key-int-max=15", "!"];

  gstArgs.push(
    ...idleEncArgs,
    "h264parse", "config-interval=-1",
    "!",
    "video/x-h264,stream-format=avc,alignment=au",
    "!",
    "queue", "max-size-buffers=0", "max-size-time=500000000", "max-size-bytes=0", "leaky=downstream",
    "!",
    "flvmux", "streamable=true",
    "!",
    "rtmpsink", `location=rtmp://localhost:1935${getSC(camIdx).previewPath}`, "sync=false", "async=false",
  );

  // NDI sources carry an audio pad that this video-only preview never links.
  // ndisrcdemux pushes an audio buffer as soon as it appears; with no sink it
  // returns NOT_LINKED, which propagates back through ndisrc as a fatal
  // "Internal data stream error" and kills the preview.  Give the pad a
  // fakesink so it has somewhere to go.  (The live pipeline handles the same
  // hazard with a DROP probe in gst-overlay-pipeline.py.)  async=false keeps a
  // late-appearing audio pad from stalling the pipeline's preroll.
  if (activeSource.type === "ndi" && activeSource.ndiName) {
    gstArgs.push(
      "ndi_demux.audio",
      "!", "queue", "max-size-buffers=2", "max-size-time=0", "max-size-bytes=0", "leaky=downstream",
      "!", "fakesink", "sync=false", "async=false",
    );
  }

  return gstArgs;
}

/**
 * Start (or restart) the persistent idle preview GStreamer process.
 * Encodes at 15 fps H.264 and pushes to rtmp://localhost:1935/preview[2] so MediaMTX
 * can serve it as WebRTC (WHEP) at /api/whep/preview[2].
 * Protected by per-camera mutexes to prevent concurrent calls from racing.
 * @param {number} [camIdx=1] Camera index (1 or 2)
 */
// Per-camera mutex state
let _idlePreviewStarting  = false; // Camera 1
let _idlePreviewStarting2 = false; // Camera 2
let _idlePreviewStartQueue  = null;
let _idlePreviewStartQueue2 = null;

// Backoff state for idle preview auto-restart (per camera).
let _lastIdlePreviewSpawnTime  = 0;  // Camera 1 last spawn ms
let _lastIdlePreviewSpawnTime2 = 0;  // Camera 2 last spawn ms
let _idlePreviewFailStreak     = 0;  // Camera 1 quick-exit count
let _idlePreviewFailStreak2    = 0;  // Camera 2 quick-exit count
// Cooldown schedule (ms) indexed by fail streak — capped at 60 s.
const _IDLE_BACKOFF_MS = [0, 3000, 5000, 10000, 20000, 30000, 60000];

async function startPersistentIdlePreview(camIdx = 1) {
  const sc = getSC(camIdx);
  const activeSource = getActiveSource(camIdx);
  const isStarting   = camIdx === 2 ? _idlePreviewStarting2 : _idlePreviewStarting;
  const startQueue   = camIdx === 2 ? _idlePreviewStartQueue2 : _idlePreviewStartQueue;
  const failStreak   = camIdx === 2 ? _idlePreviewFailStreak2 : _idlePreviewFailStreak;
  const curProc      = camIdx === 2 ? currentIdlePreviewProcess2 : currentIdlePreviewProcess;

  // "No Camera" — this slot is intentionally empty; nothing to preview and the
  // physical device must stay released so the other slot can claim it.  Guarding
  // here covers every caller (boot restore, /video/stream, gst-close auto-restart).
  if (activeSource.type === "none") {
    console.log(`⚪ [Cam${camIdx}] Idle preview skipped — source is "No Camera"`);
    return;
  }

  // Don't start if this camera's stream is active
  if (sc.isStreaming) {
    console.log(`⚠️  [Cam${camIdx}] Not starting idle preview — stream is active`);
    return;
  }

  // If another call is already in progress for this camera, wait for it to finish
  if (isStarting) {
    console.log(`⏳ [Cam${camIdx}] Idle preview start already in progress — waiting...`);
    if (startQueue) await startQueue;
    return;
  }

  // ── Backoff cooldown ─────────────────────────────────────────────────────
  const backoffMs = _IDLE_BACKOFF_MS[Math.min(failStreak, _IDLE_BACKOFF_MS.length - 1)];
  if (backoffMs > 0) {
    console.log(`⏳ [Cam${camIdx}] Idle preview backoff (streak=${failStreak}) — waiting ${backoffMs}ms...`);
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  if (sc.isStreaming || isRestartInProgress[camIdx]) {
    console.log(`⚠️  [Cam${camIdx}] Not starting idle preview — stream active or restart in progress`);
    return;
  }

  // Declare the resolver variables BEFORE the Promise executors reference them
  // to avoid the JavaScript Temporal Dead Zone (TDZ) error.
  let _resolveQueue, _resolveQueue2;
  if (camIdx === 2) { _idlePreviewStarting2 = true; _idlePreviewStartQueue2 = new Promise((r) => { _resolveQueue2 = r; }); }
  else              { _idlePreviewStarting  = true; _idlePreviewStartQueue  = new Promise((r) => { _resolveQueue  = r; }); }

  try {
    // Kill existing idle preview process for this camera
    if (curProc && !curProc.killed) {
      console.log(`🔄 [Cam${camIdx}] Killing previous idle preview`);
      // Mark this as a deliberate kill (we're rebuilding, e.g. for an overlay
      // change) so its "close" handler doesn't miscount the short lifetime as a
      // crash and trigger the failure-streak backoff on the rebuild.
      curProc._intentionalKill = true;
      curProc.kill("SIGTERM");
      if (camIdx === 2) currentIdlePreviewProcess2 = null;
      else              currentIdlePreviewProcess  = null;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    const gstArgs = buildIdlePreviewGstArgs(camIdx);
    const previewPath = sc.previewPath;
    // Track whether this build includes the hot-swappable overlay element, so the
    // socket handler knows a later overlay switch can skip the rebuild.
    _idlePreviewHasOverlay[camIdx] = gstArgs.includes("name=overlay");
    console.log(`📹 [Cam${camIdx}] Starting idle preview → rtmp://localhost:1935${previewPath} (source: ${activeSource.type}${_idlePreviewHasOverlay[camIdx] ? ", overlay hot-swap" : ""})`);

    // Run via gst-idle-preview.py (Gst.parse_launchv → identical pipeline to
    // gst-launch-1.0) so the overlay PNG can be hot-reloaded at runtime instead
    // of requiring a pipeline rebuild. arg 1 is the overlay PNG to watch.
    const idlePreviewScript = path.join(__dirname, "gst-idle-preview.py");
    const gst = spawn("python3", [idlePreviewScript, sc.pngOverlayPath || "", ...gstArgs]);
    if (camIdx === 2) currentIdlePreviewProcess2 = gst;
    else              currentIdlePreviewProcess  = gst;
    const spawnTime = Date.now();
    if (camIdx === 2) _lastIdlePreviewSpawnTime2 = spawnTime;
    else              _lastIdlePreviewSpawnTime  = spawnTime;

    gst.stdout.on("data", () => {});
    gst.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg && /error|warning|failed|cannot|unable/i.test(msg)) {
        console.error(`GStreamer idle [Cam${camIdx}]: ${msg}`);
      }
    });

    gst.on("close", (code) => {
      const lifetime = Date.now() - spawnTime;
      console.log(`GStreamer idle preview [Cam${camIdx}] exited with code ${code} (ran ${lifetime}ms)`);
      if (camIdx === 2) { if (currentIdlePreviewProcess2 === gst) currentIdlePreviewProcess2 = null; }
      else              { if (currentIdlePreviewProcess  === gst) currentIdlePreviewProcess  = null; }

      if (lifetime < 8000 && !gst._intentionalKill) {
        if (camIdx === 2) _idlePreviewFailStreak2 = Math.min(_idlePreviewFailStreak2 + 1, _IDLE_BACKOFF_MS.length - 1);
        else              _idlePreviewFailStreak  = Math.min(_idlePreviewFailStreak  + 1, _IDLE_BACKOFF_MS.length - 1);
        console.log(`⚠️  [Cam${camIdx}] Idle preview died quickly`);
      } else {
        if (camIdx === 2) _idlePreviewFailStreak2 = 0;
        else              _idlePreviewFailStreak  = 0;
      }

      const startingNow = camIdx === 2 ? _idlePreviewStarting2 : _idlePreviewStarting;
      if (!sc.isStreaming && !startingNow && !isRestartInProgress[camIdx] && bootComplete) {
        console.log(`📹 [Cam${camIdx}] Idle preview died — scheduling auto-restart...`);
        startPersistentIdlePreview(camIdx)
          .then(() => { io.emit("refreshIdlePreview", { cameraIndex: camIdx }); })
          .catch((err) => { console.error(`⚠️  [Cam${camIdx}] Idle preview auto-restart failed:`, err.message); });
      }
    });

    gst.on("error", (err) => {
      console.error(`Failed to start GStreamer idle preview [Cam${camIdx}]:`, err);
      if (camIdx === 2) { if (currentIdlePreviewProcess2 === gst) currentIdlePreviewProcess2 = null; }
      else              { if (currentIdlePreviewProcess  === gst) currentIdlePreviewProcess  = null; }
    });

    await new Promise((resolve) => setTimeout(resolve, 800));
  } finally {
    if (camIdx === 2) { _idlePreviewStarting2 = false; if (_resolveQueue2) _resolveQueue2(); _idlePreviewStartQueue2 = null; }
    else              { _idlePreviewStarting  = false; if (_resolveQueue)  _resolveQueue();  _idlePreviewStartQueue  = null; }
  }
}

// Video stream endpoint using MJPEG — proxies the persistent idle preview TCP server
// Supports ?cam=1 (default) or ?cam=2 for the second camera.
app.get("/video/stream", async (req, res) => {
  const camIdx = parseInt(req.query.cam) === 2 ? 2 : 1;
  const sc = getSC(camIdx);
  const activeSource = getActiveSource(camIdx);
  const previewPort = camIdx === 2 ? IDLE_PREVIEW_PORT_2 : IDLE_PREVIEW_PORT;
  const curProc     = camIdx === 2 ? currentIdlePreviewProcess2 : currentIdlePreviewProcess;

  // If streaming is active, don't try to access camera for idle preview
  if (sc.isStreaming) {
    res.status(503).send("Stream active - use WebRTC preview");
    return;
  }

  if (!bootComplete) {
    console.log(`⏳ [Cam${camIdx}] Boot still in progress — waiting for idle preview`);
  } else if (!curProc || curProc.killed) {
    console.log(`📹 [Cam${camIdx}] No idle preview running — starting (source: ${activeSource.type})...`);
    await startPersistentIdlePreview(camIdx);
  }

  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const net = require("net");
  let retries = 0;
  const maxRetries = bootComplete ? 15 : 30;
  let currentClient = null;
  let reqClosed = false;

  req.on("close", () => {
    reqClosed = true;
    if (currentClient) currentClient.destroy();
  });

  function connectToPreview() {
    if (reqClosed) return;
    const client = net.connect({ port: previewPort, host: "localhost" });
    currentClient = client;

    client.on("connect", () => { /* connected */ });
    client.on("data", (data) => {
      try { res.write(data); } catch (err) { client.destroy(); }
    });
    client.on("error", (err) => {
      if (reqClosed) return;
      if (retries < maxRetries) { retries++; setTimeout(connectToPreview, 1000); }
      else { console.error(`❌ [Cam${camIdx}] Could not connect to idle preview after ${maxRetries} attempts`); try { res.end(); } catch (e) {} }
    });
    client.on("close", () => { if (reqClosed) return; try { res.end(); } catch (e) {} });
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
  // All camera socket events accept an optional `cameraIndex` (1 or 2) in the payload.
  socket.on("setControl", async (data) => {
    const camIdx = parseInt(data?.cameraIndex) === 2 ? 2 : 1;
    const { control, value } = data;
    console.log(`📡 Client ${socket.id} sent setControl [Cam${camIdx}]: ${control} = ${value}`);

    // Ignore commands if camera is still initializing
    const initialized = camIdx === 2 ? cameraInitialized2 : cameraInitialized;
    if (!initialized) {
      console.log(`⚠️  [Cam${camIdx}] Ignoring command - camera still initializing`);
      return;
    }

    const result = await getCam(camIdx).setControl(control, value);
    socket.emit("controlResult", result);
  });

  socket.on("getControl", async (data) => {
    const camIdx = parseInt(data?.cameraIndex) === 2 ? 2 : 1;
    const { control } = data;
    const result = await getCam(camIdx).getControl(control);
    socket.emit("controlResult", result);
  });

  socket.on("pan", async (data) => {
    const camIdx = parseInt(data?.cameraIndex) === 2 ? 2 : 1;
    const { steps } = data;
    // Respect panInverted flag — some cameras (e.g. Minrray) have the pan
    // motor wired opposite to the OBSBot convention used by the UI buttons.
    const panInverted = getSC(camIdx).streamConfig?.panInverted || false;
    const effectiveSteps = panInverted ? -steps : steps;
    console.log(`📡 Client ${socket.id} sent pan [Cam${camIdx}]: ${steps} steps${panInverted ? ' (inverted → ' + effectiveSteps + ')' : ''}`);
    const result = await getCam(camIdx).pan(effectiveSteps);
    socket.emit("controlResult", result);
  });

  socket.on("tilt", async (data) => {
    const camIdx = parseInt(data?.cameraIndex) === 2 ? 2 : 1;
    const { steps } = data;
    console.log(`📡 Client ${socket.id} sent tilt [Cam${camIdx}]: ${steps} steps`);
    const result = await getCam(camIdx).tilt(steps);
    socket.emit("controlResult", result);
  });

  socket.on("zoom", async (data) => {
    const camIdx = parseInt(data?.cameraIndex) === 2 ? 2 : 1;
    const { level } = data;
    const result = await getCam(camIdx).zoom(level);
    socket.emit("controlResult", result);
  });

  socket.on("resetPosition", async (data) => {
    const camIdx = parseInt(data?.cameraIndex) === 2 ? 2 : 1;
    const result = await getCam(camIdx).resetPosition();
    socket.emit("controlResult", result);
  });

  socket.on("getCameraConfig", (data) => {
    const camIdx = parseInt(data?.cameraIndex) === 2 ? 2 : 1;
    const cam = getCam(camIdx);
    // Include the list of controls this camera actually supports so the UI
    // can dim controls that don't exist on the attached camera.
    const hwControls = cam.discoveredControls || cam.controls;

    // Send the actual hardware min/max/step for pan and tilt so the client can
    // compute step sizes that match this camera's range and minimum motor step.
    const ptzRanges = {};
    if (hwControls.pan_absolute)  ptzRanges.pan_absolute  = { min: hwControls.pan_absolute.min,  max: hwControls.pan_absolute.max,  step: hwControls.pan_absolute.step  };
    if (hwControls.tilt_absolute) ptzRanges.tilt_absolute = { min: hwControls.tilt_absolute.min, max: hwControls.tilt_absolute.max, step: hwControls.tilt_absolute.step };

    // Determine whether the camera hardware is actually present so the UI can
    // show "No Camera" instead of "Connected" when no device is plugged in.
    const activeSource = getActiveSource(camIdx);
    let cameraPresent = false;
    if (activeSource.type === "usb") {
      const dev = activeSource.device || (camIdx === 2 ? CAMERA_DEVICE_2 : CAMERA_DEVICE);
      cameraPresent = fsSync.existsSync(dev);
    } else if (activeSource.type === "rtsp") {
      cameraPresent = !!(activeSource.rtspUrl);
    } else if (activeSource.type === "rtmp") {
      cameraPresent = !!(activeSource.rtmpUrl);
    } else if (activeSource.type === "ndi") {
      cameraPresent = !!(activeSource.ndiName);
    }

    socket.emit("cameraConfig", {
      cameraIndex: camIdx,
      success: true,
      config: cam.config,
      supportedControls: Object.keys(hwControls),
      ptzRanges,
      cameraPresent,
    });
  });

  socket.on("setStartupPosition", (data) => {
    const camIdx = parseInt(data?.cameraIndex) === 2 ? 2 : 1;
    const result = getCam(camIdx).saveStartupPosition();
    socket.emit("startupPositionSet", result);
  });

  socket.on("getStartupPosition", (data) => {
    const camIdx = parseInt(data?.cameraIndex) === 2 ? 2 : 1;
    const position = getCam(camIdx).loadStartupPosition();
    socket.emit("startupPosition", { position });
  });

  socket.on("resetCameraSettings", async (data) => {
    const camIdx = parseInt(data?.cameraIndex) === 2 ? 2 : 1;
    const cam = getCam(camIdx);
    const results = await cam.resetToDefaults();
    // resetToDefaults re-runs discoverControls — include the fresh hardware
    // control set and PTZ ranges so the UI refreshes its dim state too.
    const hwControls = cam.discoveredControls || cam.controls;
    const ptzRanges = {};
    if (hwControls.pan_absolute)  ptzRanges.pan_absolute  = { min: hwControls.pan_absolute.min,  max: hwControls.pan_absolute.max,  step: hwControls.pan_absolute.step  };
    if (hwControls.tilt_absolute) ptzRanges.tilt_absolute = { min: hwControls.tilt_absolute.min, max: hwControls.tilt_absolute.max, step: hwControls.tilt_absolute.step };
    // Broadcast to all clients so other tabs/devices viewing the same camera
    // pick up the refreshed capabilities, mirroring the source-switch handler.
    io.emit("cameraConfigReset", {
      cameraIndex: camIdx,
      success: true,
      results: results,
      config: cam.config,
      supportedControls: Object.keys(hwControls),
      ptzRanges,
    });
  });

  // ── WHEP signaling relay over Socket.IO ────────────────────────────────────
  // When the browser reaches us through a reverse proxy (NetBird),
  // the HTTP WHEP proxy (/api/whep/*) times out because the proxy layer closes
  // idle HTTP connections before MediaMTX finishes SDP negotiation.
  // Relaying over the existing Socket.IO WebSocket avoids this — the WS
  // connection is already stable and long-lived through the reverse proxy.
  socket.on("whep-offer", async ({ streamPath, sdp: offerSdp }) => {
    if (!streamPath || !offerSdp) {
      socket.emit("whep-answer", { error: "missing streamPath or sdp" });
      return;
    }
    console.log(`🔀 WHEP socket relay: ${socket.id} → /${streamPath}/whep`);

    const bodyBuf = stripAudioFromSdp(Buffer.from(offerSdp, "utf8"));
    if (bodyBuf.length < Buffer.byteLength(offerSdp, "utf8")) {
      console.log(`🔇 WHEP socket: stripped audio (${Buffer.byteLength(offerSdp)} → ${bodyBuf.length} bytes)`);
    }

    const result = await new Promise((resolve) => {
      const reqOptions = {
        hostname: "127.0.0.1",
        port: 8889,
        path: `/${streamPath}/whep`,
        method: "POST",
        headers: {
          "content-type": "application/sdp",
          "content-length": bodyBuf.length,
        },
        timeout: 15000,
        agent: false,
      };
      const relayReq = http.request(reqOptions, (upRes) => {
        let raw = "";
        upRes.setEncoding("utf8");
        upRes.on("data", (chunk) => { raw += chunk; });
        upRes.on("end", () => {
          let location = upRes.headers["location"] || null;
          if (location) {
            // Rewrite http://127.0.0.1:8889/... → /api/whep/... so any
            // follow-up PATCH/DELETE from the browser stay on the proxy path.
            location = location.replace(/^https?:\/\/[^/]+/, "/api/whep");
          }
          resolve({ status: upRes.statusCode, sdp: raw, location });
        });
      });
      relayReq.on("error", (err) => {
        console.error(`❌ WHEP socket relay error: ${err.message}`);
        resolve({ error: err.message });
      });
      relayReq.on("timeout", () => {
        relayReq.destroy();
        resolve({ error: "mediamtx timeout" });
      });
      relayReq.write(bodyBuf);
      relayReq.end();
    });

    if (result.error) {
      console.error(`❌ WHEP socket relay failed: ${result.error} (${socket.id})`);
    } else {
      console.log(`✅ WHEP socket relay: HTTP ${result.status} → ${socket.id}`);
    }
    socket.emit("whep-answer", result);
  });

  // ============ STREAMING SOCKET EVENTS ============
  // All streaming events accept an optional `cameraIndex` (1 or 2) in the payload.

  socket.on("startStream", async (config) => {
    // Registration gate — dpadmin bypasses for support access
    if (!isRegistered() && socket.request.session?.user?.username !== "dpadmin") {
      socket.emit("streamResult", {
        success: false,
        error: "Device not registered. Complete registration in Admin Settings first.",
      });
      return;
    }
    const camIdx = parseInt(config?.cameraIndex) === 2 ? 2 : 1;
    const sc = getSC(camIdx);
    // Guard: prevent the idle preview's 'close' event from auto-restarting a new
    // preview process while we're still in the startStream sequence.  Without this,
    // _killCameraProcesses() inside startStream kills the idle preview, the close
    // handler fires (sc.isStreaming is still false), a fresh idle preview grabs the
    // camera, and the main pipeline immediately fails with "Device busy".
    isRestartInProgress[camIdx] = true;
    await _killIdlePreviewForCamera(camIdx);
    io.emit("streamStatus", { ...sc.getStatus(), status: "starting", cameraIndex: camIdx });
    const result = await sc.startStream(config);
    if (!result.success) {
      // Stream failed to start — clear the guard and restore the idle preview so
      // the user still has a live WebRTC preview.
      isRestartInProgress[camIdx] = false;
      startPersistentIdlePreview(camIdx)
        .then(() => io.emit("refreshIdlePreview", { cameraIndex: camIdx }))
        .catch(() => {});
    }
    // On success, isRestartInProgress[camIdx] is cleared by the "started" event handler.
    socket.emit("streamResult", result);
  });

  socket.on("stopStream", async (data) => {
    const camIdx = parseInt(data?.cameraIndex) === 2 ? 2 : 1;
    const sc = getSC(camIdx);
    io.emit("streamStatus", { ...sc.getStatus(), status: "stopping", cameraIndex: camIdx });
    const result = await sc.stopStream();
    socket.emit("streamResult", result);
  });

  // Atomic restart: stop → start without showing the idle preview in between.
  socket.on("restartStream", async (config) => {
    // Registration gate — dpadmin bypasses for support access
    if (!isRegistered() && socket.request.session?.user?.username !== "dpadmin") {
      socket.emit("streamResult", {
        success: false,
        error: "Device not registered. Complete registration in Admin Settings first.",
      });
      return;
    }
    const camIdx = parseInt(config?.cameraIndex) === 2 ? 2 : 1;
    const sc = getSC(camIdx);
    console.log(`🔄 [Cam${camIdx}] Restarting stream...`);
    isRestartInProgress[camIdx] = true;
    try {
      io.emit("streamStatus", { ...sc.getStatus(), status: "restarting", cameraIndex: camIdx });

      if (sc.isStreaming) {
        io.emit("streamStatus", { ...sc.getStatus(), status: "stopping", cameraIndex: camIdx });
        await sc.stopStream();
      }

      isRestartInProgress[camIdx] = false;
      io.emit("streamStatus", { ...sc.getStatus(), status: "starting", cameraIndex: camIdx });
      const result = await sc.startStream(config);
      socket.emit("streamResult", result);
    } catch (err) {
      console.error(`⚠️  [Cam${camIdx}] restartStream error:`, err.message);
      isRestartInProgress[camIdx] = false;
      socket.emit("streamResult", { success: false, error: err.message });
      startPersistentIdlePreview(camIdx)
        .then(() => io.emit("refreshIdlePreview", { cameraIndex: camIdx }))
        .catch(() => {});
    }
  });

  socket.on("getStreamStatus", (data) => {
    const camIdx = parseInt(data?.cameraIndex) === 2 ? 2 : 1;
    socket.emit("streamStatus", { ...getSC(camIdx).getStatus(), cameraIndex: camIdx });
  });

  socket.on("updateStreamConfig", (config) => {
    const camIdx = parseInt(config?.cameraIndex) === 2 ? 2 : 1;
    const result = getSC(camIdx).updateConfig(config);
    socket.emit("streamResult", result);
  });

  socket.on("updateOverlay", async (overlayConfig) => {
    const camIdx = parseInt(overlayConfig?.cameraIndex) === 2 ? 2 : 1;
    const sc = getSC(camIdx);
    const result = sc.updateOverlay(overlayConfig);

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
    // Use the per-camera Puppeteer instance so each camera has an independent renderer.
    const wantsRemote = overlayConfig.remoteOverlayEnabled &&
      overlayConfig.overlayUrl && overlayConfig.overlayUrl.trim();
    let camPuppeteer = camIdx === 2 ? puppeteerOverlay2 : puppeteerOverlay;
    if (wantsRemote) {
      if (!camPuppeteer && PuppeteerOverlay) {
        camPuppeteer = new PuppeteerOverlay();
        if (camIdx === 2) puppeteerOverlay2 = camPuppeteer;
        else puppeteerOverlay = camPuppeteer;
      }
      if (camPuppeteer) {
        if (!camPuppeteer.isRunning) {
          await camPuppeteer.initialize(PORT, sc.pngOverlayPath);
        }
        camPuppeteer.setOverlayUrl(overlayConfig.overlayUrl, {
          zoom: overlayConfig.overlayZoom,
        });
        camPuppeteer.startPeriodicRefresh();

        if (!sc.isStreaming && _idlePreviewHasOverlay[camIdx]) {
          // The running idle preview already has the hot-swappable overlay
          // element. gst-idle-preview.py reloads the PNG on mtime, so switching
          // to a different overlay needs NO pipeline rebuild — the new overlay
          // appears within ~2s of its screenshot landing, with no blink and no
          // settle/stale-frame juggling. Cancel any leftover settle from a prior
          // enable and do nothing else here.
          if (_overlaySettleCleanup[camIdx]) _overlaySettleCleanup[camIdx]();
          console.log(`♻️  [Cam${camIdx}] Overlay switch — hot-swapping PNG in place (no rebuild)`);
        } else if (!sc.isStreaming) {
          const restartTimer = camIdx === 2 ? idlePreviewRestartTimer2 : idlePreviewRestartTimer;
          clearTimeout(restartTimer);
          const restartForOverlay = async (reason) => {
            console.log(`📸 [Cam${camIdx}] ${reason} — restarting idle preview to show overlay`);
            // Drain any in-flight idle-preview start first. startPersistentIdlePreview
            // silently no-ops while another start is running, so calling it during
            // one (boot, source setup, auto-restart, /video/stream) would drop our
            // rebuild — leaving a pipeline with no gdkpixbufoverlay and the overlay
            // permanently invisible. Waiting for the queue to clear guarantees our
            // rebuild actually runs and picks up the now-present overlay PNG.
            let q = camIdx === 2 ? _idlePreviewStartQueue2 : _idlePreviewStartQueue;
            while (q) {
              try { await q; } catch (_) { /* ignore */ }
              q = camIdx === 2 ? _idlePreviewStartQueue2 : _idlePreviewStartQueue;
            }
            await startPersistentIdlePreview(camIdx);
            // Emit only after the rebuild has spawned + settled so the browser
            // reconnects to the pipeline that actually composites the overlay.
            io.emit("refreshIdlePreview", { cameraIndex: camIdx });
          };
          // The idle preview is a plain gst-launch pipeline built once; it only
          // includes gdkpixbufoverlay if the PNG already exists (>100 bytes) at
          // build time. So we must restart the preview on the first *real*
          // screenshot ("updated" only fires on real captures in URL mode — never
          // the placeholder). Remote pages can be slow to load (30s+), so do NOT
          // remove this listener when the safety timeout fires: if we only got the
          // fallback restart, the PNG was still the placeholder and the pipeline
          // has no overlay element — the late screenshot must trigger one more
          // restart that actually composites the overlay.
          // The idle preview is a gst-launch pipeline that bakes the PNG in at
          // build time and can't hot-reload it — so it freezes on whatever PNG
          // exists at rebuild time. Two hazards to avoid:
          //   1) A screenshot of the *previous* overlay (an in-flight render that
          //      completes right after the switch) must NOT trigger the rebuild —
          //      it would freeze the old/stale frame before the new one loads. So
          //      only act on a screenshot tagged with THIS overlay's URL.
          //   2) The first new-overlay screenshot is often captured before the
          //      page finished rendering its data. So after the first matching
          //      screenshot, wait a short settle window (Puppeteer keeps writing a
          //      fresher PNG every 2s) and rebuild once with the complete frame.
          // The previous overlay stays visible until the rebuild.
          // Supersede any pending settle from an earlier, now-outdated switch.
          if (_overlaySettleCleanup[camIdx]) _overlaySettleCleanup[camIdx]();

          const targetOverlayUrl = overlayConfig.overlayUrl.trim();
          let settleTimer = null;
          const onUpdated = (_pngPath, loadedUrl) => {
            if (loadedUrl !== targetOverlayUrl) return; // stale frame of a prior overlay — ignore
            clearTimeout(fallback);
            if (settleTimer) return; // settle already scheduled by the first matching screenshot
            camPuppeteer.off("updated", onUpdated); // got our target overlay; stop listening
            settleTimer = setTimeout(() => {
              restartForOverlay("Overlay settled");
            }, 4000);
          };
          // Safety net only: if Puppeteer never produces a screenshot (site down,
          // etc.) the running preview keeps showing plain video. Restart once so
          // the UI reflects the attempt, but keep listening for a late screenshot.
          const fallback = setTimeout(() => {
            console.log(`⏱️ [Cam${camIdx}] Timeout waiting for remote screenshot — restarting preview anyway (overlay will appear once a screenshot lands)`);
            camPuppeteer.off("updated", onUpdated);
            restartForOverlay("Overlay timeout");
          }, 30000);
          camPuppeteer.on("updated", onUpdated);
          // Record how to cancel this switch's pending work if a newer switch arrives.
          _overlaySettleCleanup[camIdx] = () => {
            camPuppeteer.off("updated", onUpdated);
            clearTimeout(fallback);
            if (settleTimer) clearTimeout(settleTimer);
            _overlaySettleCleanup[camIdx] = null;
          };
        }
      }
    } else if (overlayConfig.remoteOverlayEnabled === false && camPuppeteer) {
      console.log(`🛑 [Cam${camIdx}] Remote overlay disabled — shutting down Puppeteer...`);
      await camPuppeteer.stop();
      if (camIdx === 2) puppeteerOverlay2 = null;
      else puppeteerOverlay = null;
    }

    // Broadcast state and write JSON (never render local scoreboard HTML)
    io.emit("scoreUpdated", gameState);
    try {
      const fs = require('fs');
      fs.writeFileSync('/tmp/graphics-overlay-state.json', JSON.stringify(gameState, null, 2));
    } catch (err) { /* ignore */ }

    // Debounced idle preview restart when overlay changes (per camera)
    if (!sc.isStreaming && !wantsRemote) {
      if (camIdx === 2) {
        clearTimeout(idlePreviewRestartTimer2);
        idlePreviewRestartTimer2 = setTimeout(async () => {
          await startPersistentIdlePreview(2);
          io.emit("refreshIdlePreview", { cameraIndex: 2 });
        }, 800);
      } else {
        clearTimeout(idlePreviewRestartTimer);
        idlePreviewRestartTimer = setTimeout(async () => {
          console.log(`📋 Debounce fired — restarting idle preview with updated overlay settings`);
          await startPersistentIdlePreview(1);
          io.emit("refreshIdlePreview", { cameraIndex: 1 });
        }, 800);
      }
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

// ── HTTPS captive portal server (port 3443) ───────────────────────────────
// iOS 14+ probes https://captive.apple.com/hotspot-detect.html (port 443)
// in addition to the HTTP probe.  iptables redirects port 443 → 3443.
// iOS captive portal probes intentionally skip TLS cert validation, so a
// self-signed cert is sufficient.
// Generate the cert once on the device:
//   sudo mkdir -p /etc/ssl/digitalpool
//   sudo openssl req -x509 -newkey rsa:2048 \
//     -keyout /etc/ssl/digitalpool/key.pem \
//     -out    /etc/ssl/digitalpool/cert.pem \
//     -days 3650 -nodes -subj '/CN=captive.apple.com'
(function startHttpsCaptivePortal() {
  const HTTPS_PORT  = 3443;
  const KEY_PATH    = '/etc/ssl/digitalpool/key.pem';
  const CERT_PATH   = '/etc/ssl/digitalpool/cert.pem';
  try {
    const httpsOptions = {
      key:  fsSync.readFileSync(KEY_PATH),
      cert: fsSync.readFileSync(CERT_PATH),
    };
    require('https').createServer(httpsOptions, app).listen(HTTPS_PORT, () => {
      console.log(`🔒 HTTPS captive portal listening on port ${HTTPS_PORT} (iOS 14+ port-443 probes)`);
    });
  } catch (e) {
    console.warn(`⚠️  HTTPS captive portal not started — cert missing at ${CERT_PATH}`);
    console.warn(`   Generate it with: sudo openssl req -x509 -newkey rsa:2048 -keyout ${KEY_PATH} -out ${CERT_PATH} -days 3650 -nodes -subj '/CN=captive.apple.com'`);
  }
})();

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
      // Match both the legacy gst-launch idle preview and the current
      // python3 gst-idle-preview.py runner so a stale one from a crashed prior
      // run can't keep holding the camera / NDI source / preview port.
      const gstProcesses = execSync('pgrep -f "gst-launch|gst-idle-preview"', {
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

  // If Camera 1 is intentionally cleared ("No Camera"), leave the device released:
  // skip stream init (auto-start would grab the default device).  Idle preview and
  // activation are already no-ops for a "none" source.
  const cam1Empty = activeCameraSource.type === "none";
  if (cam1Empty) console.log('📷 [Cam1] Saved source is "No Camera" — slot left empty, device released');

  // Step 1 — Detect format so the idle preview (and any auto-start stream)
  // use the right pipeline from the very first frame.
  console.log("\n🚀 Activating camera and detecting capture format...");
  try {
    await camera.activateCamera();
    cameraFormat = await camera.detectCaptureFormat(CAMERA_DEVICE);
    streamController.captureFormat = cameraFormat;
    console.log(`📹 Camera capture format detected: ${cameraFormat.toUpperCase()}`);
  } catch (error) {
    console.error("❌ Error detecting camera format:", error.message);
    cameraFormat = "mjpeg"; // safe fallback
    streamController.captureFormat = cameraFormat;
  }

  // Step 2 — Start the idle preview BEFORE initialize() so the camera has
  // time to fully initialize its v4l2 driver state.  Some USB cameras
  // (e.g. Minrray) return EBUSY from VIDIOC_S_FMT for a few seconds after
  // first power-on.  Running the idle preview for ~3 s warms the camera up
  // so that when autoStart kills the preview and opens a stream, the driver
  // is ready and VIDIOC_S_FMT succeeds on the first attempt.
  console.log("📹 Starting idle preview for camera warm-up...");
  try {
    await startPersistentIdlePreview(1);
    console.log("✅ Idle preview started — camera is active");
  } catch (error) {
    console.error("❌ Error starting idle preview:", error.message);
  }

  // Step 3 — Wait for the idle preview to be stable before autoStart fires.
  // 3 s is enough for the camera firmware to settle into streaming mode.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Step 4 — Initialize stream controller (auto-start if configured).
  // At this point the camera has been streaming for ~3 s so VIDIOC_S_FMT
  // will succeed immediately after _killCameraProcesses() releases the device.
  if (!cam1Empty) {
    try {
      await streamController.initialize();
    } catch (error) {
      console.error("❌ Error initializing stream controller:", error.message);
    }
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

  // ── Camera 2 boot sequence (async — does not block Camera 1) ───────────────
  // Runs in the background after Camera 1 is live so the admin UI is
  // immediately responsive even if Camera 2 is slow to enumerate.
  (async () => {
    try {
      console.log("\n📹 [Cam2] Starting Camera 2 boot sequence...");

      // Restore saved source for Camera 2.
      if (_savedSource2) {
        streamController2.setInputSource(activeCameraSource2);
        if (activeCameraSource2.type === "usb" && activeCameraSource2.device) {
          camera2.device = activeCameraSource2.device;
        }
      }

      // If Camera 2 is intentionally cleared ("No Camera"), skip the full init
      // sequence so the device stays released for the other slot.
      if (activeCameraSource2.type === "none") {
        console.log('ℹ️  [Cam2] Saved source is "No Camera" — slot left empty, device released.');
        cameraInitialized2 = true;
        return;
      }

      // If Camera 2 is configured as a USB source but the device file does not
      // exist on this machine, skip the full init sequence.  This prevents a
      // flood of "Cannot open device" errors on single-camera setups where the
      // second device (default /dev/video2) is simply not present.
      // Non-USB sources (RTSP, NDI) are network streams and always proceed.
      const cam2UsbDevice = activeCameraSource2.type === "usb"
        ? (activeCameraSource2.device || CAMERA_DEVICE_2)
        : null;
      if (cam2UsbDevice && !fsSync.existsSync(cam2UsbDevice)) {
        console.log(`ℹ️  [Cam2] Device ${cam2UsbDevice} not present — skipping Camera 2 init.`);
        console.log(`ℹ️  [Cam2] Connect a second camera and restart the service to activate Camera 2.`);
        cameraInitialized2 = true;
        return;
      }

      // Activate Camera 2 and discover its real hardware controls (mirrors
      // Camera 1's activateCamera call).  Without this, camera2.discoveredControls
      // stays null and the server falls back to the static OBSBOT-based control
      // map for every Camera 2 query (getCameraConfig, setControl scaling,
      // supportedControls list), giving the UI wrong capabilities and ranges.
      try {
        await camera2.activateCamera();
      } catch (e) {
        console.error("⚠️  [Cam2] Activation failed:", e.message);
      }

      // Detect Camera 2 capture format.
      try {
        cameraFormat2 = await camera2.detectCaptureFormat(camera2.device || CAMERA_DEVICE_2);
        streamController2.captureFormat = cameraFormat2;
        console.log(`📹 [Cam2] Capture format: ${cameraFormat2.toUpperCase()}`);
      } catch (e) {
        console.error("⚠️  [Cam2] Format detection failed:", e.message);
        cameraFormat2 = "mjpeg";
        streamController2.captureFormat = cameraFormat2;
      }

      // Start Camera 2 idle preview.
      try {
        await startPersistentIdlePreview(2);
        console.log("✅ [Cam2] Idle preview started");
        io.emit("refreshIdlePreview", { cameraIndex: 2 });
      } catch (e) {
        console.error("⚠️  [Cam2] Idle preview failed:", e.message);
      }

      // Wait for preview to stabilise, then auto-start Camera 2 stream if configured.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        await streamController2.initialize();
      } catch (e) {
        console.error("❌ [Cam2] Stream controller init failed:", e.message);
      }

      // Apply PTZ config in the background.
      try {
        await camera2.applyConfig();
        const usedStartup2 = await camera2.applyStartupPosition();
        if (usedStartup2) {
          console.log("📌 [Cam2] Applied startup position");
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await camera2.syncPosition();
        cameraInitialized2 = true;
        console.log("✅ [Cam2] Camera 2 initialized successfully\n");
      } catch (e) {
        console.error("❌ [Cam2] Camera init error:", e.message);
        cameraInitialized2 = true; // allow commands even if PTZ init failed
      }
    } catch (err) {
      console.error("❌ [Cam2] Boot sequence error:", err.message);
      cameraInitialized2 = true;
    }
  })();

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
        await puppeteerOverlay.initialize(PORT, streamController.pngOverlayPath);
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
          await startPersistentIdlePreview(1);
          io.emit("refreshIdlePreview", { cameraIndex: 1 });
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
  proxyUrl(`https://digitalpool.com${req.originalUrl}`, res, req);
});

app.use("/static", (req, res) => {
  proxyUrl(`https://digitalpool.com${req.originalUrl}`, res, req);
});

app.use("/tournaments", (req, res) => {
  proxyUrl(`https://digitalpool.com${req.originalUrl}`, res, req);
});

app.get("/version.json", (req, res) => {
  proxyUrl("https://digitalpool.com/version.json", res, req);
});

app.get("/favicon.ico", (req, res) => {
  proxyUrl("https://digitalpool.com/favicon.ico", res, req);
});

app.use("/graphql", (req, res) => {
  proxyUrl("https://api-prod.digitalpool.com/v1/graphql", res, req);
});

// ============================================================================
// Graphics Overlay Integration
// ============================================================================

// Helper: kill idle preview for a given camera before streaming starts
async function _killIdlePreviewForCamera(camIdx) {
  const proc = camIdx === 2 ? currentIdlePreviewProcess2 : currentIdlePreviewProcess;
  if (proc && !proc.killed) {
    console.log(`🛑 [Cam${camIdx}] Killing idle preview before starting stream...`);
    const dyingProcess = proc;
    if (camIdx === 2) currentIdlePreviewProcess2 = null; else currentIdlePreviewProcess = null;
    await new Promise((resolve) => {
      dyingProcess.once("close", resolve);
      dyingProcess.kill("SIGTERM");
      setTimeout(() => { try { dyingProcess.kill("SIGKILL"); } catch (_) {} }, 2000);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // Force-kill any orphan processes still holding the camera device.
  // The tracked process reference can be null if the idle preview died on its own
  // (e.g. VA-API contention, quick exit) but a stale gst-launch or python3 child
  // still has the V4L2 fd open.  fuser -k ensures the device is free before GStreamer
  // tries to open it, preventing the "Device or resource busy" VIDIOC_S_FMT error.
  const activeSource = getActiveSource(camIdx);
  if (activeSource.type === "usb") {
    const dev = activeSource.device || (camIdx === 2 ? CAMERA_DEVICE_2 : CAMERA_DEVICE);
    try {
      execSync(`fuser -k "${dev}" 2>/dev/null || true`);
      console.log(`🔓 [Cam${camIdx}] fuser -k ${dev} complete`);
      // Brief wait for the kernel to fully release the V4L2 device fd
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (_) { /* fuser not installed or device already free — ignore */ }
  }
  console.log(`✅ [Cam${camIdx}] Idle preview killed — camera device free`);
}

// Start Puppeteer overlay BEFORE GStreamer starts (during "preparing" phase)
// This ensures the PNG file exists when gdkpixbufoverlay tries to load it
streamController.on("preparing", async () => {
  try {
    isRestartInProgress[1] = true;
    // Tell cam1's audio cleanup to spare cam2's active ffmpeg PID (if any).
    // This is set synchronously (before any await) so it is guaranteed to be
    // visible when _killAudioDeviceProcesses() runs after the 1500ms wait.
    streamController.protectedAudioPid = streamController2.ffmpegProcess?.pid ?? null;
    await _killIdlePreviewForCamera(1);

    const hasUrlOverlay = streamController.streamConfig.remoteOverlayEnabled &&
      streamController.streamConfig.overlayUrl && streamController.streamConfig.overlayUrl.trim();
    const needsGraphicsOverlay = streamController.streamConfig.skiaGraphicsEnabled || hasUrlOverlay;

    if (needsGraphicsOverlay) {
      console.log(`🎨 [Cam1] Preparing overlay (HTML → PNG)...`);
      const pngPath = streamController.pngOverlayPath;
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
        if (!puppeteerOverlay) puppeteerOverlay = new PuppeteerOverlay();
        if (!puppeteerOverlay.isRunning) await puppeteerOverlay.initialize(PORT, streamController.pngOverlayPath);
        const overlayUrl = streamController.streamConfig.overlayUrl;
        if (overlayUrl && overlayUrl.trim()) {
          const overlayZoom = streamController.streamConfig.overlayZoom || 100;
          console.log(`🌍 [Cam1] Using remote overlay URL: ${overlayUrl} (zoom: ${overlayZoom}%)`);
          puppeteerOverlay.setOverlayUrl(overlayUrl, { zoom: overlayZoom });
          puppeteerOverlay.startPeriodicRefresh();
        }
        console.log("✅ [Cam1] Overlay PNG ready for GStreamer");
      } catch (err) {
        console.error("❌ [Cam1] Failed to prepare overlay:", err.message);
      }
    }
  } catch (err) {
    console.error("⚠️  Error in stream 'preparing' handler [Cam1] — service continuing:", err.message);
  }
});

// Camera 2 "preparing" handler — mirrors Camera 1's handler
streamController2.on("preparing", async () => {
  try {
    isRestartInProgress[2] = true;
    // Tell cam2's audio cleanup to spare cam1's active ffmpeg PID (if any).
    streamController2.protectedAudioPid = streamController.ffmpegProcess?.pid ?? null;
    await _killIdlePreviewForCamera(2);

    const hasUrlOverlay = streamController2.streamConfig.remoteOverlayEnabled &&
      streamController2.streamConfig.overlayUrl && streamController2.streamConfig.overlayUrl.trim();
    const needsGraphicsOverlay = streamController2.streamConfig.skiaGraphicsEnabled || hasUrlOverlay;

    if (needsGraphicsOverlay) {
      console.log(`🎨 [Cam2] Preparing overlay (HTML → PNG)...`);
      const pngPath = streamController2.pngOverlayPath;
      const pngMissing = !fsSync.existsSync(pngPath) || fsSync.statSync(pngPath).size < 100;
      if (pngMissing) {
        try {
          const { execSync } = require("child_process");
          execSync(`convert -size 1920x1080 xc:transparent "${pngPath}"`, { timeout: 5000 });
          console.log(`🖼️  [Cam2] Placeholder transparent PNG created at ${pngPath}`);
        } catch (e) {
          console.error("⚠️  [Cam2] Could not create placeholder PNG:", e.message);
        }
      }
      try {
        if (!puppeteerOverlay2) puppeteerOverlay2 = new PuppeteerOverlay();
        if (!puppeteerOverlay2.isRunning) await puppeteerOverlay2.initialize(PORT, pngPath);
        const overlayUrl = streamController2.streamConfig.overlayUrl;
        if (overlayUrl && overlayUrl.trim()) {
          const overlayZoom = streamController2.streamConfig.overlayZoom || 100;
          console.log(`🌍 [Cam2] Using remote overlay URL: ${overlayUrl} (zoom: ${overlayZoom}%)`);
          puppeteerOverlay2.setOverlayUrl(overlayUrl, { zoom: overlayZoom });
          puppeteerOverlay2.startPeriodicRefresh();
        }
        console.log("✅ [Cam2] Overlay PNG ready for GStreamer");
      } catch (err) {
        console.error("❌ [Cam2] Failed to prepare overlay:", err.message);
      }
    } else {
      console.log(`✅ [Cam2] Ready for streaming`);
    }
  } catch (err) {
    console.error("⚠️  Error in stream 'preparing' handler [Cam2] — service continuing:", err.message);
  }
});

// Helper: restart idle preview after stream stops (shared by both cameras)
async function _handleStreamStopped(camIdx) {
  const sc = getSC(camIdx);
  const activeSource = getActiveSource(camIdx);
  const previewPathName = sc.previewPath.replace(/^\//, "");

  const hasRemote = sc.streamConfig.remoteOverlayEnabled &&
    sc.streamConfig.overlayUrl && sc.streamConfig.overlayUrl.trim();
  const camPuppeteer = camIdx === 2 ? puppeteerOverlay2 : puppeteerOverlay;
  if (camPuppeteer && !hasRemote) {
    camPuppeteer._stopPeriodicRefresh();
    console.log(`ℹ️  [Cam${camIdx}] Stream stopped, no remote overlay — pausing refresh`);
  } else if (camPuppeteer && hasRemote) {
    console.log(`ℹ️  [Cam${camIdx}] Stream stopped, remote overlay active — keeping refresh`);
  }

  console.log(`📹 [Cam${camIdx}] Stream stopped — restarting persistent idle preview...`);
  // USB cameras need 3500ms: stopStream() calls _killCameraProcesses() ~2000ms after
  // the GStreamer close event fires _handleStreamStopped(). Without enough delay the
  // idle preview starts and is immediately killed by the cleanup sequence.
  const releaseDelay = (activeSource.type === "rtsp" || activeSource.type === "rtmp" || activeSource.type === "ndi") ? 2500 : 3500;
  console.log(`⏳ [Cam${camIdx}] Waiting ${releaseDelay}ms for source to release (${activeSource.type})...`);
  await new Promise((resolve) => setTimeout(resolve, releaseDelay));
  await startPersistentIdlePreview(camIdx);

  const idleTimeoutMs = (activeSource.type === "rtsp" || activeSource.type === "rtmp" || activeSource.type === "ndi") ? 12000 : 5000;
  const idleReady = await waitForRtmpPublisher(previewPathName, idleTimeoutMs);
  if (!idleReady) {
    console.warn(`⚠️  [Cam${camIdx}] Idle preview RTMP publisher not ready after ${idleTimeoutMs / 1000}s — clients will retry`);
  }
  io.emit("refreshIdlePreview", { cameraIndex: camIdx });
}

// When stream stops, restart the persistent idle preview and manage Puppeteer refresh
streamController.on("stopped", async () => {
  try {
    if (isRestartInProgress[1]) {
      console.log("🔄 [Cam1] Restart in progress — skipping idle preview restart");
      return;
    }
    await _handleStreamStopped(1);
  } catch (err) {
    console.error("⚠️  Error in stream 'stopped' handler [Cam1] — service continuing:", err.message);
    try { io.emit("refreshIdlePreview", { cameraIndex: 1 }); } catch (_) {}
  }
});

// Camera 2 "stopped" handler
streamController2.on("stopped", async () => {
  try {
    if (isRestartInProgress[2]) {
      console.log("🔄 [Cam2] Restart in progress — skipping idle preview restart");
      return;
    }
    await _handleStreamStopped(2);
  } catch (err) {
    console.error("⚠️  Error in stream 'stopped' handler [Cam2] — service continuing:", err.message);
    try { io.emit("refreshIdlePreview", { cameraIndex: 2 }); } catch (_) {}
  }
});


// ── System stats polling ─────────────────────────────────────────────────────
// Reads CPU temperature (x86_pkg_temp zone), RAM, and Intel RAPL package power.
// All reads use synchronous fs on /sys and /proc — no child_process overhead.
// Broadcasts "systemStats" via Socket.IO every 3 seconds to all connected clients.
{
  const _statsOs = require("os");
  const _statsFs = require("fs");
  const RAPL_ENERGY_PATH = "/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj";

  // Find the thermal zone of type "x86_pkg_temp" once at startup and cache it.
  let _cpuThermalPath = null;
  function _findCpuThermalPath() {
    if (_cpuThermalPath) return _cpuThermalPath;
    try {
      const thermalDir = "/sys/class/thermal";
      const zones = _statsFs.readdirSync(thermalDir).filter(d => /^thermal_zone\d+$/.test(d));
      for (const zone of zones) {
        try {
          const type = _statsFs.readFileSync(`${thermalDir}/${zone}/type`, "utf8").trim();
          if (type === "x86_pkg_temp") {
            _cpuThermalPath = `${thermalDir}/${zone}/temp`;
            console.log(`🌡️  System stats: CPU thermal zone = ${zone} (${type})`);
            return _cpuThermalPath;
          }
        } catch (_) {}
      }
    } catch (_) {}
    _cpuThermalPath = "/sys/class/thermal/thermal_zone0/temp"; // fallback
    return _cpuThermalPath;
  }

  // Retain previous RAPL energy reading so we can compute Watts = ΔEnergy / ΔTime.
  let _raplPrevUj   = null;
  let _raplPrevTime = null;

  // eslint-disable-next-line no-inner-declarations
  function _readSystemStats() {
    // CPU temperature (millidegrees → °C)
    let cpuTempC = null;
    try {
      cpuTempC = Math.round(
        parseInt(_statsFs.readFileSync(_findCpuThermalPath(), "utf8").trim(), 10) / 1000
      );
    } catch (_) {}

    // RAM (bytes → GB, 1 decimal place)
    const total = _statsOs.totalmem();
    const free  = _statsOs.freemem();
    const ramUsedGb  = parseFloat(((total - free) / 1_073_741_824).toFixed(1));
    const ramTotalGb = parseFloat((total            / 1_073_741_824).toFixed(1));

    // RAPL power (µJ counter delta → Watts)
    let powerW = null;
    try {
      const uj  = parseInt(_statsFs.readFileSync(RAPL_ENERGY_PATH, "utf8").trim(), 10);
      const now = Date.now();
      if (_raplPrevUj !== null && uj >= _raplPrevUj) {
        const deltaSec = (now - _raplPrevTime) / 1000;
        powerW = Math.round((uj - _raplPrevUj) / 1_000_000 / deltaSec);
      }
      _raplPrevUj   = uj;
      _raplPrevTime = now;
    } catch (_) {}

    return { cpuTempC, ramUsedGb, ramTotalGb, powerW };
  }

  // Make _readSystemStats available to the /api/system/stats REST endpoint above.
  global._readSystemStats = _readSystemStats;

  // Prime RAPL state now; first broadcast (3 s later) will have a valid power figure.
  _readSystemStats();
  setInterval(() => { io.emit("systemStats", _readSystemStats()); }, 3000);
}

// ── Global error safety net ───────────────────────────────────────────────
// In Node.js v15+ an unhandled Promise rejection crashes the process.
// Async event handlers (e.g. streamController.on("stopped", async () => {...}))
// can throw even when they have inner try-catches — wrapping each one is
// defence-in-depth, but this global handler is the last resort so a single
// async exception can never take down the whole service.
process.on("unhandledRejection", (reason) => {
  console.error("⚠️  Unhandled Promise Rejection (service continuing):",
    reason?.stack || reason?.message || reason);
  // Do NOT call process.exit() — let systemd restart only on true crashes.
});

process.on("uncaughtException", (err) => {
  console.error("⚠️  Uncaught Exception (service continuing):", err.stack || err.message);
  // Do NOT exit — the watchdog will restart if the service truly hangs.
});

// Graceful shutdown — kill all child processes and exit within a hard deadline.
//
// systemd sends SIGTERM, waits TimeoutStopSec, then SIGKILLs everything.
// We must exit() before that deadline.  The strategy:
//   1. SIGKILL idle preview GStreamer children synchronously (they are the
//      heaviest processes and don't need graceful teardown).
//   2. Ask Puppeteer/Chrome to close gracefully (best-effort, 3 s budget).
//   3. pkill any surviving Chrome processes as a nuclear fallback.
//   4. Hard deadline: force process.exit(0) after 7 s regardless of what
//      async operations are still pending.  TimeoutStopSec=10 in the service
//      file gives us a 3 s margin before systemd's SIGKILL.
async function _gracefulShutdown() {
  console.log("🛑 Shutting down — killing child processes...");

  // ── Step 1: kill idle preview GStreamer processes immediately ──
  // These are gst-launch-1.0 children spawned by startPersistentIdlePreview().
  // They hold V4L2 and RTMP resources and must die before the process exits.
  for (const proc of [currentIdlePreviewProcess, currentIdlePreviewProcess2]) {
    if (proc && !proc.killed) {
      try { process.kill(-proc.pid, "SIGKILL"); } catch (_) {}  // process group
      try { proc.kill("SIGKILL"); }               catch (_) {}  // direct
    }
  }

  // ── Step 2: stop Puppeteer browsers (best-effort, capped at 3 s) ──
  try {
    await Promise.race([
      (async () => {
        if (puppeteerOverlay)  await puppeteerOverlay.stop();
        if (puppeteerOverlay2) await puppeteerOverlay2.stop();
      })(),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch (_) { /* ignore — we're shutting down */ }

  // ── Step 3: nuclear pkill for any surviving Chrome/Chromium children ──
  try {
    execSync(
      'pkill -SIGKILL -f "chromium-browser/chrome" 2>/dev/null; ' +
      'pkill -SIGKILL -f chromium 2>/dev/null; true',
      { shell: true, timeout: 2000 }
    );
  } catch (_) { /* pkill not found or no processes */ }

  console.log("✅ Shutdown complete");
  process.exit(0);
}

// Hard deadline: if _gracefulShutdown() somehow hangs past 7 s, exit anyway.
// TimeoutStopSec=10 in the service file gives us a 3 s buffer before systemd
// SIGKILLs the entire cgroup.
function _startShutdown() {
  setTimeout(() => {
    console.error("⚠️  Shutdown deadline exceeded — forcing exit");
    process.exit(1);
  }, 7000).unref();   // .unref() so the timer doesn't prevent a clean exit
  _gracefulShutdown().catch(() => process.exit(1));
}

process.on("SIGINT",  _startShutdown);
process.on("SIGTERM", _startShutdown);