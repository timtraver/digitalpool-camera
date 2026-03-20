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
    this._refreshIntervalMs = 3000; // How often to re-screenshot the URL (ms)
    this._jsDelay = 2000;           // Time to wait for JS execution before screenshot (ms)
    this._zoom = 100;               // CSS zoom level for overlay page (50-200%)
    // Puppeteer browser instance (reused across screenshots)
    this._browser = null;
    this._page = null;
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

    // Always create a placeholder PNG first so GStreamer can start immediately.
    // The real overlay will replace it once Puppeteer renders the first screenshot.
    this._createPlaceholderPNG(this.pngPath);

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
      this._refreshIntervalMs = options.refreshInterval || 3000;
      this._jsDelay = options.jsDelay || 2000;
      this._zoom = options.zoom || 100;
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

    // Do an immediate first render
    this._renderUrlOverlay();

    // Then set up the interval
    this._refreshTimer = setInterval(() => {
      this._renderUrlOverlay();
    }, this._refreshIntervalMs);
  }

  /**
   * Stop periodic refresh.
   */
  _stopPeriodicRefresh() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
      console.log("⏹️  Periodic overlay refresh stopped");
    }
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
   * Render local HTML overlay with game state baked into the markup.
   */
  async _renderLocalOverlay(gameState) {
    if (this._renderInProgress) {
      console.log("⏳ Render already in progress, skipping");
      return;
    }

    this._renderInProgress = true;
    try {
      // Generate HTML with game state baked in
      const html = this._generateHtml(gameState);
      fs.writeFileSync(this.tempHtmlPath, html);

      // Render HTML to PNG with wkhtmltoimage
      await this._execPromise("wkhtmltoimage", [
        "--width", String(this.width),
        "--height", String(this.height),
        "--quality", "100",
        this.tempHtmlPath,
        this.rawPngPath,
      ]);

      // Use ImageMagick to make green background transparent
      await this._chromaKeyAndSave();

      console.log(`📸 Overlay PNG updated: ${gameState.player1Score} - ${gameState.player2Score}`);
      this.emit("updated", this.pngPath);
    } catch (err) {
      console.error("❌ Failed to update overlay:", err.message);
    } finally {
      this._renderInProgress = false;
    }
  }

  /**
   * Launch (or reuse) headless Chromium via Puppeteer for URL overlay rendering.
   * The browser stays alive between screenshots for efficiency.
   */
  async _ensureBrowser() {
    if (this._browser && this._browser.connected) return;

    console.log("🚀 Launching headless Chromium for URL overlay...");
    this._browser = await puppeteer.launch({
      executablePath: "/snap/bin/chromium",
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-software-rasterizer",
      ],
    });
    this._page = await this._browser.newPage();
    await this._page.setViewport({ width: this.width, height: this.height });
    console.log("  ✅ Chromium browser ready");
  }

  /**
   * Close the Puppeteer browser instance.
   */
  async _closeBrowser() {
    if (this._page) {
      try { await this._page.close(); } catch (e) { /* ignore */ }
      this._page = null;
    }
    if (this._browser) {
      try { await this._browser.close(); } catch (e) { /* ignore */ }
      this._browser = null;
      console.log("🛑 Chromium browser closed");
    }
  }

  /**
   * Render a remote URL overlay using Puppeteer (headless Chromium).
   * Uses waitUntil: 'networkidle0' to wait for React/JS to finish rendering,
   * and omitBackground: true for native alpha transparency — no chroma-key needed.
   */
  async _renderUrlOverlay() {
    if (this._renderInProgress) {
      return; // Skip this cycle, next interval will try again
    }
    if (!this._overlayUrl) return;

    this._renderInProgress = true;
    try {
      await this._ensureBrowser();

      // Navigate to the URL and wait for all network requests to settle.
      // networkidle0 = no network connections for 500ms (React API calls done).
      // On first load this navigates; on subsequent calls it reloads for fresh data.
      await this._page.goto(this._overlayUrl, {
        waitUntil: "networkidle0",
        timeout: 15000,
      });

      // Apply CSS zoom if not 100%
      if (this._zoom !== 100) {
        await this._page.evaluate((zoom) => {
          document.body.style.zoom = (zoom / 100).toString();
        }, this._zoom);
      }

      // Take screenshot with transparent background (no chroma-key needed).
      // omitBackground: true makes the default white page background transparent.
      // Overlay elements with their own CSS backgrounds stay opaque.
      const tempOutput = this.pngPath + ".tmp";
      await this._page.screenshot({
        path: tempOutput,
        type: "png",
        fullPage: false,
        omitBackground: true,
      });

      // Atomic rename so GStreamer doesn't read a half-written file
      fs.renameSync(tempOutput, this.pngPath);

      console.log(`📸 URL overlay PNG updated from: ${this._overlayUrl}`);
      this.emit("updated", this.pngPath);
    } catch (err) {
      console.error("❌ Failed to render URL overlay:", err.message);
      // If the browser crashed, clean it up so next cycle relaunches
      if (this._browser && !this._browser.connected) {
        this._browser = null;
        this._page = null;
      }
    } finally {
      this._renderInProgress = false;
    }
  }

  /**
   * Chroma-key green background to transparent and save atomically.
   */
  async _chromaKeyAndSave() {
    const tempOutput = this.pngPath + ".tmp";
    await this._execPromise("convert", [
      this.rawPngPath,
      "-alpha", "on",
      "-fuzz", "10%",
      "-transparent", "rgb(0,255,0)",
      `PNG32:${tempOutput}`,
    ]);
    fs.renameSync(tempOutput, this.pngPath);
  }

  /**
   * Stop the overlay renderer and clean up temp files.
   */
  async stop() {
    console.log("🛑 Stopping overlay renderer...");
    this._stopPeriodicRefresh();
    await this._closeBrowser();
    this.isRunning = false;
    // Clean up temp files
    for (const f of [this.tempHtmlPath, this.rawPngPath]) {
      try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
    }
    this.emit("stopped");
  }

  /**
   * Generate HTML with game state values baked directly into the markup.
   * This avoids needing JavaScript execution in wkhtmltoimage.
   */
  _generateHtml(gameState) {
    const matchTitle = this._escapeHtml(gameState.matchTitle || "Match");
    const p1Name = this._escapeHtml(gameState.player1Name || "Player 1");
    const p2Name = this._escapeHtml(gameState.player2Name || "Player 2");
    const p1Score = gameState.player1Score ?? 0;
    const p2Score = gameState.player2Score ?? 0;

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${this.width}px;
    height: ${this.height}px;
    background: #00FF00;
    overflow: hidden;
    font-family: 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif;
  }
  #scoreboard {
    position: absolute;
    top: 40px;
    left: 40px;
    background: rgb(20, 20, 20);
    border: 2px solid #cccccc;
    border-radius: 12px;
    padding: 16px 24px;
    color: white;
    min-width: 420px;
  }
  .match-title {
    font-size: 20px;
    font-weight: bold;
    text-align: center;
    margin-bottom: 12px;
    opacity: 0.9;
    letter-spacing: 0.5px;
  }
  .players {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
  }
  .player { flex: 1; text-align: center; }
  .player-name {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 160px;
    margin-left: auto;
    margin-right: auto;
  }
  .player-score {
    font-size: 48px;
    font-weight: bold;
    line-height: 1;
  }
  .vs-divider {
    font-size: 24px;
    font-weight: bold;
    opacity: 0.5;
    padding: 0 4px;
  }
</style>
</head>
<body>
  <div id="scoreboard">
    <div class="match-title">${matchTitle}</div>
    <div class="players">
      <div class="player">
        <div class="player-name">${p1Name}</div>
        <div class="player-score">${p1Score}</div>
      </div>
      <div class="vs-divider">–</div>
      <div class="player">
        <div class="player-name">${p2Name}</div>
        <div class="player-score">${p2Score}</div>
      </div>
    </div>
  </div>
</body>
</html>`;
  }

  _escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
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
  _execPromise(cmd, args) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => {
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

