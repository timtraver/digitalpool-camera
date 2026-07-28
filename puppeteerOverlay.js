const EventEmitter = require("events");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const puppeteer = require("puppeteer-core");

// ── Shared headless Chromium ─────────────────────────────────────────────────
// All overlay instances (one per camera) share a SINGLE Chromium process, each
// owning its own page/tab.  Launching a full second browser per camera wastes an
// entire browser + gpu + utility process stack (~150-250 MB and steady CPU) for
// no benefit — one browser with N pages produces the same screenshots far more
// cheaply, which matters most on the Intel N97 where CPU headroom is tight when
// both cameras stream with remote overlays.
let _sharedBrowser = null;          // the one Chromium instance, or null
let _sharedBrowserLaunching = null; // in-flight launch Promise (concurrency guard)
let _sharedBrowserPageCount = 0;    // live overlay pages; browser closes at 0

// Version-agnostic connectivity check.
// Puppeteer 20.x exposes Browser.isConnected() (a method); v22 deprecated it in
// favour of the `connected` getter and v23 removed the method entirely. Support
// both so the code works whether puppeteer-core is pinned old or bumped to latest.
function _isBrowserConnected(b) {
  if (!b) return false;
  if (typeof b.connected === "boolean") return b.connected;      // puppeteer >= 22
  if (typeof b.isConnected === "function") return b.isConnected(); // puppeteer <= 20
  return false;
}

// Locate the Chromium executable across the common install locations.
function _findChromiumPath() {
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

/**
 * Launch (or reuse) the ONE shared headless Chromium.  Guarded so concurrent
 * callers (both cameras enabling overlays at once) await the same launch instead
 * of racing two browsers into existence.
 */
async function _acquireSharedBrowser() {
  if (_sharedBrowser && _isBrowserConnected(_sharedBrowser)) return _sharedBrowser;
  if (_sharedBrowserLaunching) return _sharedBrowserLaunching;

  _sharedBrowserLaunching = (async () => {
    const chromiumPath = _findChromiumPath();
    console.log(`🚀 Launching shared headless Chromium for URL overlays (${chromiumPath})...`);
    // Minimal flags only — proven stable on ARM64 with Chromium 114 + puppeteer-core 20.9
    // pipe:false → use WebSocket transport instead of stdio pipes.
    // Pipes can be disrupted when the Node process has many child processes
    // (GStreamer, ImageMagick) competing for stdio resources.
    const browser = await puppeteer.launch({
      executablePath: chromiumPath,
      headless: true,
      pipe: false,
      // The freshly-loaded overlay page intermittently leaves the renderer
      // unresponsive to CDP (screenshot / Emulation / evaluate all hang) for a
      // while after navigation — a re-navigation clears it. Keep this timeout
      // short so a wedged call fails fast and the loop re-navigates, instead of
      // stalling for Puppeteer's 180s default (or a long 30s).
      protocolTimeout: 8000,
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
        // Keep the headless page fully active while it sits idle. Without these,
        // Chromium throttles/freezes background pages, and the first operation
        // after an idle stretch (page.evaluate for the zoom, or the screenshot)
        // hangs until protocolTimeout — the ~100s "nothing happens then times
        // out" delay seen when switching overlays after the preview sat a while.
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        // Disable Chromium's audio subsystem entirely — this process is screenshot-only
        // and has no need for audio playback or capture.
        //
        // On systems without PulseAudio/PipeWire (bare ALSA), Chromium initialises its
        // ALSA backend on startup and opens /dev/snd/pcmC1D0c (plughw:1,0) — even when
        // the page plays no sound.  This holds the USB capture device exclusively,
        // preventing GStreamer's alsasrc from opening it and causing:
        //   "Could not open audio device for recording. Device is being used by another application."
        //
        // --disable-audio : shuts down Chromium's entire audio stack (no ALSA open).
        // --mute-audio    : left in as belt-and-suspenders for any residual output path.
        // --use-fake-device-for-media-stream : if the page calls getUserMedia(), it
        //     receives a fake mic/camera so the real ALSA device is never opened.
        "--disable-audio",
        "--mute-audio",
        "--use-fake-device-for-media-stream",
        // One renderer PER overlay page (up to 2 cameras). Prevents orphaned
        // renderers accumulating after failed navigations while still giving each
        // camera's page its own renderer process (so one page can't starve or
        // crash the other). With a single shared browser this replaces the old
        // per-browser --renderer-process-limit=1.
        "--renderer-process-limit=2",
        // Cap V8's old-generation heap inside each renderer. Two simple
        // React/WebSocket overlay pages don't need a large heap; this bounds
        // GC retention over a long-running session. Sized for up to two pages
        // that may share one renderer when same-origin.
        "--js-flags=--max-old-space-size=256",
      ],
    });

    // Track disconnection — clear the shared refs so the next overlay cycle
    // relaunches.  Page count resets to 0; each instance recreates its page
    // (and re-increments) on its next _ensureBrowser().
    browser.on("disconnected", () => {
      if (_sharedBrowser === browser) {
        console.log("🔄 Shared Chromium disconnected — will relaunch on next overlay cycle");
        _sharedBrowser = null;
        _sharedBrowserPageCount = 0;
      }
    });

    _sharedBrowser = browser;
    return browser;
  })();

  try {
    return await _sharedBrowserLaunching;
  } finally {
    _sharedBrowserLaunching = null;
  }
}

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
    // How often to re-screenshot the URL (ms). Each screenshot is a full-res
    // 1920×1080 PNG encode with alpha; at 3s (vs the old 2s) that's a third
    // fewer captures per camera for scoreboards that update slowly, with barely
    // perceptible added latency. Overridable via setOverlayUrl({refreshInterval}).
    this._refreshIntervalMs = 3000;
    // Wait after navigation before the first screenshot. Only applies right
    // after a switch/enable (not on every refresh), so it's pure switch latency.
    // Kept modest because the 2s periodic refresh + hot-swap self-corrects a
    // slightly-early first frame within one cycle.
    this._jsDelay = 1000;           // Time to wait for JS execution before screenshot (ms)
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
      const trimmed = url.trim();
      const urlChanged = trimmed !== this._overlayUrl;
      this._overlayUrl = trimmed;
      if (options.refreshInterval) this._refreshIntervalMs = options.refreshInterval;
      if (options.jsDelay) this._jsDelay = options.jsDelay;
      if (options.zoom && options.zoom !== this._zoom) {
        this._zoom = options.zoom;
        this._zoomDirty = true; // Flag to re-apply zoom on next screenshot cycle
      }
      // On a switch, do NOT clear the composited PNG. Fetching + rendering the
      // new page takes a few seconds; blanking now would leave the overlay empty
      // for that whole window. Instead keep the previous overlay visible until
      // the new screenshot is ready, so the swap reads as a clean old → new with
      // no blank gap (both the streaming mtime hot-swap and the idle rebuild pick
      // up the new PNG the moment it lands). Only disabling clears it (below).
      if (urlChanged) {
        // Force the next render to re-navigate to the new page (rather than
        // treating the already-loaded old page as current).
        this._currentLoadedUrl = null;
      }
      console.log(`🌍 Overlay URL mode enabled: ${this._overlayUrl}`);
      console.log(`   Refresh interval: ${this._refreshIntervalMs}ms, JS delay: ${this._jsDelay}ms, zoom: ${this._zoom}%`);
      return urlChanged;
    } else {
      const wasEnabled = !!this._overlayUrl;
      this._overlayUrl = null;
      this._stopPeriodicRefresh();
      this._closeBrowser(); // Clean up Chromium when disabling URL mode
      // Replace the last URL screenshot with a transparent placeholder
      // so GStreamer doesn't keep showing the old (possibly white) image
      this._createPlaceholderPNG(this.pngPath);
      console.log("📄 Overlay switched to local HTML mode (cleared old overlay)");
      return wasEnabled;
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
    // On success, wait the normal interval before the next screenshot. On
    // failure (e.g. the post-navigation renderer hang), retry almost immediately
    // — the re-navigation reliably clears the wedge, so a fast retry turns a
    // ~8s stall into a quick recover instead of waiting a full interval on top.
    const scheduleNext = (delayMs) => {
      if (!this._refreshActive) return;
      this._refreshTimer = setTimeout(async () => {
        if (!this._refreshActive) return;
        const ok = await this._renderUrlOverlay();
        scheduleNext(ok ? this._refreshIntervalMs : 300);
      }, delayMs);
    };

    // Do an immediate first render, then start the cycle
    this._renderUrlOverlay().then((ok) => scheduleNext(ok ? this._refreshIntervalMs : 300));

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
   * Version-agnostic connectivity check for THIS instance's view of the shared
   * browser.  (Kept as an instance method so the render loop's existing calls
   * work unchanged.)
   */
  _browserConnected() {
    return _isBrowserConnected(this._browser);
  }

  /**
   * Ensure the shared Chromium is up and this instance owns an open page in it.
   * The browser is launched once for all cameras; each camera gets its own page.
   */
  async _ensureBrowser() {
    // Acquire (launching if needed) the single shared Chromium.
    this._browser = await _acquireSharedBrowser();

    // Reuse this instance's page if it's still open.
    if (this._page && !this._page.isClosed()) return;

    // (Re)create this camera's own page/tab in the shared browser.
    this._page = await this._browser.newPage();
    _sharedBrowserPageCount++;

    // deviceScaleFactor: 1 is required — without it Chromium may auto-detect
    // the system DPI and apply a DPR > 1 (common on HiDPI / ARM64 hosts with
    // high-density display configs), producing a screenshot at 2× or 3× the
    // viewport size.  A 3840×2160 PNG painted onto a 1920×1080 video frame
    // would appear 2× too large and overflow the frame.
    await this._page.setViewport({ width: this.width, height: this.height, deviceScaleFactor: 1 });
    // Force a transparent background via an injected script that runs at document
    // creation on EVERY navigation — instead of a post-load page.evaluate(), which
    // intermittently wedges (Runtime.callFunctionOn hanging until protocolTimeout)
    // when the freshly-loaded overlay page is busy or mid-redirect. Combined with
    // the screenshot's omitBackground, this keeps overlays transparent without a
    // hang-prone CDP round-trip on the hot path.
    try {
      await this._page.evaluateOnNewDocument(() => {
        const makeTransparent = () => {
          if (document.documentElement) document.documentElement.style.backgroundColor = "transparent";
          if (document.body) document.body.style.backgroundColor = "transparent";
        };
        makeTransparent();
        document.addEventListener("DOMContentLoaded", makeTransparent);
      });
    } catch (e) {
      console.warn(`⚠️  Could not install transparent-bg script: ${e.message}`);
    }
    this._currentLoadedUrl = null; // Track what URL is loaded
    console.log(`  ✅ Overlay page ready (shared Chromium, ${_sharedBrowserPageCount} page(s) open)`);
  }

  /**
   * Release this instance's page.  Closes only THIS camera's page/tab; the
   * shared Chromium stays alive for the other camera and is shut down (with its
   * whole process group killed) only when the last overlay page is gone.
   */
  async _closeBrowser() {
    if (this._page) {
      try { if (!this._page.isClosed()) await this._page.close(); } catch (e) { /* ignore */ }
      this._page = null;
      _sharedBrowserPageCount = Math.max(0, _sharedBrowserPageCount - 1);
    }
    this._currentLoadedUrl = null;

    // When no overlay pages remain, shut the shared browser down entirely.
    if (_sharedBrowserPageCount === 0 && _sharedBrowser) {
      const b = _sharedBrowser;
      const pid = b.process && b.process() ? b.process().pid : null;
      _sharedBrowser = null;
      try { await b.close(); } catch (e) { /* ignore */ }
      console.log("🛑 Shared Chromium browser closed (no overlay pages remain)");

      // Safety: kill the entire process group so Chrome's child processes
      // (renderer, gpu-process, zygote, utility, crashpad) are also terminated.
      // process.kill(-pid, signal) sends to the process GROUP (PGID = pid when
      // Chrome is a process group leader, which it always is on Linux).
      // Killing only the parent PID leaves children reparented to init as orphans.
      if (pid) {
        try { process.kill(-pid, "SIGKILL"); } catch (e) { /* not a group leader or already dead */ }
        try { process.kill(pid,  "SIGKILL"); } catch (e) { /* already dead */ }
      }
    }

    this._browser = null;
  }

  /**
   * Render a remote URL overlay using Puppeteer (persistent headless Chromium).
   * The browser stays alive between screenshots. The overlay page maintains its
   * own WebSocket/subscription for real-time score updates — we just screenshot
   * the current page state periodically. No reload, no re-navigation.
   */
  async _renderUrlOverlay() {
    if (this._renderInProgress) {
      return true; // Skip this cycle, next interval will try again
    }
    if (!this._overlayUrl) return true;

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
        const _navStart = Date.now();
        await this._page.goto(this._overlayUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        console.log(`✅ Navigation completed in ${Date.now() - _navStart}ms`);
        this._currentLoadedUrl = this._overlayUrl;
        this._zoomDirty = true; // Always apply zoom after navigation

        // Wait for JS frameworks to finish initial render
        console.log(`⏳ Waiting ${this._jsDelay}ms for JS framework to render...`);
        await new Promise(r => setTimeout(r, this._jsDelay));

        // Detect a client-side redirect (page.url() is cached — no CDP call, safe
        // even when the renderer is wedged). A redirect right after load is one
        // suspected cause of a post-navigation CDP hang.
        const _finalUrl = this._page.url();
        if (_finalUrl && _finalUrl !== this._overlayUrl) {
          console.log(`↪️  Overlay page redirected to: ${_finalUrl}`);
        }
        // No separate evaluate-probe: the first navigation to a new overlay URL
        // reliably wedges the screenshot's Emulation.setDefaultBackgroundColorOverride
        // call (omitBackground) for ~8s even though page.evaluate() answers fine —
        // so an evaluate probe passes and misses it. Instead the screenshot itself
        // is bounded by a short race below, which re-navigates on the wedge (the
        // re-navigation clears it, typically in <1s thanks to the code cache).
      }

      // Apply zoom when dirty (after nav or zoom change). Transparent background
      // is already handled by the injected evaluateOnNewDocument script above, so
      // this call is only needed for a non-100% zoom. Skipping it at 100% (the
      // default) avoids a post-load page.evaluate() on the hot path entirely.
      if (this._zoomDirty && this._zoom !== 100) {
        console.log(`🔍 Applying zoom: ${this._zoom}%`);
        try {
          // Race against a short timeout so a wedged JS context (busy page or
          // mid-redirect) can't stall the loop until protocolTimeout — screenshot
          // anyway; zoom re-applies next cycle since _zoomDirty stays set on failure.
          await Promise.race([
            this._page.evaluate((zoom) => {
              document.body.style.zoom = (zoom / 100).toString();
            }, this._zoom),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("zoom apply timed out (page busy)")), 3000)
            ),
          ]);
          this._zoomDirty = false;
        } catch (e) {
          console.warn(`⚠️  Overlay zoom apply skipped this cycle: ${e.message}`);
        }
      } else if (this._zoomDirty) {
        // 100% zoom is a no-op — nothing to apply, just clear the flag.
        this._zoomDirty = false;
      }

      // Screenshot with native transparency — no ImageMagick chroma-key needed.
      // Race against a short timeout: the first screenshot after navigating to a
      // new overlay URL frequently wedges on Emulation.setDefaultBackgroundColor-
      // Override (~8s to protocolTimeout). Bounding it here fails fast (~2.5s) so
      // the catch re-navigates, which clears the wedge — usually in <1s (cached).
      const tempPath = this.pngPath + ".tmp";
      await Promise.race([
        this._page.screenshot({
          path: tempPath,
          type: "png",
          omitBackground: true,
          timeout: 10000,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("screenshot wedged after navigation — re-navigating")), 2500)
        ),
      ]);
      // Atomic rename so GStreamer never reads a partial file
      fs.renameSync(tempPath, this.pngPath);

      // Tag the event with the URL this frame came from so the server can ignore
      // stale screenshots of a previous overlay (an in-flight render of the old
      // URL completing right after a switch) and only act on the new overlay.
      this.emit("updated", this.pngPath, this._currentLoadedUrl);
      return true;
    } catch (err) {
      // Always log — silently swallowing errors makes debugging impossible.
      console.error("❌ Overlay render error:", err.message);
      // Force a fresh navigation on the next cycle regardless of the failure
      // mode — a timed-out screenshot or a partially-loaded page should not be
      // treated as "already loaded" (which would skip re-navigation and keep
      // screenshotting a wedged page). The re-navigation reliably clears the
      // post-load renderer hang.
      this._currentLoadedUrl = null;
      if (!this._browser || !this._browserConnected()) {
        // Browser died — _ensureBrowser will relaunch on the next cycle.
        console.log("🔄 Chromium disconnected — will relaunch on next cycle");
        this._browser = null;
        this._page = null;
      }
      return false;
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

