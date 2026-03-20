const EventEmitter = require("events");
const path = require("path");

/**
 * Puppeteer-based HTML Overlay Generator
 * Uses headless Chromium to render an HTML overlay page and screenshot it as a transparent PNG.
 * The PNG is saved to disk for GStreamer's gdkpixbufoverlay to composite onto the video stream.
 */
class PuppeteerOverlay extends EventEmitter {
  constructor() {
    super();
    this.browser = null;
    this.page = null;
    this.pngPath = "/tmp/graphics-overlay.png";
    this.overlayUrl = null;
    this.isRunning = false;
    this.width = 1920;
    this.height = 1080;
    this._screenshotInProgress = false;
  }

  /**
   * Initialize and launch headless Chromium, navigate to the overlay page.
   * @param {number} serverPort - The Express server port (to load overlay.html)
   * @param {string} pngPath - Path to write the PNG screenshot
   */
  async initialize(serverPort = 3000, pngPath = "/tmp/graphics-overlay.png") {
    this.pngPath = pngPath;
    this.overlayUrl = `http://localhost:${serverPort}/overlay.html`;

    console.log("🌐 Launching headless Chromium for overlay rendering...");

    try {
      // Use puppeteer-core with the system Chromium
      const puppeteer = require("puppeteer-core");

      // Find system Chromium
      const chromiumPath = await this._findChromium();
      if (!chromiumPath) {
        throw new Error("Chromium not found. Install with: sudo apt install chromium-browser");
      }
      console.log(`  📍 Using Chromium: ${chromiumPath}`);

      this.browser = await puppeteer.launch({
        executablePath: chromiumPath,
        headless: "new",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--disable-web-security",
          `--window-size=${this.width},${this.height}`,
        ],
      });

      this.page = await this.browser.newPage();
      await this.page.setViewport({
        width: this.width,
        height: this.height,
        deviceScaleFactor: 1,
      });

      // Navigate to overlay page
      await this.page.goto(this.overlayUrl, { waitUntil: "domcontentloaded" });
      this.isRunning = true;

      console.log("✅ Puppeteer overlay ready");
      console.log(`  📐 Viewport: ${this.width}x${this.height}`);
      console.log(`  📁 PNG output: ${this.pngPath}`);

      this.emit("ready");
    } catch (err) {
      console.error("❌ Failed to initialize Puppeteer overlay:", err.message);
      throw err;
    }
  }

  /**
   * Update the overlay with new game state and take a screenshot.
   * @param {object} gameState - The current game state
   */
  async updateState(gameState) {
    if (!this.isRunning || !this.page) {
      console.warn("⚠️  Puppeteer overlay not running, skipping update");
      return;
    }

    // Prevent concurrent screenshots
    if (this._screenshotInProgress) {
      console.log("⏳ Screenshot already in progress, skipping");
      return;
    }

    this._screenshotInProgress = true;
    try {
      // Inject the game state into the page
      await this.page.evaluate((state) => {
        if (typeof updateState === "function") {
          updateState(state);
        }
      }, gameState);

      // Take a transparent PNG screenshot
      await this.page.screenshot({
        path: this.pngPath,
        type: "png",
        omitBackground: true, // Transparent background
      });

      console.log(`📸 Overlay PNG updated: ${gameState.player1Score} - ${gameState.player2Score}`);
      this.emit("updated", this.pngPath);
    } catch (err) {
      console.error("❌ Failed to update overlay:", err.message);
    } finally {
      this._screenshotInProgress = false;
    }
  }

  /**
   * Stop Puppeteer and close the browser.
   */
  async stop() {
    if (this.browser) {
      console.log("🛑 Closing Puppeteer browser...");
      try {
        await this.browser.close();
      } catch (err) {
        console.error("Error closing browser:", err.message);
      }
      this.browser = null;
      this.page = null;
    }
    this.isRunning = false;
    this.emit("stopped");
  }

  /**
   * Find system Chromium executable
   */
  async _findChromium() {
    const { execSync } = require("child_process");
    const candidates = [
      "chromium-browser",
      "chromium",
      "google-chrome",
      "google-chrome-stable",
    ];

    for (const cmd of candidates) {
      try {
        const result = execSync(`which ${cmd}`, { encoding: "utf8" }).trim();
        if (result) return result;
      } catch (e) {
        // not found, try next
      }
    }
    return null;
  }
}

module.exports = PuppeteerOverlay;

