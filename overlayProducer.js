// Chooses which engine produces the overlay PNG, and can change its mind.
//
// It presents exactly the interface puppeteerOverlay.js presents, and server.js
// uses it in place of that module — so the switch is one require() line and the
// way back is an environment variable, not a revert.
//
// Three layers of retreat, in order of how fast they act:
//
//   1. OVERLAY_ENGINE=chromium  — ignore the local renderer entirely. One env
//      var and a restart puts the device back exactly where it was.
//   2. Per-overlay refusal      — the local engine is used only for a URL it can
//      parse, an overlay mode whose queries are ported, and a canvas with no
//      unsupported elements. Anything else silently uses the browser.
//   3. Runtime demotion         — if the local engine stops being healthy (its
//      data source is failing, or it reports an element it cannot draw), this
//      hands the same overlay to Chromium mid-flight and logs why.
//
// Demotion is deliberately one-way within a single overlay URL: flapping between
// two renderers on a live stream would be worse than either one. A new URL, or a
// restart, re-evaluates from scratch.
const EventEmitter = require("events");

const SkiaOverlay = require("./skiaOverlay");

// puppeteerOverlay pulls in puppeteer-core, which is not loadable everywhere
// (newer releases are ESM-only, and a dev machine may have no Chromium at all).
// server.js already guards its own require of it; do the same here so a box
// without a working browser still gets the local renderer instead of nothing.
let _PuppeteerOverlay;
function puppeteerAvailable() {
  // In local-only mode the browser is not merely unused, it is never loaded:
  // requiring puppeteer-core pulls in its whole stack, and the point of this
  // mode is a process with no browser in it anywhere.
  if (ENGINE === "local") return null;
  if (_PuppeteerOverlay === undefined) {
    try {
      _PuppeteerOverlay = require("./puppeteerOverlay");
    } catch (err) {
      _PuppeteerOverlay = null;
      console.log("ℹ️  Browser overlay engine unavailable:", err.message);
    }
  }
  return _PuppeteerOverlay;
}

// chromium : only ever use the browser (the safe default while this is new)
// auto     : use the local renderer wherever it can faithfully handle the
//            overlay, and fall back to the browser otherwise
// local    : the local renderer ONLY. puppeteer-core is never even require()d
//            and no browser process is ever started, so a box in this mode runs
//            with no Chromium at all. An overlay the local renderer cannot draw
//            is left blank and logged loudly rather than quietly papered over.
const ENGINE = (process.env.OVERLAY_ENGINE || "chromium").toLowerCase();

// Run the local renderer alongside Chromium, writing to a separate file that
// nothing composites, purely to collect timings and prove it keeps up with a
// real match. Costs CPU, so it is off unless asked for.
const SHADOW = process.env.OVERLAY_SHADOW === "1";

// How often to check that a promoted local engine is still healthy.
const HEALTH_CHECK_MS = 10000;

class OverlayProducer extends EventEmitter {
  constructor() {
    super();
    this._serverPort = 3000;
    this._pngPath = "/dev/shm/graphics-overlay.png";
    this._url = null;
    this._options = {};
    this._active = null;
    this._engineName = null;
    this._shadow = null;
    this._healthTimer = null;
    this._demotedUrls = new Set();
    this._initialized = false;
    this._refreshing = false;
  }

  get isRunning() {
    return !!(this._active && this._active.isRunning);
  }

  /** Which engine is actually drawing right now ("chromium" | "skia" | null). */
  get engine() {
    return this._engineName;
  }

  async initialize(serverPort = 3000, pngPath = "/dev/shm/graphics-overlay.png") {
    this._serverPort = serverPort;
    this._pngPath = pngPath;
    this._initialized = true;
    // Start on the browser. The local engine is a promotion that happens once a
    // URL arrives and proves itself — never the thing a cold device falls back
    // FROM. This also keeps puppeteerOverlay's local-HTML scoreboard mode
    // (updateState) working for callers that never set a URL at all.
    if (puppeteerAvailable()) {
      await this._use("chromium");
    } else if (ENGINE === "local") {
      console.log("🎛️  OVERLAY_ENGINE=local — browser engine will not be loaded at all");
      await this._use("skia");
    } else if (ENGINE !== "chromium") {
      // No browser: the local engine is the only option, so hold off until a URL
      // arrives and setOverlayUrl can tell whether it is one we can draw.
      console.log("🎛️  No browser engine — local renderer only");
    } else {
      throw new Error("OVERLAY_ENGINE=chromium but no browser overlay engine is available");
    }
    return true;
  }

  setOverlayUrl(url, options = {}) {
    this._url = (url || "").trim() || null;
    this._options = options;
    const want = this._engineFor(this._url);
    // Switching engine tears down the old one, so only do it on a real change.
    if (want !== this._engineName) {
      this._use(want).then(() => {
        this._active.setOverlayUrl(this._url, options);
        if (this._refreshing) this._active.startPeriodicRefresh();
      }).catch((err) => {
        console.log(`⚠️  Overlay engine switch to ${want} failed: ${err.message}`);
        this._demote(`engine switch failed: ${err.message}`);
      });
      return;
    }
    if (ENGINE === "local" && this._url && !SkiaOverlay.canHandle(this._url)) {
      console.log(`⚠️  OVERLAY_ENGINE=local and this overlay cannot be drawn locally — it will be BLANK: ${this._url}`);
    }
    this._active.setOverlayUrl(this._url, options);
    this._syncShadow();
  }

  startPeriodicRefresh() {
    this._refreshing = true;
    if (this._active) this._active.startPeriodicRefresh();
    if (this._shadow) this._shadow.startPeriodicRefresh();
    this._startHealthChecks();
  }

  _stopPeriodicRefresh() {
    this._refreshing = false;
    if (this._active && this._active._stopPeriodicRefresh) this._active._stopPeriodicRefresh();
    if (this._shadow) this._shadow._stopPeriodicRefresh();
    this._stopHealthChecks();
  }

  async updateState(gameState) {
    if (!this._active) return false;
    return this._active.updateState(gameState);
  }

  async stop() {
    this._stopHealthChecks();
    this._refreshing = false;
    const jobs = [];
    if (this._active) jobs.push(this._active.stop().catch(() => {}));
    if (this._shadow) jobs.push(this._shadow.stop().catch(() => {}));
    await Promise.all(jobs);
    this._active = null;
    this._shadow = null;
    this._engineName = null;
    return true;
  }

  stats() {
    return {
      configuredEngine: ENGINE,
      activeEngine: this._engineName,
      url: this._url,
      shadow: !!this._shadow,
      demoted: [...this._demotedUrls],
      local: this._engineName === "skia" && this._active.stats ? this._active.stats() : null,
      shadowStats: this._shadow && this._shadow.stats ? this._shadow.stats() : null,
    };
  }

  // ── Engine lifecycle ───────────────────────────────────────────────────────
  _engineFor(url) {
    const canBrowse = !!puppeteerAvailable();
    if (ENGINE === "chromium") return "chromium";
    // local: always the local engine, even for a URL it will refuse — there is
    // no browser to hand it to, and silently drawing nothing without saying so
    // would be worse than an empty overlay plus a log line.
    if (ENGINE === "local") return "skia";
    if (!url) return "chromium";                       // local-HTML scoreboard mode
    if (this._demotedUrls.has(url) && canBrowse) return "chromium"; // already failed once
    if (!SkiaOverlay.canHandle(url)) return "chromium";
    return "skia";
  }

  async _use(name) {
    if (this._engineName === name && this._active) return;
    if (this._active) {
      await this._active.stop().catch(() => {});
      this._active.removeAllListeners();
    }
    if (name === "skia") {
      this._active = new SkiaOverlay();
    } else {
      const Browser = puppeteerAvailable();
      if (!Browser) throw new Error("no browser overlay engine available");
      this._active = new Browser();
    }
    this._engineName = name;
    // Callers listen on this wrapper, so forward whatever the engine emits.
    for (const event of ["updated", "error", "log"]) {
      this._active.on(event, (...args) => this.emit(event, ...args));
    }
    // The local engine refuses overlays it cannot draw faithfully; that refusal
    // is a fallback trigger, not an error.
    if (name === "skia") {
      this._active.on("unsupported", (types) =>
        this._demote(`overlay uses unsupported elements: ${types.join(", ")}`)
      );
    }
    if (this._initialized) await this._active.initialize(this._serverPort, this._pngPath);
    console.log(`🎛️  Overlay engine: ${name}`);
    this._syncShadow();
  }

  /** Hand the current overlay back to Chromium and remember not to retry it. */
  _demote(reason) {
    if (this._engineName !== "skia") return;
    if (ENGINE === "local") {
      console.log(`🎛️  OVERLAY_ENGINE=local — NOT falling back despite: ${reason}`);
      return;
    }
    if (!puppeteerAvailable()) {
      console.log(`🎛️  Would demote to chromium (${reason}) but no browser engine is available — keeping local`);
      return;
    }
    if (this._url) this._demotedUrls.add(this._url);
    console.log(`🎛️  Overlay engine demoted to chromium — ${reason}`);
    const url = this._url;
    const options = this._options;
    const wasRefreshing = this._refreshing;
    this._use("chromium")
      .then(() => {
        if (url) this._active.setOverlayUrl(url, options);
        if (wasRefreshing) this._active.startPeriodicRefresh();
      })
      .catch((err) => console.log(`⚠️  Fallback to chromium failed: ${err.message}`));
  }

  _startHealthChecks() {
    if (this._healthTimer) return;
    this._healthTimer = setInterval(() => {
      if (this._engineName !== "skia" || !this._active) return;
      if (this._active.healthy === false) {
        this._demote(`local renderer unhealthy (${this._active.stats().lastError || "no recent frames"})`);
      }
    }, HEALTH_CHECK_MS);
    if (this._healthTimer.unref) this._healthTimer.unref();
  }

  _stopHealthChecks() {
    if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
  }

  // ── Shadow mode ────────────────────────────────────────────────────────────
  // Runs the local engine beside the browser, writing somewhere nothing reads,
  // so a real tournament can be used to measure it before anything depends on it.
  _syncShadow() {
    const want = SHADOW && this._engineName === "chromium" && this._url && SkiaOverlay.canHandle(this._url);
    if (!want) {
      if (this._shadow) { this._shadow.stop().catch(() => {}); this._shadow = null; }
      return;
    }
    if (this._shadow) { this._shadow.setOverlayUrl(this._url, this._options); return; }
    const shadowPath = `${this._pngPath}.shadow.png`;
    const shadow = new SkiaOverlay();
    this._shadow = shadow;
    shadow
      .initialize(this._serverPort, shadowPath)
      .then(() => {
        shadow.setOverlayUrl(this._url, this._options);
        shadow.on("updated", (info) =>
          console.log(`👻 shadow overlay frame: ${info.ms} ms, ${(info.bytes / 1024).toFixed(0)} KB`)
        );
        shadow.on("unsupported", (types) =>
          console.log(`👻 shadow overlay would have fallen back: ${types.join(", ")}`)
        );
        if (this._refreshing) shadow.startPeriodicRefresh();
        console.log(`👻 Shadow rendering to ${shadowPath} (nothing composites this)`);
      })
      .catch((err) => {
        console.log(`👻 Shadow overlay failed to start: ${err.message}`);
        this._shadow = null;
      });
  }
}

module.exports = OverlayProducer;
module.exports.ENGINE = ENGINE;
module.exports.SHADOW = SHADOW;
