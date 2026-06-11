const EventEmitter = require("events");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const puppeteer = require("puppeteer-core");

/**
 * HTML Overlay Generator
 * - Local mode: uses wkhtmltoimage + ImageMagick chroma-key for local HTML scoreboard
 * - URL mode: uses Puppeteer (headless Chromium) to screenshot remote pages with
 *   native transparency (omitBackground: true), supporting modern JS frameworks (React, etc.)
 * The PNG is saved to disk for GStreamer's gdkpixbufoverlay to composite onto the video stream.
 */
class PuppeteerOverlay extends EventEmitter {
  constructor() {
    super();
    this.pngPath = "/tmp/graphics-overlay.png";
    this.rawPngPath = "/tmp/overlay-raw.png";
    this.tempHtmlPath = "/tmp/overlay-render.html";
    this.isRunning = false;
    this.width = 1920;
    this.height = 1080;
    this._renderInProgress = false;
    this._templateHtml = null;
    // URL mode
    this._overlayUrl = null;        // Remote URL to screenshot (null = local HTML mode)
    this._refreshTimer = null;      // Periodic refresh timer for URL mode
    this._refreshIntervalMs = 2000; // How often to re-screenshot the URL (ms)
    this._jsDelay = 2000;           // Time to wait for JS execution before screenshot (ms)
    this._zoom = 100;               // CSS zoom level for overlay page (50-200%)
    // Puppeteer browser instance (reused across screenshots)
    this._browser = null;
    this._page = null;
    // Periodic browser restart — Chromium accumulates memory over long sessions
    // (V8 heap fragmentation, renderer-side caches). Closing and relaunching
    // every hour resets that growth. The overlay is dark for ~2-3 s during restart.
    this._browserRestartIntervalMs = 60 * 60 * 1000; // 1 hour
    this._browserRestartTimer = null;
  }

  /**
   * Initialize the overlay renderer.
   * Loads the HTML template and verifies wkhtmltoimage + convert are available.
   * @param {number} serverPort - unused (kept for API compatibility)
   * @param {string} pngPath - Path to write the final transparent PNG
   */
  async initialize(serverPort = 3000, pngPath = "/tmp/graphics-overlay.png") {
    this.pngPath = pngPath;

    console.log("🌐 Initializing overlay renderer...");

    // Create a placeholder PNG only if one doesn't already exist (or is too small).
    // This prevents overwriting a valid overlay PNG from a previous session during boot.
    try {
      const existingSize = fs.existsSync(this.pngPath) ? fs.statSync(this.pngPath).size : 0;
      if (existingSize <= 100) {
        this._createPlaceholderPNG(this.pngPath);
      } else {
        console.log(`📋 Keeping existing overlay PNG (${existingSize} bytes)`);
      }
    } catch (e) {
      this._createPlaceholderPNG(this.pngPath);
    }

    try {
      // Try to load local HTML template (for local overlay mode)
      const templatePath = path.join(__dirname, "public", "overlay.html");
      if (fs.existsSync(templatePath)) {
        this._templateHtml = fs.readFileSync(templatePath, "utf8");
        console.log("  ✅ Overlay HTML template loaded");
      }

      // Check for wkhtmltoimage (optional — only needed for local mode)
      try {
        await this._execPromise("which", ["wkhtmltoimage"]);
        console.log("  ✅ wkhtmltoimage found (local overlay mode available)");
      } catch (e) {
        console.log("  ℹ️  wkhtmltoimage not found (URL overlay mode only)");
      }

      this.isRunning = true;

      console.log("✅ Overlay renderer ready");
      console.log(`  📐 Output size: ${this.width}x${this.height}`);
      console.log(`  📁 PNG output: ${this.pngPath}`);

      this.emit("ready");
    } catch (err) {
      console.error("❌ Failed to initialize overlay renderer:", err.message);
      // Placeholder already created above
      this.isRunning = true; // Still mark as running so URL mode can work
      this.emit("ready");
    }
  }

  /**
   * Set a remote URL as the overlay source.
   * When set, the overlay will periodically screenshot this URL instead of
   * generating HTML from local game state. The remote page is expected to
   * use its own JavaScript to fetch and display scores.
   * @param {string} url - The URL to screenshot (null/empty to disable URL mode)
   * @param {object} options - Optional settings
   * @param {number} options.refreshInterval - How often to re-screenshot (ms, default 3000)
   * @param {number} options.jsDelay - Time to wait for JS execution before screenshot (ms, default 2000)
   */
  setOverlayUrl(url, options = {}) {
    if (url && url.trim()) {
      this._overlayUrl = url.trim();
      if (options.refreshInterval) this._refreshIntervalMs = options.refreshInterval;
      if (options.jsDelay) this._jsDelay = options.jsDelay;
      if (options.zoom && options.zoom !== this._zoom) {
        this._zoom = options.zoom;
        this._zoomDirty = true; // Flag to re-apply zoom on next screenshot cycle
      }
      console.log(`🌍 Overlay URL mode enabled: ${this._overlayUrl}`);
      console.log(`   Refresh interval: ${this._refreshIntervalMs}ms, JS delay: ${this._jsDelay}ms, zoom: ${this._zoom}%`);
    } else {
      this._overlayUrl = null;
      this._stopPeriodicRefresh();
      this._closeBrowser(); // Clean up Chromium when disabling URL mode
      // Replace the last URL screenshot with a transparent placeholder
      // so GStreamer doesn't keep showing the old (possibly white) image
      this._createPlaceholderPNG(this.pngPath);
      console.log("📄 Overlay switched to local HTML mode (cleared old overlay)");
    }
  }

  /**
   * Start periodic refresh for URL mode.
   * Screenshots the remote URL at the configured interval.
   */
  startPeriodicRefresh() {
    if (!this._overlayUrl) {
      console.warn("⚠️  Cannot start periodic refresh: no overlay URL set");
      return;
    }

    this._stopPeriodicRefresh(); // Clear any existing timer

    console.log(`🔄 Starting periodic overlay refresh every ${this._refreshIntervalMs}ms`);

    // Use recursive setTimeout instead of setInterval.
    // This ensures the next cycle only starts AFTER the current render completes,
    // preventing timer overlap when renders take longer than the interval.
    this._refreshActive = true;
    const scheduleNext = () => {
      if (!this._refreshActive) return;
      this._refreshTimer = setTimeout(async () => {
        if (!this._refreshActive) return;
        await this._renderUrlOverlay();
        scheduleNext();
      }, this._refreshIntervalMs);
    };

    // Do an immediate first render, then start the cycle
    this._renderUrlOverlay().then(() => scheduleNext());

    // Schedule periodic browser restarts to keep Chromium memory bounded.
    this._scheduleBrowserRestart();
  }

  /**
   * Stop periodic refresh and cancel the browser-restart timer.
   */
  _stopPeriodicRefresh() {
    this._refreshActive = false;
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
      console.log("⏹️  Periodic overlay refresh stopped");
    }
    if (this._browserRestartTimer) {
      clearTimeout(this._browserRestartTimer);
      this._browserRestartTimer = null;
    }
  }

  /**
   * Schedule a one-shot timer to close and relaunch Chromium after
   * _browserRestartIntervalMs.  The next _renderUrlOverlay() call will
   * reopen the browser via _ensureBrowser() automatically.
   * Called recursively so restarts keep happening every interval.
   */
  _scheduleBrowserRestart() {
    if (this._browserRestartTimer) clearTimeout(this._browserRestartTimer);
    this._browserRestartTimer = setTimeout(async () => {
      const intervalMin = Math.round(this._browserRestartIntervalMs / 60000);
      console.log(`🔄 Scheduled Chromium restart (every ${intervalMin} min) — closing browser to reset memory…`);
      await this._closeBrowser();
      // _ensureBrowser() relaunches automatically on the next render cycle.
      // Reschedule so restarts continue at the same interval.
      this._scheduleBrowserRestart();
    }, this._browserRestartIntervalMs);
  }

  /**
   * Update the overlay with new game state.
   * In local mode: generates HTML with state baked in, renders with wkhtmltoimage.
   * In URL mode: this is a no-op since the periodic refresh handles rendering.
   * @param {object} gameState - The current game state
   */
  async updateState(gameState) {
    if (!this.isRunning) {
      console.warn("⚠️  Overlay renderer not initialized, skipping update");
      return;
    }

    // In URL mode, the page fetches its own data — periodic refresh handles it
    if (this._overlayUrl) {
      console.log("🌍 URL mode active — overlay updates via periodic refresh");
      return;
    }

    // Local mode: render HTML with baked-in game state
    await this._renderLocalOverlay(gameState);
  }

  /**
   * Render local overlay — writes a transparent placeholder.
   * (Local scoreboard HTML has been removed; only remote URL overlay is supported.)
   */
  async _renderLocalOverlay(gameState) {
    console.log("📄 Local overlay mode: writing transparent placeholder (no local scoreboard)");
    this._createPlaceholderPNG(this.pngPath);
    this.emit("updated", this.pngPath);
  }

  /**
   * Launch (or reuse) headless Chromium via Puppeteer for URL overlay rendering.
   * The browser stays alive between screenshots for efficiency.
   */
  _findChromiumPath() {
    const { execSync } = require("child_process");
    const candidates = [
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/snap/bin/chromium",
      "/usr/bin/google-chrome-stable",
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) return p;
      } catch (e) { /* skip */ }
    }
    // Fall back to `which`
    try {
      return execSync("which chromium-browser || which chromium", { encoding: "utf-8" }).trim();
    } catch (e) {
      return "/usr/bin/chromium-browser"; // best guess
    }
  }

  async _ensureBrowser() {
    // If we already have a working browser + page, reuse it
    // NOTE: Puppeteer 20.x uses isConnected() method, NOT .connected property
    if (this._browser && this._browser.isConnected() && this._page) return;

    // Clean up any leftover browser before launching a new one
    await this._closeBrowser();

    const chromiumPath = this._findChromiumPath();
    console.log(`🚀 Launching headless Chromium for URL overlay (${chromiumPath})...`);
    // Minimal flags only — proven stable on ARM64 with Chromium 114 + puppeteer-core 20.9
    // pipe:false → use WebSocket transport instead of stdio pipes.
    // Pipes can be disrupted when the Node process has many child processes
    // (GStreamer, ImageMagick) competing for stdio resources.
    this._browser = await puppeteer.launch({
      executablePath: chromiumPath,
      headless: true,
      pipe: false,
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--disable-extensions",
        "--disable-sync",
        "--disable-translate",
        "--metrics-recording-only",
        "--no-first-run",
        // Disable Chromium's audio backend entirely — this process is screenshot-only
        // and has no need for audio. Without these flags, Chromium opens the ALSA
        // capture device (plughw:1,0) on startup when PulseAudio is not running,
        // preventing GStreamer's alsasrc from opening the same device.
        "--mute-audio",
        "--disable-audio-output",
        // Limit to one renderer process — prevents orphaned renderers from
        // accumulating after failed navigations (two renderers were observed
        // consuming ~256 MB when only one page is open).
        "--renderer-process-limit=1",
        // Cap V8's old-generation heap inside the renderer at 128 MB.
        // The overlay page is a simple React/WebSocket app; it does not need
        // a large heap, and this prevents V8's GC from retaining stale objects
        // indefinitely during a long-running session.
        "--js-flags=--max-old-space-size=128",
      ],
    });

    // Track disconnection — silently clean up refs so _ensureBrowser relaunches.
    this._browserIntentionalClose = false;
    this._browser.on("disconnected", () => {
      if (!this._browserIntentionalClose) {
        console.log("🔄 Chromium disconnected — will relaunch on next overlay cycle");
      }
      this._browser = null;
      this._page = null;
      this._currentLoadedUrl = null;
    });

    this._page = await this._browser.newPage();
    await this._page.setViewport({ width: this.width, height: this.height });
    this._currentLoadedUrl = null; // Track what URL is loaded
    console.log("  ✅ Chromium browser ready");
  }

  /**
   * Close the Puppeteer browser instance and kill any orphan processes.
   */
  async _closeBrowser() {
    const pid = this._browser && this._browser.process && this._browser.process()
      ? this._browser.process().pid : null;

    // Mark intentional close so the disconnected handler doesn't log
    this._browserIntentionalClose = true;

    if (this._page) {
      try { await this._page.close(); } catch (e) { /* ignore */ }
      this._page = null;
    }
    if (this._browser) {
      try { await this._browser.close(); } catch (e) { /* ignore */ }
      this._browser = null;
      console.log("🛑 Chromium browser closed");
    }
    this._currentLoadedUrl = null;

    // Safety: kill the process if close() didn't work
    if (pid) {
      try { process.kill(pid, "SIGKILL"); } catch (e) { /* already dead */ }
    }
  }

  /**
   * Render a remote URL overlay using Puppeteer (persistent headless Chromium).
   * The browser stays alive between screenshots. The overlay page maintains its
   * own WebSocket/subscription for real-time score updates — we just screenshot
   * the current page state periodically. No reload, no re-navigation.
   */
  async _renderUrlOverlay() {
    if (this._renderInProgress) {
      return; // Skip this cycle, next interval will try again
    }
    if (!this._overlayUrl) return;

    this._renderInProgress = true;
    try {
      await this._ensureBrowser();

      // First load only: navigate to the URL and wait for JS/React to render.
      // After that, NEVER reload — the page updates itself via subscriptions.
      if (this._currentLoadedUrl !== this._overlayUrl) {
        console.log(`🌍 Navigating to overlay URL: ${this._overlayUrl}`);
        // Use "domcontentloaded" instead of "networkidle0" — overlay pages often have
        // persistent WebSocket / polling connections that prevent networkidle0 from
        // ever firing, causing a silent 30-second timeout.
        await this._page.goto(this._overlayUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        this._currentLoadedUrl = this._overlayUrl;
        this._zoomDirty = true; // Always apply zoom after navigation

        // Wait for JS frameworks to finish initial render
        console.log(`⏳ Waiting ${this._jsDelay}ms for JS framework to render...`);
        await new Promise(r => setTimeout(r, this._jsDelay));
      }

      // Apply zoom and transparent background when dirty (after nav or zoom change)
      if (this._zoomDirty) {
        console.log(`🔍 Applying zoom: ${this._zoom}%`);
        await this._page.evaluate((zoom) => {
          document.documentElement.style.backgroundColor = "transparent";
          document.body.style.backgroundColor = "transparent";
          document.body.style.zoom = (zoom / 100).toString();
        }, this._zoom);
        this._zoomDirty = false;
      }

      // Screenshot with native transparency — no ImageMagick chroma-key needed
      const tempPath = this.pngPath + ".tmp";
      await this._page.screenshot({
        path: tempPath,
        type: "png",
        omitBackground: true,
      });
      // Atomic rename so GStreamer never reads a partial file
      fs.renameSync(tempPath, this.pngPath);

      this.emit("updated", this.pngPath);
    } catch (err) {
      // Always log — silently swallowing errors makes debugging impossible.
      console.error("❌ Overlay render error:", err.message);
      if (!this._browser || !this._browser.isConnected()) {
        // Browser died — _ensureBrowser will relaunch on the next cycle.
        console.log("🔄 Chromium disconnected — will relaunch on next cycle");
        this._browser = null;
        this._page = null;
        this._currentLoadedUrl = null;
      }
    } finally {
      this._renderInProgress = false;
    }
  }

  /**
   * Stop the overlay renderer and clean up temp files.
   */
  async stop() {
    console.log("🛑 Stopping overlay renderer...");
    this._stopPeriodicRefresh(); // also cancels _browserRestartTimer
    await this._closeBrowser();
    this.isRunning = false;
    // Clean up all temp files including the main overlay PNG
    for (const f of [this.pngPath, this.rawPngPath, this.tempHtmlPath]) {
      try { fs.unlinkSync(f); console.log(`🗑️  Deleted overlay file: ${f}`); } catch (e) { /* ignore */ }
    }
    this.emit("stopped");
  }

  /**
   * Create a placeholder transparent PNG so GStreamer doesn't crash.
   * Builds a valid 1x1 RGBA transparent PNG using raw bytes + zlib.
   */
  _createPlaceholderPNG(pngPath) {
    // PNG signature
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    // Helper: build a PNG chunk (type + data + CRC)
    const makeChunk = (type, data) => {
      const typeBytes = Buffer.from(type, "ascii");
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      const crcInput = Buffer.concat([typeBytes, data]);
      const crc = Buffer.alloc(4);
      crc.writeInt32BE(crc32(crcInput), 0);
      return Buffer.concat([len, typeBytes, data, crc]);
    };

    // CRC32 (PNG uses this for chunk integrity)
    const crc32 = (buf) => {
      let c = 0xffffffff;
      for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let j = 0; j < 8; j++) {
          c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
        }
      }
      return (c ^ 0xffffffff) | 0;
    };

    // IHDR: width=1, height=1, bit depth=8, color type=6 (RGBA)
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(1, 0);  // width
    ihdrData.writeUInt32BE(1, 4);  // height
    ihdrData[8] = 8;   // bit depth
    ihdrData[9] = 6;   // color type (RGBA)
    ihdrData[10] = 0;  // compression
    ihdrData[11] = 0;  // filter
    ihdrData[12] = 0;  // interlace

    // IDAT: raw pixel data = filter byte (0) + RGBA (0,0,0,0)
    const rawData = Buffer.from([0, 0, 0, 0, 0]);
    const compressed = zlib.deflateSync(rawData);

    // IEND: empty
    const iendData = Buffer.alloc(0);

    const png = Buffer.concat([
      signature,
      makeChunk("IHDR", ihdrData),
      makeChunk("IDAT", compressed),
      makeChunk("IEND", iendData),
    ]);

    fs.writeFileSync(pngPath, png);
    console.log(`📝 Created placeholder transparent PNG at ${pngPath}`);
  }

  /**
   * Promise wrapper around execFile
   */
  _execPromise(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      const timeout = opts.timeout || 30000;
      execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${cmd} failed: ${err.message}\n${stderr}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }
}

module.exports = PuppeteerOverlay;

