const EventEmitter = require("events");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * HTML Overlay Generator using wkhtmltoimage + ImageMagick
 * Renders an HTML template to PNG using WebKit (wkhtmltoimage),
 * then uses ImageMagick to chroma-key the green background to transparency.
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
  }

  /**
   * Initialize the overlay renderer.
   * Loads the HTML template and verifies wkhtmltoimage + convert are available.
   * @param {number} serverPort - unused (kept for API compatibility)
   * @param {string} pngPath - Path to write the final transparent PNG
   */
  async initialize(serverPort = 3000, pngPath = "/tmp/graphics-overlay.png") {
    this.pngPath = pngPath;

    console.log("🌐 Initializing HTML overlay renderer (wkhtmltoimage + ImageMagick)...");

    try {
      // Verify wkhtmltoimage is available
      await this._execPromise("which", ["wkhtmltoimage"]);
      console.log("  ✅ wkhtmltoimage found");

      // Verify ImageMagick convert is available
      await this._execPromise("which", ["convert"]);
      console.log("  ✅ ImageMagick convert found");

      // Load the HTML template
      const templatePath = path.join(__dirname, "public", "overlay.html");
      this._templateHtml = fs.readFileSync(templatePath, "utf8");
      console.log("  ✅ Overlay HTML template loaded");

      this.isRunning = true;

      console.log("✅ HTML overlay renderer ready");
      console.log(`  📐 Output size: ${this.width}x${this.height}`);
      console.log(`  📁 PNG output: ${this.pngPath}`);

      this.emit("ready");
    } catch (err) {
      console.error("❌ Failed to initialize overlay renderer:", err.message);
      this._createPlaceholderPNG(this.pngPath);
      throw err;
    }
  }

  /**
   * Update the overlay with new game state.
   * Generates HTML with state baked in, renders with wkhtmltoimage,
   * then strips green background with ImageMagick.
   * @param {object} gameState - The current game state
   */
  async updateState(gameState) {
    if (!this.isRunning) {
      console.warn("⚠️  Overlay renderer not initialized, skipping update");
      return;
    }

    // Prevent concurrent renders
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
      // Write to temp file first, then atomically rename to avoid GStreamer reading a half-written file
      const tempOutput = this.pngPath + ".tmp";
      await this._execPromise("convert", [
        this.rawPngPath,
        "-alpha", "on",
        "-fuzz", "10%",
        "-transparent", "rgb(0,255,0)",
        `PNG32:${tempOutput}`,
      ]);
      fs.renameSync(tempOutput, this.pngPath);

      console.log(`📸 Overlay PNG updated: ${gameState.player1Score} - ${gameState.player2Score}`);
      this.emit("updated", this.pngPath);
    } catch (err) {
      console.error("❌ Failed to update overlay:", err.message);
    } finally {
      this._renderInProgress = false;
    }
  }

  /**
   * Stop the overlay renderer and clean up temp files.
   */
  async stop() {
    console.log("🛑 Stopping overlay renderer...");
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
   * Create a placeholder transparent PNG so GStreamer doesn't crash
   */
  _createPlaceholderPNG(pngPath) {
    const transparentPNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB" +
      "Nl7BcQAAAABJRU5ErkJggg==",
      "base64"
    );
    fs.writeFileSync(pngPath, transparentPNG);
    console.log(`📝 Created placeholder transparent PNG at ${pngPath}`);
  }

  /**
   * Promise wrapper around execFile
   */
  _execPromise(cmd, args) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => {
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

