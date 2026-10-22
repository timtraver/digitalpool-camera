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
const ads = require("./overlayAds");

// How often to re-read live match state. This is a poll, not a subscription,
// and it runs at two speeds.
//
// 2000 ms is deliberately the same interval CustomOverlayRenderer polls at for
// venue mode, so moving the query from the browser to the device does not change
// how often DigitalPool is asked. Halving it would double the request rate
// across every camera in the fleet for a latency gain the viewer cannot see:
// the overlay still only redraws when something actually changed, and the
// pipeline now notices a new overlay within 250 ms rather than 2 s, so a score
// change reaches the stream in about a quarter of the time the browser path
// took even at this interval.
//
// But that cadence is only worth paying for while a match is on the table. A
// device parked on a venue overlay between events used to send the full query
// 43,000 times a day to re-render the same empty scoreboard, and a venue box is
// idle far more often than it is live. So the fast poll is now entered on
// evidence: an empty table is watched with dataSource.probeLive(), which asks
// only whether anything is there, and the full query starts the moment it is.
const POLL_MS = parseInt(process.env.OVERLAY_POLL_MS, 10) || 2000;
// How often to ask "has a match started?" while the table is empty.
const IDLE_POLL_MS = parseInt(process.env.OVERLAY_IDLE_POLL_MS, 10) || 20000;
// How long to keep polling at match tempo after the last match left the table.
// One match ending and the next being assigned is a normal gap of seconds;
// dropping straight to the idle cadence would make the next one take up to
// IDLE_POLL_MS to appear, which is exactly when an operator is watching.
const IDLE_AFTER_MS = parseInt(process.env.OVERLAY_IDLE_AFTER_MS, 10) || 60000;
// With the subscription connected the idle probe stops entirely — the socket
// has already said whether anything is on the table, and says so again the
// instant it changes. This re-check exists only so that a push which never
// arrived (a half-open socket the OS has not given up on, a Hasura restart that
// dropped the subscription without closing the connection) cannot strand an
// overlay forever. It is the safety net, not the mechanism.
const WATCH_RECHECK_MS = parseInt(process.env.OVERLAY_WATCH_RECHECK_MS, 10) || 600000;
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
  /**
   * `options.shadow` marks an instance that renders alongside the real
   * producer for measurement (OVERLAY_SHADOW=1) and whose frames composite
   * nothing. It only affects ad impressions: the browser is the one actually
   * on screen then, and it is already counting them — a shadow counting them
   * too would bill the venue's advertisers twice.
   */
  constructor(options = {}) {
    super();
    this._shadow = options.shadow === true;
    // Whether this camera is actually streaming. Impressions are only counted
    // while it is — see _noteImpressions().
    this._streamLive = false;
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
    this._hasAds = false;        // does the canvas carry an ad_center element
    this._ads = null;            // venueId -> [ad], as last read from Ad Center
    this._adsFingerprint = "";   // changes when the ad LISTS change, not the rotation
    this._adErrors = null;
    this._nextAdFetchAt = 0;
    this._nextAnimationAt = 0;   // when an animated element next needs a frame
    this._fresh = null;         // newest binding read from DigitalPool
    this._live = false;         // is a match on the table (→ which cadence)
    this._lastMatchAt = 0;      // last time a match was actually seen
    this._nextFetchAt = 0;      // when the data layer may be asked again
    this._watch = null;         // subscription handle, when one is held
    this._watchActive = null;   // last pushed verdict; null = it has not spoken
    this._onWatchState = null;  // socket up/down listener, while watching
    this._loopGen = 0;          // only the newest tick chain may continue
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
    this._hasAds = false;
    this._ads = null;
    this._adsFingerprint = "";
    this._adErrors = null;
    this._nextAdFetchAt = 0;
    this._fresh = null;
    this._live = false;
    this._lastMatchAt = 0;
    this._nextFetchAt = 0;
    this._stopWatch();
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
    // Keep any socket we already hold. server.js re-applies the effective
    // overlay on all sorts of events and calls this each time; tearing the
    // subscription down and rebuilding it every time would churn a connection
    // that is still perfectly good for the same overlay. setOverlayUrl() closes
    // it when the URL actually changes, and _stopPeriodicRefresh() with no
    // argument — which is what the "overlay off" path calls — still closes it.
    this._stopPeriodicRefresh(true);
    if (!this._parsed || !this._parsed.supported) return;
    this._stopped = false;
    this._nextFetchAt = 0;   // the first tick always reads
    this._startWatch();
    // Each start owns a generation. A tick that is already awaiting a fetch
    // cannot be stopped by the _stopped flag — it resumes after the restart has
    // cleared it — so without this a second startPeriodicRefresh() leaves TWO
    // loops running, each polling, which is exactly the load this is all meant
    // to remove.
    this._loopGen++;
    this._tick(this._loopGen);
  }

  async _tick(gen) {
    if (this._stopped || gen !== this._loopGen) return;
    let nextDelay = this._live ? POLL_MS : IDLE_POLL_MS;
    try {
      nextDelay = await this._cycle();
    } catch (err) {
      this._failures++;
      this._lastError = err.message;
      // Do not keep hammering a data source that is failing: an idle table
      // retries on the idle cadence, which is also what a device with an
      // unreachable uplink should be doing.
      this._nextFetchAt = Date.now() + (this._live ? POLL_MS : IDLE_POLL_MS);
      // Log the first failure and then every tenth, so a long outage does not
      // fill the journal.
      if (this._failures === 1 || this._failures % 10 === 0) {
        console.log(`⚠️  Local overlay update failed (${this._failures}x): ${err.message}`);
      }
    }
    // The ceiling is the idle cadence, not the fast one: a tick is free, but it
    // must never be the thing that forces a query. Even with the subscription
    // holding the data side quiet for ten minutes at a time, the loop keeps
    // turning at this rate so _outputMissing() still self-heals promptly.
    if (!this._stopped && gen === this._loopGen) {
      const wait = Number.isFinite(nextDelay) ? nextDelay : IDLE_POLL_MS;
      this._timer = setTimeout(() => this._tick(gen), Math.max(50, Math.min(IDLE_POLL_MS, wait)));
    }
  }

  /** Re-enter the loop now rather than waiting out the current sleep. */
  _kick() {
    this._nextFetchAt = 0;
    if (this._stopped || !this._timer) return;   // a tick already in flight will pick it up
    clearTimeout(this._timer);
    this._timer = null;
    this._tick(this._loopGen);
  }

  _stopPeriodicRefresh(keepWatch = false) {
    this._stopped = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!keepWatch) this._stopWatch();
  }

  // ── Subscription ───────────────────────────────────────────────────────────
  /**
   * Hold the idle question open instead of asking it on a timer. This is an
   * optimisation and nothing more: everything still works, at the idle poll
   * cadence, if the socket never connects or quietly dies.
   */
  _startWatch() {
    if (this._watch || !this._parsed || !this._parsed.supported) return;
    const parsed = this._parsed;   // guard against the overlay changing under us
    this._watchActive = null;

    // Losing the socket has to pull the next read back in. While the watch is
    // healthy the idle read is scheduled WATCH_RECHECK_MS out, and without this
    // a drop would leave the overlay waiting ten minutes before it noticed it
    // was on its own again — the exact stranding the re-check exists to stop.
    if (!this._onWatchState) {
      this._onWatchState = (connected) => {
        if (connected || this._live) return;
        this._watchActive = null;   // it knows nothing until it speaks again
        this._kick();
      };
      dataSource.watchEvents.on("state", this._onWatchState);
    }
    dataSource
      .watchLive(parsed, (active) => {
        if (this._parsed !== parsed) return;
        const spokenBefore = this._watchActive !== null;
        this._watchActive = active;
        // A match appearing is the entire point of holding the socket open —
        // do not make it wait for the re-check.
        if (active && !this._live) {
          if (spokenBefore) console.log("🎬 Watch: match assigned to the table");
          this._kick();
        }
      })
      .then((handle) => {
        if (this._parsed !== parsed || this._stopped) { handle.close(); return; }
        this._watch = handle;
      })
      .catch((err) => {
        console.log(`ℹ️  Overlay watch unavailable, polling instead: ${err.message}`);
      });
  }

  _stopWatch() {
    if (this._watch) { this._watch.close(); this._watch = null; }
    if (this._onWatchState) {
      dataSource.watchEvents.removeListener("state", this._onWatchState);
      this._onWatchState = null;
    }
    this._watchActive = null;
  }

  /**
   * Whether the subscription may be believed instead of polled. Connected is
   * not enough — a socket that has not yet delivered its first payload knows
   * nothing, and treating silence as "no match" would strand the overlay.
   */
  _watchHealthy() {
    return !!(this._watch && this._watchActive !== null && dataSource.watchStats().connected);
  }

  /**
   * One tick: refresh the canvas if stale, read live state IF A READ IS DUE,
   * redraw if needed. Returns how long to wait before the next tick.
   *
   * A tick is not a query. Carousel frames and the match clock redraw from the
   * binding already in hand, so animation runs at whatever rate it needs
   * without that rate reaching DigitalPool — which it used to, because every
   * tick fetched. With OVERLAY_CAROUSEL_FADE=1 that meant ten queries a second
   * for the length of every fade.
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
      this._hasAds = ads.hasAdElements(canvas);
      // An edited canvas can point an ad_center element at a different venue,
      // so re-read the ads rather than waiting out the refresh interval.
      if (changed) this._nextAdFetchAt = 0;
      if (changed) this._fingerprint = null; // force a redraw against the new canvas
    }
    // Redraw if our output has gone missing. The browser producer rewrote its
    // PNG every couple of seconds whether or not anything had changed, so
    // anything that removed the file self-healed almost immediately. This one
    // draws only on change, which is the whole point — but it means a deleted
    // file would never come back, and the pipeline would sit with no overlay
    // indefinitely. Several things still delete that path (a stream restart,
    // the browser producer's own cleanup on a box that has run both), so check
    // rather than assume. It is a stat() per poll.
    if (this._outputMissing()) {
      this._fingerprint = null;
      console.log("🎨 Overlay output disappeared — redrawing");
    }

    if (now >= this._nextFetchAt) await this._readLiveState(now);

    // The delay queue is driven every tick, not every fetch: it releases on
    // wall-clock time, and re-offering a binding whose fingerprint has not
    // changed is a no-op.
    let applied = this._applyScoreDelay(this._fresh, now);
    if (!applied) return this._nextDelay(now);

    // ad_center elements hold no images of their own — the venue's current Ad
    // Center ads are read on a cadence of their own and ride along on the
    // binding, which is what makes them visible to the renderer and to the
    // worker thread without either of them making a request.
    if (this._hasAds) applied = await this._withAds(applied, now);

    // An overlay whose only moving part is a carousel still has to redraw, even
    // though no match data changed.
    const animationAt = renderer.nextAnimationAt(this._canvas, now, applied);
    const animationDue = animationAt !== null && now >= this._nextAnimationAt;
    // Only a live match has a clock worth advancing; an empty table's clock
    // reads the same every time, so redrawing it burns a 1080p encode for
    // nothing.
    const clockDue = this._hasClock && this._live && now - this._lastDrawAt >= CLOCK_TICK_MS;

    const fingerprint = dataSource.bindingFingerprint(applied) + this._adsFingerprint;
    if (fingerprint !== this._fingerprint || clockDue || animationDue) {
      this._fingerprint = fingerprint;
      this._binding = applied;
      await this._draw(applied, now);
      const after = renderer.nextAnimationAt(this._canvas, Date.now(), applied);
      this._nextAnimationAt = after === null ? Infinity : after;
      // An ad is counted once it has actually been drawn, for the same reason
      // the web component logs from a render effect: a slot the stream never
      // showed is not an impression.
      if (this._hasAds) this._noteImpressions(applied, Date.now());
    }
    return this._nextDelay(Date.now());
  }

  /**
   * Ask DigitalPool what is on the table, at whichever cost the situation
   * justifies — the full binding while a match is live, the probe while the
   * table is empty.
   *
   * The first read of an overlay is always a full one even with no match on the
   * table: the blank scoreboard still carries the venue's own name and location
   * (fetchVenueBinding's last return), and the probe cannot supply those.
   */
  async _readLiveState(now) {
    if (this._fresh && !this._live) {
      if (!(await this._somethingOnTable(now))) return;
      console.log(`🎬 Match on the table — reading live data every ${POLL_MS}ms`);
      this._live = true;
      this._lastMatchAt = now;
    }

    this._fresh = await dataSource.fetchBinding(this._parsed);
    this._failures = 0;
    this._lastError = null;

    if (dataSource.hasLiveMatch(this._fresh)) {
      this._live = true;
      this._lastMatchAt = now;
    } else if (this._live && now - this._lastMatchAt > IDLE_AFTER_MS) {
      this._live = false;
      console.log(`💤 Table empty — backing off to a ${IDLE_POLL_MS}ms probe`);
    }
    this._nextFetchAt = now + (this._live ? POLL_MS : IDLE_POLL_MS);
  }

  /**
   * The idle question — is anything on this table — answered by whichever
   * transport is actually working. Sets the next read time and returns false
   * when there is still nothing to draw.
   *
   * The subscription wins when it is healthy, and costs no request at all. The
   * poll is not a legacy path kept around for symmetry: these boxes live on
   * venue WiFi behind NAT, the socket will drop, and when it does this is what
   * keeps the overlay working.
   */
  async _somethingOnTable(now) {
    if (this._watchHealthy()) {
      if (!this._watchActive) {
        this._nextFetchAt = now + WATCH_RECHECK_MS;
        return false;
      }
      return true;
    }
    const probe = await dataSource.probeLive(this._parsed);
    this._failures = 0;
    this._lastError = null;
    if (!probe.active) {
      this._nextFetchAt = now + IDLE_POLL_MS;
      return false;
    }
    return true;
  }

  /**
   * Put the venue's current ads on the binding for the renderer to draw.
   *
   * Never throws. The ads are a separate data source from the scoreboard, on a
   * five-minute cadence rather than a two-second one, and a failure to read
   * them must not count as a binding failure or stop the match data — the last
   * good list is kept and the overlay carries on.
   */
  async _withAds(binding, now) {
    let next = binding;
    // "Automatic" means the venue the overlay is shown at. When the URL names
    // none — a tournament with no venue attached — the venue this appliance is
    // registered to stands in, since unlike a browser it knows where it is.
    // Resolved HERE, onto binding.venue, so the renderer keeps the web
    // component's rule rather than carrying a second one.
    if (!(next.venue && next.venue.id)) {
      const fallback = ads.fallbackVenueId();
      if (fallback) next = dataSource.withBindingVenue(next, fallback);
    }

    const venueIds = ads.adVenueIds(this._canvas, next);
    if (!venueIds.length) {
      this._ads = null;
      this._adsFingerprint = "";
      return next;
    }

    if (!this._ads || now >= this._nextAdFetchAt) {
      const { ads: byVenue, errors } = await ads.fetchAds(venueIds, now);
      const signature = ads.adsSignature(byVenue);
      if (signature !== this._adsFingerprint) {
        const counts = venueIds.map((id) => `venue ${id}: ${(byVenue[id] || []).length}`).join(", ");
        console.log(`📣 Ad Center ads for this overlay — ${counts}`);
      }
      this._ads = byVenue;
      this._adErrors = Object.keys(errors).length ? errors : null;
      this._adsFingerprint = signature;
      this._nextAdFetchAt = now + ads.REFRESH_MS;
    }
    return { ...next, ads: this._ads };
  }

  /**
   * Whether the overlay this produces is going into a live stream.
   *
   * server.js sets this from the stream controller's own state. It exists for
   * the impression count: the overlay producer runs whenever an overlay URL is
   * configured, which on a venue box is most of the day, and an ad drawn into
   * a PNG that no pipeline is reading has been shown to nobody.
   */
  setStreamLive(live) {
    this._streamLive = !!live;
  }

  /**
   * Which camera this producer belongs to. The PNG path is what says so —
   * server.js gives camera 2 the "-2" file — and it is the only identity this
   * class is handed.
   */
  _cameraIndex() {
    return /-2\.png$/.test(this.pngPath || "") ? 2 : 1;
  }

  /** Report the ads currently on screen, one per ad_center element. */
  _noteImpressions(binding, now) {
    if (this._shadow) return;
    // An ad is only counted when somebody could actually have seen it. This is
    // billing data: counting the hours a box sits idle with an overlay
    // configured would inflate every venue's numbers.
    if (!this._streamLive) return;
    for (const el of (this._canvas && this._canvas.elements) || []) {
      if (el.visible === false || el.type !== "ad_center") continue;
      const ad = renderer.currentAd(el, binding, now);
      if (!ad) continue;
      ads.logImpression(ad, {
        venueId: ads.resolveAdVenueId(el, binding),
        // One throttle window per camera — the PNG path is what distinguishes
        // them (graphics-overlay.png vs -2.png) — and per element, so two ad
        // panels on one overlay are not mistaken for one.
        instance: `${this.pngPath}#${el.id}`,
        now,
        metadata: { camera: this._cameraIndex() },
      });
    }
  }

  /**
   * When to wake next: the earliest of the next data read and any frame the
   * canvas owes on its own (a carousel step, a clock minute). Animation and the
   * clock can pull the tick in without pulling a query in with it.
   */
  _nextDelay(now) {
    let next = this._nextFetchAt;
    if (this._nextAnimationAt && Number.isFinite(this._nextAnimationAt)) {
      next = Math.min(next, this._nextAnimationAt);
    }
    // An overlay with a single ad has nothing to animate, so without this the
    // ad list would only be re-read whenever something else happened to wake
    // the loop — which on an idle table with the watch connected is ten
    // minutes.
    if (this._hasAds && this._nextAdFetchAt) next = Math.min(next, this._nextAdFetchAt);
    // _lastDrawAt is 0 until the first frame, which is not a timestamp to
    // schedule against.
    if (this._hasClock && this._live && this._lastDrawAt) {
      next = Math.min(next, this._lastDrawAt + CLOCK_TICK_MS);
    }
    return next - now;
  }

  /**
   * Whether the files this producer is responsible for have gone missing. The
   * raw buffer is always written; the PNG only when no pipeline has claimed the
   * raw file, so it is only required in that case.
   */
  _outputMissing() {
    if (!this._canvas) return false;
    try {
      if (!fs.existsSync(`${this.pngPath}.bgra`)) return true;
      let claimed = false;
      try {
        claimed = Date.now() - fs.statSync(`${this.pngPath}.rawclaim`).mtimeMs < 10000;
      } catch { claimed = false; }
      if (!claimed && !fs.existsSync(this.pngPath)) return true;
    } catch {
      return false;   // a stat error is not evidence of anything
    }
    return false;
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
      // Which cadence this overlay is on, and why — the field check for the
      // idle backoff is "a box with no match says live:false".
      live: this._live,
      pollMs: this._live ? POLL_MS : (this._watchHealthy() ? 0 : IDLE_POLL_MS),
      lastMatchAt: this._lastMatchAt || null,
      // pollMs 0 with watching true means the idle poll is off entirely and the
      // subscription is carrying it.
      watching: this._watchHealthy(),
      watch: dataSource.watchStats(),
      ads: this._hasAds ? {
        counting: this._streamLive,
        venues: this._ads ? Object.keys(this._ads).map(Number) : [],
        counts: this._ads ? Object.fromEntries(Object.entries(this._ads).map(([k, v]) => [k, v.length])) : {},
        errors: this._adErrors,
        impressions: ads.impressionStats(),
      } : null,
      failures: this._failures,
      lastError: this._lastError,
      unsupported: this.unsupported,
      delaySeconds: this._delaySeconds,
      healthy: this.healthy,
    };
  }

  /**
   * Stop producing and remove what we produced.
   *
   * Deleting the files is the contract, not an afterthought: server.js turns an
   * overlay off by calling stop() on the producer, and the pipeline only stops
   * compositing once the file it is reading actually goes away. Leaving them
   * behind means unchecking "Remote Overlay" visibly does nothing — the last
   * frame stays burned into the stream indefinitely. puppeteerOverlay.stop()
   * unlinked its PNG for exactly this reason.
   *
   * Order matters: the loop stops, then the render thread is joined, and only
   * then do the files go — otherwise a render already in flight would write the
   * overlay back out after we deleted it.
   */
  async stop() {
    this._stopPeriodicRefresh();
    this.isRunning = false;
    // Impressions are buffered for ten seconds at a time; an overlay being
    // switched off should not throw away the last few.
    if (this._hasAds) ads.flushImpressions().catch(() => {});

    if (this._worker) {
      await this._worker.terminate().catch(() => {});
      this._worker = null;
    }

    for (const f of [this.pngPath, `${this.pngPath}.bgra`,
                     `${this.pngPath}.tmp`, `${this.pngPath}.bgra.tmp`]) {
      try {
        fs.unlinkSync(f);
        console.log(`🗑️  Deleted overlay file: ${f}`);
      } catch (e) { /* already gone */ }
    }

    this._images.clear();
    this._imageBytes.clear();
    this._workerHas.clear();
    return true;
  }
}

module.exports = SkiaOverlay;
module.exports.canHandle = canHandle;
