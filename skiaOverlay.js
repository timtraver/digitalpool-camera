// Local overlay producer: writes the same /dev/shm/graphics-overlay[-2].png that
// puppeteerOverlay.js writes, but by drawing the overlay here instead of
// screenshotting a browser.
//
// It is a DROP-IN for puppeteerOverlay — same constructor, initialize(),
// setOverlayUrl(), startPeriodicRefresh(), updateState(), stop(), isRunning and
// the "updated" event — so server.js can choose a producer without knowing which
// one it got. Nothing downstream changes: the pipeline still hot-swaps the PNG
// on mtime (gst-overlay-pipeline.py), and effectiveOverlay() still decides whose
// overlay is on screen.
//
// It refuses work it cannot do faithfully. canHandle() and the unsupported-type
// check exist so the caller can fall back to the browser rather than put a
// subtly wrong scoreboard on a live stream: a URL that is not a DigitalPool
// overlay route, an overlay mode whose queries are not ported yet, an element
// type the renderer does not implement, or a data source that will not answer,
// all mean "use Chromium for this one".
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");

const renderer = require("./overlayRenderer");
const dataSource = require("./overlayDataSource");

// How often to re-read live match state. This is a poll, not a subscription:
// the web overlay uses a subscription for tournament mode and a poll for venue
// mode, and a poll is both simpler and — at this interval — already far fresher
// than the 2 s screenshot sampling it replaces. A tiny JSON query costs orders
// of magnitude less than a 1080p PNG encode, so the interval can be short.
const POLL_MS = parseInt(process.env.OVERLAY_POLL_MS, 10) || 1000;
// How often to re-read the saved canvas, so an overlay edited in the builder
// reaches a running device without a restart.
const CANVAS_REFRESH_MS = parseInt(process.env.OVERLAY_CANVAS_REFRESH_MS, 10) || 60000;
// match_clock shows whole minutes and the web component re-renders every 30 s;
// redraw on the same cadence so the two never disagree by more than that.
const CLOCK_TICK_MS = 30000;
// Consecutive fetch failures tolerated before the producer reports itself
// unhealthy so the caller can fall back. The overlay keeps showing its last
// good frame throughout — a data outage must never blank a live scoreboard.
const FAILURES_BEFORE_UNHEALTHY = 5;

const FONT_DIR = path.join(__dirname, "assets", "fonts");
// Render on a worker thread by default. The draw is ~17 ms but the 1080p PNG
// encode is ~115-175 ms on an N97 and does not yield, so doing it on the main
// thread stalls everything the app does — including the 1 Hz bitrate poll, which
// then reports a dip and a spike around every redraw. Set OVERLAY_RENDER_INLINE=1
// to render on the main thread instead (useful when debugging a render).
const RENDER_INLINE = process.env.OVERLAY_RENDER_INLINE === "1";
const IMAGE_CACHE_DIR = process.env.OVERLAY_IMAGE_CACHE || "/var/tmp/dp-overlay-images";

/** Whether this producer could render the given overlay URL at all. */
function canHandle(url) {
  const parsed = dataSource.parseOverlayUrl(url);
  return !!(parsed && parsed.supported);
}

class SkiaOverlay extends EventEmitter {
  constructor() {
    super();
    this.isRunning = false;
    this.pngPath = "/dev/shm/graphics-overlay.png";
    this._url = null;
    this._parsed = null;
    this._canvas = null;
    this._canvasFetchedAt = 0;
    this._binding = null;
    this._fingerprint = null;
    this._timer = null;
    this._stopped = false;
    this._failures = 0;
    this._lastDrawAt = 0;
    this._hasClock = false;
    this._nextAnimationAt = 0;   // when an animated element next needs a frame
    this._images = new Map();   // url -> decoded Image (inline mode only)
    this._imageBytes = new Map(); // url -> Buffer, for shipping to the worker
    this._worker = null;        // render thread, created on first draw
    this._workerHas = new Set(); // urls the worker has already decoded
    this._renderSeq = 0;
    this._pending = [];         // score-delay queue: [{ at, binding }]
    this._delaySeconds = 0;
    this._renderCount = 0;
    this._lastError = null;
    // Set when the overlay contains something this renderer cannot draw. The
    // caller checks it and hands the overlay back to the browser.
    this.unsupported = null;
  }

  /** Mirrors puppeteerOverlay.initialize(serverPort, pngPath). */
  async initialize(serverPort = 3000, pngPath = "/dev/shm/graphics-overlay.png") {
    this.pngPath = pngPath;
    renderer.registerFonts(FONT_DIR);
    try { fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true }); } catch (e) { /* cache is optional */ }
    this.isRunning = true;
    console.log(`🎨 Skia overlay renderer ready (png: ${this.pngPath}, poll: ${POLL_MS}ms)`);
    return true;
  }

  /**
   * Mirrors puppeteerOverlay.setOverlayUrl. `options` is accepted for interface
   * compatibility; refreshInterval/jsDelay/zoom are browser concepts with no
   * meaning here (there is no page to wait for and no viewport to scale).
   */
  setOverlayUrl(url, _options = {}) {
    const trimmed = (url || "").trim();
    if (trimmed === this._url) return;
    this._url = trimmed || null;
    this._parsed = trimmed ? dataSource.parseOverlayUrl(trimmed) : null;
    // A new overlay invalidates everything derived from the old one.
    this._canvas = null;
    this._canvasFetchedAt = 0;
    this._binding = null;
    this._fingerprint = null;
    this._pending = [];
    this._failures = 0;
    this._nextAnimationAt = 0;
    this._imageBytes.clear();
    this._workerHas.clear();
    if (this._worker) this._worker.postMessage({ type: "forgetImages" });
    this.unsupported = null;
    if (this._parsed && this._parsed.supported) {
      console.log(`🎨 Local overlay: ${this._parsed.mode} ${this._parsed.slug}/${this._parsed.tableSlug} overlay #${this._parsed.overlayId}`);
    } else if (trimmed) {
      console.log(`🎨 Local overlay cannot handle ${trimmed} — caller should fall back`);
    }
  }

  /** Mirrors puppeteerOverlay.startPeriodicRefresh. */
  startPeriodicRefresh() {
    this._stopPeriodicRefresh();
    if (!this._parsed || !this._parsed.supported) return;
    this._stopped = false;
    const tick = async () => {
      if (this._stopped) return;
      let nextDelay = POLL_MS;
      try {
        nextDelay = await this._cycle();
      } catch (err) {
        this._failures++;
        this._lastError = err.message;
        // Log the first failure and then every tenth, so a long outage does not
        // fill the journal.
        if (this._failures === 1 || this._failures % 10 === 0) {
          console.log(`⚠️  Local overlay update failed (${this._failures}x): ${err.message}`);
        }
      }
      if (!this._stopped) this._timer = setTimeout(tick, Math.max(50, Math.min(POLL_MS, nextDelay || POLL_MS)));
    };
    tick();
  }

  _stopPeriodicRefresh() {
    this._stopped = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  /**
   * One poll: refresh the canvas if stale, read live state, redraw if needed.
   * Returns how long to wait before the next tick — normally the poll interval,
   * but shorter when an animated element (a carousel) is mid-transition.
   */
  async _cycle() {
    const now = Date.now();

    if (!this._canvas || now - this._canvasFetchedAt > CANVAS_REFRESH_MS) {
      const canvas = await dataSource.fetchCanvas(this._parsed.overlayId);
      const missing = renderer.unsupportedTypes(canvas);
      if (missing.length) {
        // Refuse rather than draw an overlay with elements silently missing.
        this.unsupported = missing;
        this._stopPeriodicRefresh();
        console.log(`🎨 Local overlay #${this._parsed.overlayId} uses unsupported elements (${missing.join(", ")}) — falling back`);
        this.emit("unsupported", missing);
        return;
      }
      const changed = JSON.stringify(canvas) !== JSON.stringify(this._canvas);
      this._canvas = canvas;
      this._canvasFetchedAt = now;
      this._delaySeconds = this._resolveDelaySeconds(canvas);
      this._hasClock = (canvas.elements || []).some((el) => el.type === "match_clock" && el.visible !== false);
      if (changed) this._fingerprint = null; // force a redraw against the new canvas
    }
    // An overlay whose only moving part is a carousel still has to redraw, even
    // though no match data changed.
    const animationAt = renderer.nextAnimationAt(this._canvas, now);
    const animationDue = animationAt !== null && now >= this._nextAnimationAt;

    const binding = await dataSource.fetchBinding(this._parsed);
    this._failures = 0;
    this._lastError = null;

    const applied = this._applyScoreDelay(binding, now);
    if (!applied) return POLL_MS;

    const fingerprint = dataSource.bindingFingerprint(applied);
    const clockDue = this._hasClock && now - this._lastDrawAt >= CLOCK_TICK_MS;
    if (fingerprint === this._fingerprint && !clockDue && !animationDue) {
      return animationAt === null ? POLL_MS : animationAt - now;
    }

    this._fingerprint = fingerprint;
    this._binding = applied;
    await this._draw(applied, now);

    const after = renderer.nextAnimationAt(this._canvas, Date.now());
    this._nextAnimationAt = after === null ? Infinity : after;
    return after === null ? POLL_MS : after - Date.now();
  }

  /**
   * overlaySettings.scoreDelaySeconds: hold live data back so the overlay lines
   * up with a delayed video feed. Implemented as a queue rather than a sleep so
   * the poll keeps running and the newest state is never dropped.
   */
  _resolveDelaySeconds(canvas) {
    if (this._parsed.delaySeconds != null) return this._parsed.delaySeconds;
    const saved = canvas && canvas.settings && canvas.settings.scoreDelaySeconds;
    const n = Number(saved);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 300) : 0;
  }

  _applyScoreDelay(binding, now) {
    if (!this._delaySeconds) return binding;
    const fingerprint = dataSource.bindingFingerprint(binding);
    const last = this._pending[this._pending.length - 1];
    if (!last || last.fingerprint !== fingerprint) {
      this._pending.push({ at: now + this._delaySeconds * 1000, fingerprint, binding });
    }
    let due = null;
    while (this._pending.length && this._pending[0].at <= now) due = this._pending.shift();
    return due ? due.binding : null;
  }

  /** Render and publish one frame. */
  async _draw(binding, now = Date.now()) {
    await this._ensureImages(binding);
    const started = Date.now();
    const info = RENDER_INLINE
      ? await this._drawInline(binding, now)
      : await this._drawOnWorker(binding, now);
    this._lastDrawAt = Date.now();
    this._renderCount++;
    const ms = info && info.ms != null ? info.ms : this._lastDrawAt - started;
    if (this._renderCount === 1 || this._renderCount % 50 === 0) {
      console.log(`🎨 Local overlay frame ${this._renderCount} (${ms} ms, ${((info && info.bytes) / 1024 || 0).toFixed(0)} KB${RENDER_INLINE ? ", inline" : ""})`);
    }
    this.emit("updated", { ms, bytes: (info && info.bytes) || 0 });
  }

  async _drawInline(binding, now) {
    const surface = renderer.renderCanvas(this._canvas, binding, { images: this._images, now });
    const buf = await surface.encode("png");
    this._writeAtomic(buf);
    return { bytes: buf.length };
  }

  /**
   * Hand the frame to the render thread. Only images the worker has not already
   * decoded are shipped, so a redraw normally sends just the canvas and binding.
   */
  _drawOnWorker(binding, now) {
    const worker = this._ensureWorker();
    const id = ++this._renderSeq;
    const newImages = {};
    for (const [url, bytes] of this._imageBytes) {
      if (!bytes || this._workerHas.has(url)) continue;
      newImages[url] = bytes;
      this._workerHas.add(url);
    }
    return new Promise((resolve, reject) => {
      const onMessage = (msg) => {
        if (msg.type === "imageFailed") {
          console.log(`⚠️  Overlay image unusable (${String(msg.url).slice(0, 80)}): ${msg.message}`);
          return;
        }
        if (msg.id !== id) return;
        worker.off("message", onMessage);
        worker.off("error", onError);
        if (msg.type === "error") reject(new Error(msg.message));
        else resolve(msg);
      };
      const onError = (err) => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        reject(err);
      };
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.postMessage({
        type: "render", id, canvas: this._canvas, binding, now,
        pngPath: this.pngPath, fontsDir: FONT_DIR, newImages,
      });
    });
  }

  _ensureWorker() {
    if (this._worker) return this._worker;
    const worker = new Worker(path.join(__dirname, "overlayRenderWorker.js"));
    worker.unref(); // never hold the process open
    worker.on("error", (err) => {
      console.log(`⚠️  Overlay render thread error: ${err.message}`);
      this._worker = null;
      this._workerHas.clear();
    });
    worker.on("exit", () => { this._worker = null; this._workerHas.clear(); });
    this._worker = worker;
    return worker;
  }

  /**
   * Write via a temporary file and rename. The pipeline watches this path's
   * mtime and re-reads the file the moment it changes, so a plain write would
   * eventually be caught half-finished and decode as a torn or empty overlay.
   * rename(2) within the same filesystem is atomic.
   */
  _writeAtomic(buf) {
    const tmp = `${this.pngPath}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, this.pngPath);
  }

  /**
   * Decode every image the overlay needs, once. Remote images (sponsor logos,
   * avatars, flags) are cached on disk as well as in memory so a restart — or a
   * venue with flaky uplink — does not lose them.
   */
  async _ensureImages(binding) {
    const urls = renderer.imageUrls(this._canvas, binding, null);
    for (const url of urls) {
      if (this._imageBytes.has(url) || this._images.has(url)) continue;
      try {
        const bytes = await this._fetchImageBytes(url);
        this._imageBytes.set(url, bytes);
        // Decoding is synchronous too, so it only happens here in inline mode;
        // on the worker path the bytes are decoded on the render thread.
        if (RENDER_INLINE) this._images.set(url, await renderer.loadImage(bytes));
      } catch (err) {
        // A missing logo must not stop the scoreboard; the element just draws
        // nothing, which is what the web renderer does for a broken <img> too.
        console.log(`⚠️  Overlay image unavailable (${url.slice(0, 80)}): ${err.message}`);
        this._imageBytes.set(url, null);
        if (RENDER_INLINE) this._images.set(url, null);
      }
    }
  }

  async _fetchImageBytes(url) {
    if (!/^https?:/i.test(url)) return fs.readFileSync(url); // bundled flag assets
    const key = path.join(IMAGE_CACHE_DIR, Buffer.from(url).toString("base64url").slice(0, 180));
    try {
      if (fs.existsSync(key)) return fs.readFileSync(key);
    } catch (e) { /* fall through to the network */ }
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    try { fs.writeFileSync(key, buf); } catch (e) { /* cache is optional */ }
    return buf;
  }

  /**
   * puppeteerOverlay's local-HTML scoreboard mode. The JSON renderer draws from
   * DigitalPool's own data, so there is no equivalent and nothing to do.
   */
  async updateState(_gameState) {
    return false;
  }

  /** Health, for the caller's fallback decision and for diagnostics. */
  get healthy() {
    return !this.unsupported && this._failures < FAILURES_BEFORE_UNHEALTHY;
  }

  stats() {
    return {
      engine: "skia",
      url: this._url,
      mode: this._parsed && this._parsed.mode,
      overlayId: this._parsed && this._parsed.overlayId,
      renders: this._renderCount,
      lastDrawAt: this._lastDrawAt || null,
      failures: this._failures,
      lastError: this._lastError,
      unsupported: this.unsupported,
      delaySeconds: this._delaySeconds,
      healthy: this.healthy,
    };
  }

  async stop() {
    this._stopPeriodicRefresh();
    this.isRunning = false;
    this._images.clear();
    this._imageBytes.clear();
    this._workerHas.clear();
    if (this._worker) {
      await this._worker.terminate().catch(() => {});
      this._worker = null;
    }
    return true;
  }
}

module.exports = SkiaOverlay;
module.exports.canHandle = canHandle;
